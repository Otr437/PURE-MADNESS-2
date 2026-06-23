/**
 * emailDraft tool — composes a structured operational briefing email
 * and saves it to the DB pending human approval.
 *
 * The draft is stored in the tasks table as a checkpoint with
 * status = "awaiting-human". The human approves it via the
 * existing POST /api/checkpoints/:id/approve endpoint, which then
 * triggers emailSend to dispatch it.
 *
 * Draft schema stored in task.result:
 *   { type: "email_draft", to, cc, subject, body, severity, source_task_id }
 *
 * Used by: threat-intel-agent, anomaly-detection-agent, incident-response-agent
 */

import { registerTool, type ToolResult } from "./index.js";
import { queries, logEntry }             from "../../db/index.js";
import { broadcast }                     from "../../websocket/index.js";
import { v4 as uuidv4 }                  from "uuid";

// ─── Severity → subject prefix map ───────────────────────────────────────────

const SEVERITY_PREFIX: Record<string, string> = {
  CRITICAL: "[CRITICAL]",
  HIGH:     "[HIGH]",
  MEDIUM:   "[MEDIUM]",
  LOW:      "[LOW]",
  INFO:     "[INFO]",
};

// ─── Tool registration ────────────────────────────────────────────────────────

registerTool({
  name:        "emailDraft",
  description: "Compose a structured security/operations briefing email and submit it for human approval before sending. The draft will appear in the Checkpoints panel for review. Use this as the final step after you have gathered all relevant findings.",
  parameters: {
    to:       { type: "string", description: "Recipient email address(es), comma-separated",                                                required: true },
    cc:       { type: "string", description: "CC email address(es), comma-separated (optional)" },
    subject:  { type: "string", description: "Email subject line (the severity prefix will be prepended automatically)",                    required: true },
    body:     { type: "string", description: "Full email body in plain text. Include: summary, affected systems, severity, recommended actions, references. Be specific and actionable.", required: true },
    severity: { type: "string", description: "Overall severity of this briefing: CRITICAL, HIGH, MEDIUM, LOW, INFO (default: HIGH)" },
  },

  async execute(args, taskId, agentId): Promise<ToolResult> {
    const to       = String(args.to      ?? "").trim();
    const cc       = String(args.cc      ?? "").trim();
    const subject  = String(args.subject ?? "").trim();
    const body     = String(args.body    ?? "").trim();
    const severity = String(args.severity ?? "HIGH").trim().toUpperCase();

    if (!to)      return { success: false, output: "", error: "to is required" };
    if (!subject) return { success: false, output: "", error: "subject is required" };
    if (!body)    return { success: false, output: "", error: "body is required" };

    // Validate email addresses
    const toList  = to.split(",").map(e => e.trim()).filter(Boolean);
    const ccList  = cc.split(",").map(e => e.trim()).filter(Boolean);
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    for (const addr of [...toList, ...ccList]) {
      if (!emailRe.test(addr)) {
        return { success: false, output: "", error: `Invalid email address: "${addr}"` };
      }
    }

    const prefix       = SEVERITY_PREFIX[severity] ?? "[INFO]";
    const fullSubject  = `${prefix} ${subject}`;
    const draftId      = uuidv4();
    const now          = new Date().toISOString();

    // Build the draft payload — stored as JSON in task.result
    const draftPayload = JSON.stringify({
      type:           "email_draft",
      draft_id:       draftId,
      to:             toList,
      cc:             ccList,
      subject:        fullSubject,
      body:           body,
      severity,
      source_task_id: taskId,
      agent_id:       agentId,
      created_at:     now,
    });

    // Insert a new task record as the approval checkpoint
    queries.insertTask.run(
      draftId,
      agentId  ?? null,
      null,              // no workflow
      `Email draft pending approval: ${fullSubject}`,
      "awaiting-human",
      1,                 // requires_approval = true
      "email_draft",
      3                  // high priority so it surfaces at the top
    );

    // Store the full draft payload in the result field immediately
    queries.updateTaskStatus.run(
      "awaiting-human",
      draftPayload,
      "awaiting-human",
      "awaiting-human",
      draftId
    );

    logEntry(
      taskId  ?? null,
      agentId ?? null,
      `Email draft created and awaiting approval — ID: ${draftId}, Subject: ${fullSubject}`,
      "warning",
      "task"
    );

    broadcast("TASK_UPDATED", {
      id:      draftId,
      status:  "awaiting-human",
      type:    "email_draft",
      subject: fullSubject,
      to:      toList,
    });

    return {
      success: true,
      output:  [
        `Email draft saved and submitted for human approval.`,
        `Draft ID: ${draftId}`,
        `To:       ${toList.join(", ")}`,
        `Subject:  ${fullSubject}`,
        `Severity: ${severity}`,
        ``,
        `A reviewer must approve this in the Checkpoints panel before it will be sent.`,
      ].join("\n"),
    };
  },
});
