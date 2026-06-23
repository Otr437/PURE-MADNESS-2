/**
 * Human-in-the-loop routes — approve or reject agent checkpoints.
 *
 * GET  /api/checkpoints            — all tasks awaiting human approval
 * POST /api/checkpoints/:id/approve — resume the task with an optional note
 * POST /api/checkpoints/:id/reject  — fail the task with a reason
 *
 * The ReAct loop sets task status to 'awaiting-human' when it hits a
 * human-in-loop node. The agent loop will not pick up 'awaiting-human'
 * tasks — they wait here until a human acts.
 *
 * Special case: tasks with task_type = 'email_draft' carry a full email
 * payload in their result field. Approving one triggers immediate dispatch
 * via SMTP rather than re-queuing the task for the agent loop.
 */

import { Router, Request, Response } from "express";
import { queries, logEntry }          from "../db/index.js";
import { authenticateToken }          from "../middleware/auth.js";
import { broadcast }                  from "../websocket/index.js";
import { sendEmail }                  from "../services/tools/emailSend.js";

const router = Router();
router.use(authenticateToken);

// GET /api/checkpoints
router.get("/", (_req: Request, res: Response) => {
  const pending = queries.getPendingCheckpoints.all() as any[];
  return res.json(pending);
});

// POST /api/checkpoints/:id/approve
router.post("/:id/approve", async (req: Request, res: Response) => {
  const task = queries.getTaskById.get(req.params.id) as any;
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (task.status !== "awaiting-human") {
    return res.status(400).json({ error: `Task is not awaiting human approval (status: ${task.status})` });
  }

  const approver = (req as any).user?.username ?? "unknown";

  // ── Email draft approval — dispatch the email immediately ─────────────────
  if (task.task_type === "email_draft") {
    let draft: any;
    try {
      draft = JSON.parse(task.result || "{}");
    } catch {
      return res.status(400).json({ error: "Email draft payload is corrupted and cannot be sent" });
    }

    if (!draft?.to || !draft?.subject || !draft?.body) {
      return res.status(400).json({ error: "Email draft is missing required fields (to, subject, body)" });
    }

    try {
      await sendEmail({
        to:      draft.to,
        cc:      draft.cc ?? [],
        subject: draft.subject,
        body:    draft.body,
        draftId: req.params.id,
        taskId:  draft.source_task_id ?? req.params.id,
        agentId: draft.agent_id ?? null,
      });

      logEntry(
        req.params.id, null,
        `Email draft approved by ${approver} and sent to ${draft.to.join(", ")}`,
        "success", "task"
      );

      return res.json({
        success: true,
        status:  "completed",
        sent_to: draft.to,
        subject: draft.subject,
      });

    } catch (err: any) {
      // Mark the task failed so it surfaces in the UI
      queries.updateTaskStatus.run("failed", err.message, "failed", "failed", req.params.id);
      logEntry(req.params.id, null, `Email send failed after approval: ${err.message}`, "error", "task");
      broadcast("TASK_UPDATED", { id: req.params.id, status: "failed", result: err.message });
      return res.status(502).json({ error: `Email could not be sent: ${err.message}` });
    }
  }

  // ── Standard workflow checkpoint approval ─────────────────────────────────
  const note = req.body.note || "Approved by human operator";
  queries.resumeCheckpoint.run(note, req.params.id);

  logEntry(req.params.id, null, `Checkpoint approved by ${approver}: ${note}`, "info", "task");
  broadcast("TASK_UPDATED", { id: req.params.id, status: "approved" });

  return res.json({ success: true, status: "approved" });
});

// POST /api/checkpoints/:id/reject
router.post("/:id/reject", (req: Request, res: Response) => {
  const task = queries.getTaskById.get(req.params.id) as any;
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (task.status !== "awaiting-human") {
    return res.status(400).json({ error: `Task is not awaiting human approval (status: ${task.status})` });
  }

  const reason = req.body.reason || "Rejected by human operator";
  queries.updateTaskStatus.run("failed", reason, "failed", "failed", req.params.id);

  logEntry(req.params.id, null, `Checkpoint rejected by ${(req as any).user?.username}: ${reason}`, "warning", "task");
  broadcast("TASK_UPDATED", { id: req.params.id, status: "failed", result: reason });

  return res.json({ success: true, status: "failed" });
});

export { router as checkpointsRouter };
