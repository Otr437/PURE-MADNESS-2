import { Router, Request, Response } from "express";
import { db, queries } from "../db/index.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();
router.use(authenticateToken);

// GET /api/logs  — recent 200 logs, optional ?type=error&category=agent&task_id=xxx
router.get("/", (req: Request, res: Response) => {
  const { type, category, task_id, limit = "200" } = req.query;

  let sql = "SELECT * FROM logs WHERE 1=1";
  const params: any[] = [];

  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }
  if (task_id) {
    sql += " AND task_id = ?";
    params.push(task_id);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(Math.min(parseInt(limit as string, 10) || 200, 1000));

  const logs = db.prepare(sql).all(...params);
  return res.json(logs);
});

// DELETE /api/logs/prune  — admin prune old logs based on retention setting
router.delete("/prune", (req: Request, res: Response) => {
  const retentionRow = queries.getSetting.get("LOG_RETENTION_DAYS") as any;
  const days = parseInt(retentionRow?.value || "30", 10);
  const info = queries.pruneOldLogs.run(days) as any;
  return res.json({ success: true, deleted: info.changes, retention_days: days });
});

export { router as logsRouter };
