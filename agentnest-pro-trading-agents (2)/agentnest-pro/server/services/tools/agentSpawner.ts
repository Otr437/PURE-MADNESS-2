/**
 * agentSpawner tool — the orchestrator-worker pattern.
 * An orchestrator agent calls this to delegate a sub-task to a specialist
 * agent. The spawner creates a real task in the DB, runs it inline via the
 * ReAct engine, and returns the result to the calling agent's observation.
 *
 * This enables hierarchical planning: supervisor → worker agents.
 */

import { v4 as uuidv4 }   from "uuid";
import { queries, logEntry } from "../../db/index.js";
import { registerTool, type ToolResult } from "./index.js";

// Lazy import to avoid circular dependency — reactLoop imports tools, tools import reactLoop
// We use a dynamic import inside execute() to break the circle.

registerTool({
  name:        "agentSpawner",
  description: "Delegate a sub-task to a specialist agent and wait for the result. Use when a task requires expertise outside your own specialty. Provide the agent_type and a precise task description.",
  parameters: {
    agent_type:  { type: "string", description: "The specialist agent type to spawn (e.g., 'security-expert', 'crypto-analyst', 'data-scientist')", required: true },
    description: { type: "string", description: "The exact task to give the specialist agent",                                                        required: true },
    priority:    { type: "number", description: "Task priority 1-3 (default 2 — higher than normal to ensure fast execution)" },
  },

  async execute(args, taskId, agentId): Promise<ToolResult> {
    const agentType   = String(args.agent_type   ?? "").trim();
    const description = String(args.description  ?? "").trim();

    if (!agentType)   return { success: false, output: "", error: "agent_type is required" };
    if (!description) return { success: false, output: "", error: "description is required" };

    // Find an agent of the requested type (prefer idle)
    const allAgents = queries.getAllAgents.all() as any[];
    const candidate = allAgents.find(a => a.agent_type === agentType && a.status === "idle")
                   ?? allAgents.find(a => a.agent_type === agentType);

    if (!candidate) {
      return {
        success: false,
        output:  "",
        error:   `No agent of type "${agentType}" found. Available types: ${[...new Set(allAgents.map(a => a.agent_type))].join(", ")}`,
      };
    }

    // Create a real sub-task in the DB (no approval required — spawned by an agent)
    const subTaskId = uuidv4();
    queries.insertTask.run(
      subTaskId,
      candidate.id,
      null,            // no workflow
      `[Spawned by agent] ${description}`,
      "pending",
      0,               // requires_approval = false
      "direct",
      Number(args.priority ?? 2)
    );

    logEntry(taskId, agentId, `Spawning ${agentType} agent for: "${description.substring(0, 80)}"`, "command", "agent");

    // Run inline via the ReAct engine — dynamic import breaks the circular dep
    try {
      const { runReActLoop } = await import("../reactLoop.js");
      const result = await runReActLoop(
        { id: subTaskId, description, agent_id: candidate.id, task_type: "direct" },
        candidate
      );
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: "", error: `Spawned agent failed: ${err.message}` };
    }
  },
});
