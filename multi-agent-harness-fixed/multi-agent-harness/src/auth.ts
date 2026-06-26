// src/auth.ts
// Session authentication — PIN-gated, TOTP-ready, HMAC-signed tokens.
//
// Rules:
//   - PIN never stored as string, always Buffer, zeroed after use
//   - Session tokens are HMAC-signed, expire after timeout
//   - Failed attempts trigger lockout with exponential backoff
//   - All auth events Merkle-logged for audit
//   - No plaintext secrets ever written to disk or logs

import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { CryptoVault, readPinSilent, zeroBuffer } from "./crypto-vault.js";
import { MerkleLog } from "./merkle-log.js";

const TOKEN_TTL_MS   = 30 * 60 * 1000;  // 30 min session
const MAX_ATTEMPTS   = 5;
const LOCKOUT_BASE   = 2_000;            // 2s base, doubles each fail

export interface Session {
  token: string;       // HMAC-signed opaque token
  expiresAt: number;   // epoch ms
  chain: string[];     // what this session is allowed to do
}

export class AuthManager {
  private vault:        CryptoVault;
  private log:          MerkleLog;
  private sessionKey:   Buffer;          // random per-process, never persisted
  private session:      Session | null = null;
  private attempts      = 0;
  private lockedUntil   = 0;

  constructor(vault: CryptoVault, log: MerkleLog) {
    this.vault      = vault;
    this.log        = log;
    this.sessionKey = randomBytes(32);   // random signing key, lives in process only
  }

  // ── Set up PIN for the first time ─────────────────────────────────────────
  async setupPin(): Promise<void> {
    const pin1 = await readPinSilent("Set bot PIN: ");
    const pin2 = await readPinSilent("Confirm PIN: ");

    if (!timingSafeEqual(pin1, pin2)) {
      zeroBuffer(pin1); zeroBuffer(pin2);
      throw new Error("PINs do not match.");
    }

    // Store a SHA-256 hash of the PIN — never the PIN itself.
    // The vault's AES-256-GCM + PBKDF2 encryption provides secrecy.
    // We intentionally do NOT use sessionKey here: it is random per-process
    // and would make the stored verifier unreadable after a restart.
    const verifier = createHash("sha256").update(pin1).digest("hex");

    this.vault.saveEncrypted("pin-verifier", verifier, pin1);
    zeroBuffer(pin1); zeroBuffer(pin2);

    this.log.append("auth:pin-setup", { ok: true }, { ok: true });
    console.log("[auth] PIN set.\n");
  }

  // ── Verify PIN and issue a session token ─────────────────────────────────
  async login(allowedOps: string[] = ["*"]): Promise<boolean> {
    const now = Date.now();

    // Lockout check
    if (now < this.lockedUntil) {
      const wait = Math.ceil((this.lockedUntil - now) / 1000);
      console.log(`[auth] Locked out. Try again in ${wait}s.`);
      return false;
    }

    if (!this.vault.has("pin-verifier")) {
      await this.setupPin();
    }

    const pin = await readPinSilent("Bot PIN: ");

    try {
      // Derive SHA-256 of the supplied PIN — must match what setupPin stored
      const supplied = createHash("sha256").update(pin).digest("hex");

      // Load stored verifier — decrypt needs the same PIN (vault uses PBKDF2)
      const stored = this.vault.loadDecrypted("pin-verifier", pin);

      const supBuf = Buffer.from(supplied, "utf8");
      const stoBuf = Buffer.from(stored,   "utf8");

      let valid = false;
      if (supBuf.length === stoBuf.length) {
        valid = timingSafeEqual(supBuf, stoBuf);
      }

      zeroBuffer(supBuf); zeroBuffer(stoBuf);

      if (!valid) {
        this.attempts++;
        const backoff = LOCKOUT_BASE * Math.pow(2, this.attempts - 1);
        this.lockedUntil = Date.now() + backoff;
        this.log.append("auth:fail", { attempts: this.attempts, backoffMs: backoff }, { ok: false });
        console.log(`[auth] Wrong PIN. Attempt ${this.attempts}/${MAX_ATTEMPTS}.`);

        if (this.attempts >= MAX_ATTEMPTS) {
          console.log("[auth] Too many failures. Exiting.");
          this.log.append("auth:lockout", {}, { ok: false });
          process.exit(1);
        }
        return false;
      }

      // Issue token
      this.attempts  = 0;
      this.lockedUntil = 0;
      const nonce    = randomBytes(16).toString("hex");
      const exp      = Date.now() + TOKEN_TTL_MS;
      const payload  = `${nonce}:${exp}:${allowedOps.join(",")}`;
      const sig      = createHmac("sha256", this.sessionKey).update(payload).digest("hex");

      this.session = { token: `${payload}.${sig}`, expiresAt: exp, chain: allowedOps };
      this.log.append("auth:login", { ops: allowedOps, exp: Temporal.Instant.fromEpochMilliseconds(exp).toString() }, { ok: true });
      console.log(`[auth] Authenticated. Session valid until ${Temporal.Instant.fromEpochMilliseconds(exp).toZonedDateTimeISO("UTC").toLocaleString()}\n`);
      return true;

    } finally {
      zeroBuffer(pin);
    }
  }

  // ── Verify current session is valid ──────────────────────────────────────
  check(op = "*"): boolean {
    if (!this.session) return false;

    const [payload, sig] = this.session.token.split(".");
    const expected = createHmac("sha256", this.sessionKey).update(payload).digest("hex");

    const sigBuf = Buffer.from(sig,      "hex");
    const expBuf = Buffer.from(expected, "hex");

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      this.log.append("auth:token-tampered", {}, { ok: false });
      this.session = null;
      return false;
    }

    if (Date.now() > this.session.expiresAt) {
      this.log.append("auth:expired", {}, { ok: false });
      this.session = null;
      console.log("[auth] Session expired. Re-authenticate with: auth login");
      return false;
    }

    const allowed = this.session.chain.includes("*") || this.session.chain.includes(op);
    if (!allowed) {
      this.log.append("auth:op-denied", { op }, { ok: false });
    }
    return allowed;
  }

  // ── Extend session if still valid ─────────────────────────────────────────
  extend() {
    if (this.check()) {
      this.session!.expiresAt = Date.now() + TOKEN_TTL_MS;
      this.log.append("auth:extend", { newExp: Temporal.Instant.fromEpochMilliseconds(this.session!.expiresAt).toString() }, { ok: true });
    }
  }

  // ── Logout ────────────────────────────────────────────────────────────────
  logout() {
    this.session = null;
    this.log.append("auth:logout", {}, { ok: true });
    console.log("[auth] Logged out.");
  }

  get isAuthenticated(): boolean {
    return this.check();
  }

  // ── Clean up session key on exit ──────────────────────────────────────────
  destroy() {
    zeroBuffer(this.sessionKey);
    this.session = null;
  }
}
