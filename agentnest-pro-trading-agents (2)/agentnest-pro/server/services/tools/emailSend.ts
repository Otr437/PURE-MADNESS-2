/**
 * emailSend tool — dispatches an approved email draft via SMTP.
 *
 * This tool is NOT called by agents directly during the ReAct loop.
 * It is called by the checkpoint approval handler in
 * server/routes/checkpoints.ts once a human approves a draft created
 * by the emailDraft tool.
 *
 * It can also be called as a tool by an agent in scenarios where
 * the agent has been explicitly granted auto-send capability — but
 * the default specialties do NOT include it in their allowedTools list.
 * Only add "emailSend" to an agent's allowedTools if you intentionally
 * want fully automated outbound email with no human gate.
 *
 * SMTP config from Settings keys:
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE (true/false), SMTP_USER, SMTP_PASSWORD
 *   EMAIL_FROM  — the From address (e.g. "AgentNest SOC <soc@yourcompany.com>")
 *
 * Uses nodemailer. Run: npm install nodemailer @types/nodemailer
 */

import nodemailer                        from "nodemailer";
import { registerTool, type ToolResult } from "./index.js";
import { queries, logEntry }             from "../../db/index.js";
import { broadcast }                     from "../../websocket/index.js";
import { safeDecryptSetting }            from "../crypto.js";

// ─── Config ───────────────────────────────────────────────────────────────────

function getSetting(key: string): string {
  const row = queries.getSetting.get(key) as any;
  if (!row?.value) return process.env[key] ?? "";
  return safeDecryptSetting(row.value, row.is_secret);
}

function buildTransport(): nodemailer.Transporter {
  const host     = getSetting("SMTP_HOST");
  const port     = parseInt(getSetting("SMTP_PORT") || "587", 10);
  const secure   = getSetting("SMTP_SECURE") === "true";  // true = port 465
  const user     = getSetting("SMTP_USER");
  const password = getSetting("SMTP_PASSWORD");

  if (!host) throw new Error("SMTP_HOST is not configured in Settings");
  if (!user) throw new Error("SMTP_USER is not configured in Settings");
  if (!password) throw new Error("SMTP_PASSWORD is not configured in Settings");

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: password },
    // Reasonable timeouts so a hung SMTP server doesn't stall the agent loop
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     15_000,
  });
}

// ─── Core send function (exported for use by checkpoints route) ───────────────

export interface SendEmailOptions {
  to:      string[];
  cc?:     string[];
  subject: string;
  body:    string;
  draftId: string;
  taskId:  string | null;
  agentId: string | null;
}

export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const from = getSetting("EMAIL_FROM") || getSetting("SMTP_USER");
  if (!from) throw new Error("EMAIL_FROM (or SMTP_USER) is not configured in Settings");

  const transport = buildTransport();

  await transport.sendMail({
    from,
    to:      opts.to.join(", "),
    cc:      opts.cc && opts.cc.length > 0 ? opts.cc.join(", ") : undefined,
    subject: opts.subject,
    text:    opts.body,
    // Plain-text only — no HTML. Operational briefings should be readable
    // in any mail client, including terminal pagers and mobile clients.
  });

  // Mark the draft task as completed
  queries.updateTaskStatus.run(
    "completed",
    JSON.stringify({ sent_at: new Date().toISOString(), to: opts.to }),
    "completed",
    "completed",
    opts.draftId
  );

  logEntry(
    opts.taskId,
    opts.agentId,
    `Email sent successfully — Subject: "${opts.subject}" → ${opts.to.join(", ")}`,
    "success",
    "task"
  );

  broadcast("TASK_UPDATED", {
    id:     opts.draftId,
    status: "completed",
    type:   "email_draft",
  });
}

// ─── Tool registration ────────────────────────────────────────────────────────
// NOTE: This tool is intentionally NOT in the default allowedTools list for
// any specialty. Add it only to agents that should auto-send without review.

registerTool({
  name:        "emailSend",
  description: "Send an email directly without human review. Only use this tool if you have been explicitly authorized for auto-send. For most cases, use emailDraft instead and let a human approve it first.",
  parameters: {
    to:      { type: "string", description: "Recipient email(s), comma-separated", required: true },
    cc:      { type: "string", description: "CC email(s), comma-separated (optional)" },
    subject: { type: "string", description: "Email subject line",                   required: true },
    body:    { type: "string", description: "Full email body in plain text",         required: true },
  },

  async execute(args, taskId, agentId): Promise<ToolResult> {
    const to      = String(args.to      ?? "").trim();
    const cc      = String(args.cc      ?? "").trim();
    const subject = String(args.subject ?? "").trim();
    const body    = String(args.body    ?? "").trim();

    if (!to)      return { success: false, output: "", error: "to is required" };
    if (!subject) return { success: false, output: "", error: "subject is required" };
    if (!body)    return { success: false, output: "", error: "body is required" };

    const toList = to.split(",").map(e => e.trim()).filter(Boolean);
    const ccList = cc.split(",").map(e => e.trim()).filter(Boolean);

    try {
      await sendEmail({
        to:      toList,
        cc:      ccList,
        subject,
        body,
        draftId: uuidv4_local(),
        taskId:  taskId ?? null,
        agentId: agentId ?? null,
      });

      return {
        success: true,
        output:  `Email sent to ${toList.join(", ")} — Subject: "${subject}"`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: `emailSend failed: ${err.message}` };
    }
  },
});

// Local uuid helper to avoid circular imports
function uuidv4_local(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
