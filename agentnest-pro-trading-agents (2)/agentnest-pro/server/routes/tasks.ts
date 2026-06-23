import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { queries, logEntry } from "../db/index.js";
import { authenticateToken } from "../middleware/auth.js";
import { broadcast } from "../websocket/index.js";

const router = Router();
router.use(authenticateToken);

// GET /api/tasks
router.get("/", (_req: Request, res: Response) => {
  const tasks = queries.getRecentTasks.all() as any[];
  const taskIds = tasks.map((t: any) => t.id);
  const subTaskMap: Record<string, any[]> = {};
  for (const tid of taskIds) {
    subTaskMap[tid] = queries.getSubTasksByTask.all(tid) as any[];
  }
  return res.json(tasks.map((t: any) => ({ ...t, sub_tasks: subTaskMap[t.id] || [] })));
});

// GET /api/tasks/:id
router.get("/:id", (req: Request, res: Response) => {
  const task = queries.getTaskById.get(String(req.params.id)) as any;
  if (!task) return res.status(404).json({ error: "Task not found" });
  const subTasks = queries.getSubTasksByTask.all(task.id) as any[];
  const logs = queries.getLogsByTask.all(task.id) as any[];
  return res.json({ ...task, sub_tasks: subTasks, logs });
});

// POST /api/tasks
router.post("/", (req: Request, res: Response) => {
  const {
    agent_id,
    workflow_id,
    description,
    requires_approval = true,
    task_type = "direct",
    priority = 1,
  } = req.body;

  if (!description) return res.status(400).json({ error: "description is required" });

  const id = uuidv4();
  queries.insertTask.run(
    id, agent_id || null, workflow_id || null,
    description, "pending",
    requires_approval ? 1 : 0,
    task_type, priority
  );

  const task = queries.getTaskById.get(id) as any;
  logEntry(id, agent_id || null, `Task created: "${description.substring(0, 80)}"`, "info", "task");
  broadcast("TASK_CREATED", task);
  return res.status(201).json(task);
});

// POST /api/tasks/:id/approve
router.post("/:id/approve", (req: Request, res: Response) => {
  const task = queries.getTaskById.get(String(req.params.id)) as any;
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (task.status !== "pending") {
    return res.status(400).json({ error: `Cannot approve task with status: ${task.status}` });
  }

  queries.approveTask.run(String(req.params.id));
  logEntry(String(req.params.id), null, `Task approved by ${req.user?.username}`, "info", "task");
  broadcast("TASK_UPDATED", { id: String(req.params.id), status: "approved" });
  return res.json({ success: true, status: "approved" });
});

// POST /api/tasks/:id/cancel
router.post("/:id/cancel", (req: Request, res: Response) => {
  const task = queries.getTaskById.get(String(req.params.id)) as any;
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (["completed", "failed"].includes(task.status)) {
    return res.status(400).json({ error: "Cannot cancel a finished task" });
  }

  queries.updateTaskStatus.run("failed", "Cancelled by user", "failed", "failed", String(req.params.id));
  logEntry(String(req.params.id), null, `Task cancelled by ${req.user?.username}`, "warning", "task");
  broadcast("TASK_UPDATED", { id: String(req.params.id), status: "failed", result: "Cancelled by user" });
  return res.json({ success: true });
});

// GET /api/tasks/:id/logs
router.get("/:id/logs", (req: Request, res: Response) => {
  const logs = queries.getLogsByTask.all(String(req.params.id)) as any[];
  return res.json(logs);
});

// GET /api/tasks/:id/subtasks
router.get("/:id/subtasks", (req: Request, res: Response) => {
  const subTasks = queries.getSubTasksByTask.all(String(req.params.id)) as any[];
  return res.json(subTasks);
});

export { router as tasksRouter };
