import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, queries, logEntry } from "../db/index.js";
import { authenticateToken } from "../middleware/auth.js";
import { broadcast, sanitizeAgent } from "../websocket/index.js";
import { AGENT_DEFINITIONS }  from "../../src/types/agents.js";
import { getAgentDefinition, buildSystemPrompt, getToolsForAgentType, getAllAgentTypes } from "../services/agentDefinitions.js";

const router = Router();
router.use(authenticateToken);

// ─── AGENTS ──────────────────────────────────────────────────────────────────

// GET /api/agents/types — all 25 available agent type definitions (for UI agent picker)
router.get("/types", (_req: Request, res: Response) => {
  return res.json(getAllAgentTypes());
});

// GET /api/agents
router.get("/", (_req: Request, res: Response) => {
  const agents = (queries.getAllAgents.all() as any[]).map(sanitizeAgent);
  return res.json(agents);
});

// GET /api/agents/:id
router.get("/:id", (req: Request, res: Response) => {
  const agent = queries.getAgentById.get(req.params.id) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  return res.json(sanitizeAgent(agent));
});

// POST /api/agents
router.post("/", (req: Request, res: Response) => {
  const { name, model, provider = "anthropic", agent_type = "general-assistant", system_prompt, capabilities, environment, color, team_id } = req.body;

  if (!name || !model) {
    return res.status(400).json({ error: "name and model are required" });
  }

  const definition = AGENT_DEFINITIONS[agent_type as keyof typeof AGENT_DEFINITIONS];
  // Build system prompt from the full 25-agent definition library
  const resolvedPrompt = buildSystemPrompt(agent_type, system_prompt);

  // Merge capability list with the definition's allowed tool set
  const baseCaps     = capabilities || [];
  const resolvedCaps = Array.from(new Set([...baseCaps, ...getToolsForAgentType(agent_type)]));

  const resolvedEnv   = environment || definition?.defaultEnvironment || "office-desk";
  const resolvedColor = color || definition?.color || "#10B981";

  const id = uuidv4();
  queries.insertAgent.run(
    id, name, model, provider, agent_type,
    resolvedPrompt,
    JSON.stringify(resolvedCaps),
    resolvedEnv, "idle", resolvedColor,
    team_id || null
  );

  const agent = sanitizeAgent(queries.getAgentById.get(id) as any);
  logEntry(null, id, `Agent "${name}" created (${provider}/${model})`, "info", "system");
  broadcast("AGENT_CREATED", agent);
  return res.status(201).json(agent);
});

// PATCH /api/agents/:id
router.patch("/:id", (req: Request, res: Response) => {
  const agent = queries.getAgentById.get(req.params.id) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const allowed = ["name", "model", "provider", "agent_type", "system_prompt", "capabilities", "environment", "color", "team_id", "status"];
  const updates: string[] = [];
  const values: any[] = [];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(key === "capabilities" ? JSON.stringify(req.body[key]) : req.body[key]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: "No valid fields to update" });

  values.push(req.params.id);
  db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  const updated = sanitizeAgent(queries.getAgentById.get(req.params.id) as any);
  broadcast("AGENT_UPDATED", updated);
  return res.json(updated);
});

// DELETE /api/agents/:id
router.delete("/:id", (req: Request, res: Response) => {
  const agent = queries.getAgentById.get(req.params.id) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  queries.deleteAgent.run(req.params.id);
  logEntry(null, null, `Agent "${agent.name}" deleted`, "warning", "system");
  broadcast("AGENT_DELETED", { id: req.params.id });
  return res.json({ success: true });
});

// ─── TEAMS ───────────────────────────────────────────────────────────────────

// GET /api/agents/teams/all
router.get("/teams/all", (_req: Request, res: Response) => {
  const teams = queries.getAllTeams.all() as any[];
  const enriched = teams.map(team => ({
    ...team,
    agents: (queries.getAgentsByTeam.all(team.id) as any[]).map(sanitizeAgent),
  }));
  return res.json(enriched);
});

// POST /api/agents/teams
router.post("/teams", (req: Request, res: Response) => {
  const { name, description, workflow_mode = "sequential", leader_agent_id, agent_ids = [] } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const id = uuidv4();
  queries.insertTeam.run(id, name, description || null, workflow_mode, leader_agent_id || null);

  // Assign agents to team
  if (agent_ids.length > 0) {
    const assign = db.prepare("UPDATE agents SET team_id = ? WHERE id = ?");
    const assignAll = db.transaction((ids: string[]) => {
      for (const aid of ids) assign.run(id, aid);
    });
    assignAll(agent_ids);
  }

  const team = queries.getTeamById.get(id) as any;
  const enriched = {
    ...team,
    agents: (queries.getAgentsByTeam.all(id) as any[]).map(sanitizeAgent),
  };

  logEntry(null, null, `Team "${name}" created with ${agent_ids.length} agents`, "info", "system");
  broadcast("TEAM_CREATED", enriched);
  return res.status(201).json(enriched);
});

// DELETE /api/agents/teams/:id
router.delete("/teams/:id", (req: Request, res: Response) => {
  const team = queries.getTeamById.get(req.params.id) as any;
  if (!team) return res.status(404).json({ error: "Team not found" });

  // Unassign agents
  db.prepare("UPDATE agents SET team_id = NULL WHERE team_id = ?").run(req.params.id);
  queries.deleteTeam.run(req.params.id);
  broadcast("TEAM_DELETED", { id: req.params.id });
  return res.json({ success: true });
});

export { router as agentsRouter };
