/**
 * Memory routes — expose episodic and long-term memory for the UI and external tools.
 *
 * GET  /api/memory/episodic/:taskId          — full decision log for one task
 * GET  /api/memory/episodic/agent/:agentId   — recent decisions by an agent
 * GET  /api/memory/longterm/:agentId         — all long-term memories for an agent
 * DELETE /api/memory/longterm/:agentId       — clear all long-term memories (agent reset)
 */

import { Router, Request, Response } from "express";
import { queries, logEntry }          from "../db/index.js";
import { authenticateToken }          from "../middleware/auth.js";

const router = Router();
router.use(authenticateToken);

// ─── Episodic ─────────────────────────────────────────────────────────────────

router.get("/episodic/:taskId", (req: Request, res: Response) => {
  const rows = queries.getEpisodicByTask.all(req.params.taskId) as any[];
  return res.json(rows);
});

router.get("/episodic/agent/:agentId", (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
  const rows  = queries.getEpisodicByAgent.all(req.params.agentId, limit) as any[];
  return res.json(rows);
});

// ─── Long-term ────────────────────────────────────────────────────────────────

router.get("/longterm/:agentId", (req: Request, res: Response) => {
  const rows = queries.getLongTermByAgent.all(req.params.agentId) as any[];
  return res.json(rows);
});

router.delete("/longterm/:agentId", (req: Request, res: Response) => {
  queries.deleteLongTermByAgent.run(req.params.agentId);
  logEntry(null, req.params.agentId, `Long-term memory cleared by ${(req as any).user?.username}`, "warning", "agent");
  return res.json({ success: true });
});

export { router as memoryRouter };
