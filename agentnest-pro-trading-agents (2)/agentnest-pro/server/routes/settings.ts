import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, queries, logEntry } from "../db/index.js";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";
import { broadcast, sanitizeAccount, sanitizeSetting } from "../websocket/index.js";
import { encrypt, decrypt, mask, safeDecryptSetting } from "../services/crypto.js";

const router = Router();
router.use(authenticateToken);

// ─── SETTINGS ────────────────────────────────────────────────────────────────

// GET /api/settings  — secrets are always masked, never sent in plaintext
router.get("/", (_req: Request, res: Response) => {
  const rows = (queries.getAllSettings.all() as any[]).map(sanitizeSetting);
  return res.json(rows);
});

// GET /api/settings/:key  — admin can read one setting (masked if secret)
router.get("/:key", requireAdmin, (req: Request, res: Response) => {
  const row = queries.getSetting.get(String(req.params.key)) as any;
  if (!row) return res.status(404).json({ error: "Setting not found" });
  return res.json(sanitizeSetting(row));
});

// PUT /api/settings/:key  — create or update a setting, admin only
router.put("/:key", requireAdmin, (req: Request, res: Response) => {
  const { value, is_secret = false, description } = req.body;

  if (value === undefined) {
    return res.status(400).json({ error: "value is required" });
  }

  // Encrypt if secret and value is non-empty
  const storedValue = (is_secret && value !== "") ? encrypt(value) : value;

  queries.upsertSetting.run(
    String(req.params.key),
    storedValue,
    is_secret ? 1 : 0,
    description || null
  );

  const saved = queries.getSetting.get(String(req.params.key)) as any;
  const sanitized = sanitizeSetting(saved);

  logEntry(null, null, `Setting "${String(req.params.key)}" updated by ${req.user?.username}`, "info", "system");
  broadcast("SETTING_UPDATED", sanitized);
  return res.json(sanitized);
});

// DELETE /api/settings/:key  — admin only
router.delete("/:key", requireAdmin, (req: Request, res: Response) => {
  const row = queries.getSetting.get(String(req.params.key)) as any;
  if (!row) return res.status(404).json({ error: "Setting not found" });

  // Block deletion of core system settings
  const protected_keys = ["SYSTEM_NAME", "MAX_CONCURRENT_TASKS", "AGENT_LOOP_MS", "LOG_RETENTION_DAYS"];
  if (protected_keys.includes(String(req.params.key))) {
    return res.status(400).json({ error: "Cannot delete a protected system setting" });
  }

  db.prepare("DELETE FROM settings WHERE key = ?").run(String(req.params.key));
  broadcast("SETTING_DELETED", { key: String(req.params.key) });
  return res.json({ success: true });
});

// ─── FINANCIAL ACCOUNTS VAULT ─────────────────────────────────────────────────

// GET /api/settings/financials/accounts  — addresses/keys are always masked
router.get("/financials/accounts", (_req: Request, res: Response) => {
  const accounts = (queries.getAllAccounts.all() as any[]).map(sanitizeAccount);
  return res.json(accounts);
});

// POST /api/settings/financials/accounts  — store encrypted
router.post("/financials/accounts", (req: Request, res: Response) => {
  const {
    type,
    name,
    address_or_id,
    spend_key,
    view_key,
    balance = "0.00",
    currency = "USD",
  } = req.body;

  if (!type || !name || !address_or_id) {
    return res.status(400).json({ error: "type, name, and address_or_id are required" });
  }

  const validTypes = ["wallet", "bank", "xmr"];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(", ")}` });
  }

  // Encrypt all sensitive fields at rest
  const encryptedAddress  = encrypt(address_or_id);
  const encryptedSpendKey = spend_key ? encrypt(spend_key) : null;
  const encryptedViewKey  = view_key  ? encrypt(view_key)  : null;

  const id = uuidv4();
  queries.insertAccount.run(
    id, type, name,
    encryptedAddress,
    encryptedSpendKey,
    encryptedViewKey,
    balance,
    currency
  );

  // Return the masked version — raw keys never leave the server
  const account = queries.getAllAccounts.all().find((a: any) => a.id === id) as any;
  const masked = sanitizeAccount(account);

  logEntry(null, null, `Financial account "${name}" (${type}) added by ${req.user?.username}`, "info", "finance");
  broadcast("ACCOUNT_ADDED", masked);
  return res.status(201).json(masked);
});

// DELETE /api/settings/financials/accounts/:id
router.delete("/financials/accounts/:id", requireAdmin, (req: Request, res: Response) => {
  const accounts = queries.getAllAccounts.all() as any[];
  const account  = accounts.find((a: any) => a.id === String(req.params.id));

  if (!account) return res.status(404).json({ error: "Account not found" });

  queries.deleteAccount.run(String(req.params.id));
  logEntry(null, null, `Financial account "${account.name}" deleted by ${req.user?.username}`, "warning", "finance");
  broadcast("ACCOUNT_DELETED", { id: String(req.params.id) });
  return res.json({ success: true });
});

// POST /api/settings/financials/accounts/:id/decrypt  — admin only, returns real values for agent use ONLY (never logged)
router.post("/financials/accounts/:id/decrypt", requireAdmin, (req: Request, res: Response) => {
  const accounts = queries.getAllAccounts.all() as any[];
  const account  = accounts.find((a: any) => a.id === String(req.params.id));

  if (!account) return res.status(404).json({ error: "Account not found" });

  // This endpoint exists solely so the agent loop can retrieve keys server-side
  // Response is NEVER broadcast over WebSocket
  const decrypted = {
    id:            account.id,
    type:          account.type,
    name:          account.name,
    address_or_id: decrypt(account.address_or_id),
    spend_key:     account.spend_key ? decrypt(account.spend_key) : null,
    view_key:      account.view_key  ? decrypt(account.view_key)  : null,
    balance:       account.balance,
    currency:      account.currency,
  };

  // Audit log — note access but not the values
  logEntry(null, null, `Account "${account.name}" decrypted by ${req.user?.username} for agent use`, "warning", "security");

  return res.json(decrypted);
});

export { router as settingsRouter };
