import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, queries, logEntry } from "../db/index.js";
import { authenticateToken } from "../middleware/auth.js";
import { broadcast } from "../websocket/index.js";

const router = Router();
router.use(authenticateToken);

// GET /api/workflows
router.get("/", (_req: Request, res: Response) => {
  const workflows = queries.getAllWorkflows.all() as any[];
  return res.json(workflows);
});

// GET /api/workflows/:id
router.get("/:id", (req: Request, res: Response) => {
  const wf = queries.getWorkflowById.get(req.params.id) as any;
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  return res.json({
    ...wf,
    nodes: safeJSON(wf.nodes, []),
    connections: safeJSON(wf.connections, []),
    variables: safeJSON(wf.variables, {}),
  });
});

// POST /api/workflows
router.post("/", (req: Request, res: Response) => {
  const { name, description, nodes = [], connections = [], variables = {}, status = "draft" } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const id = uuidv4();
  queries.insertWorkflow.run(
    id, name, description || null,
    JSON.stringify(nodes),
    JSON.stringify(connections),
    JSON.stringify(variables),
    status
  );

  const wf = queries.getWorkflowById.get(id) as any;
  const response = {
    ...wf,
    nodes: safeJSON(wf.nodes, []),
    connections: safeJSON(wf.connections, []),
    variables: safeJSON(wf.variables, {}),
  };

  logEntry(null, null, `Workflow "${name}" created`, "info", "system");
  broadcast("WORKFLOW_CREATED", response);
  return res.status(201).json(response);
});

// PUT /api/workflows/:id
router.put("/:id", (req: Request, res: Response) => {
  const wf = queries.getWorkflowById.get(req.params.id) as any;
  if (!wf) return res.status(404).json({ error: "Workflow not found" });

  const { name, description, nodes, connections, variables, status } = req.body;

  queries.updateWorkflow.run(
    name ?? wf.name,
    description ?? wf.description,
    nodes !== undefined ? JSON.stringify(nodes) : wf.nodes,
    connections !== undefined ? JSON.stringify(connections) : wf.connections,
    variables !== undefined ? JSON.stringify(variables) : wf.variables,
    status ?? wf.status,
    req.params.id
  );

  const updated = queries.getWorkflowById.get(req.params.id) as any;
  const response = {
    ...updated,
    nodes: safeJSON(updated.nodes, []),
    connections: safeJSON(updated.connections, []),
    variables: safeJSON(updated.variables, {}),
  };

  broadcast("WORKFLOW_UPDATED", response);
  return res.json(response);
});

// DELETE /api/workflows/:id
router.delete("/:id", (req: Request, res: Response) => {
  const wf = queries.getWorkflowById.get(req.params.id) as any;
  if (!wf) return res.status(404).json({ error: "Workflow not found" });

  queries.deleteWorkflow.run(req.params.id);
  broadcast("WORKFLOW_DELETED", { id: req.params.id });
  return res.json({ success: true });
});

// POST /api/workflows/:id/execute  — creates a task from this workflow
router.post("/:id/execute", (req: Request, res: Response) => {
  const wf = queries.getWorkflowById.get(req.params.id) as any;
  if (!wf) return res.status(404).json({ error: "Workflow not found" });

  const { variables = {}, requires_approval = false } = req.body;

  // Merge runtime variables into the workflow
  const mergedVars = { ...safeJSON(wf.variables, {}), ...variables };

  const taskId = uuidv4();
  queries.insertTask.run(
    taskId, null, req.params.id,
    `Execute workflow: ${wf.name}`,
    "pending",
    requires_approval ? 1 : 0,
    "workflow",
    1
  );

  // Store merged variables as a setting-like kv on the task (stored in result field temporarily)
  db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(JSON.stringify({ variables: mergedVars }), taskId);

  const task = queries.getTaskById.get(taskId) as any;
  logEntry(taskId, null, `Workflow "${wf.name}" execution queued`, "info", "task");
  broadcast("TASK_CREATED", task);
  return res.status(201).json(task);
});

function safeJSON(val: any, fallback: any) {
  if (!val) return fallback;
  try { return typeof val === "string" ? JSON.parse(val) : val; }
  catch { return fallback; }
}

export { router as workflowsRouter };
