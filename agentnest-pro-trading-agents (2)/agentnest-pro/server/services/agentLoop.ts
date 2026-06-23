import { v4 as uuidv4 } from "uuid";
import { db, queries, logEntry } from "../db/index.js";
import { callAI, callGeminiWithTools } from "./ai.js";
import { runReActLoop } from "./reactLoop.js";
import { broadcast } from "../websocket/index.js";
import { decrypt } from "./crypto.js";

let loopTimer: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export function startAgentLoop() {
  const intervalMs = parseInt(
    (queries.getSetting.get("AGENT_LOOP_MS") as any)?.value || "5000",
    10
  );
  loopTimer = setInterval(tick, intervalMs);
  console.log(`[AgentLoop] Started — polling every ${intervalMs}ms`);
}

export function stopAgentLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
    console.log("[AgentLoop] Stopped");
  }
}

// ─── TICK ─────────────────────────────────────────────────────────────────────

async function tick() {
  if (isProcessing) return; // Never overlap runs
  isProcessing = true;

  try {
    const maxConcurrent = parseInt(
      (queries.getSetting.get("MAX_CONCURRENT_TASKS") as any)?.value || "5",
      10
    );

    const pending = queries.getPendingTasks.all(maxConcurrent) as any[];

    for (const task of pending) {
      // Mark running immediately so next tick won't pick it up again
      queries.updateTaskStatus.run("running", null, "running", "running", task.id);
      broadcast("TASK_UPDATED", { id: task.id, status: "running" });
      logEntry(task.id, task.agent_id, "Task picked up by agent loop", "info", "task");

      // Fire and forget — errors handled inside processTask
      processTask(task).catch((err) => {
        console.error(`[AgentLoop] Unhandled error in task ${task.id}:`, err);
      });
    }
  } catch (err: any) {
    console.error("[AgentLoop] Tick error:", err.message);
  } finally {
    isProcessing = false;
  }
}

// ─── PROCESS ONE TASK ─────────────────────────────────────────────────────────

async function processTask(task: any) {
  const agent = task.agent_id ? (queries.getAgentById.get(task.agent_id) as any) : null;

  // If it's a workflow task, route it differently
  if (task.task_type === "workflow" && task.workflow_id) {
    return processWorkflowTask(task, agent);
  }

  // Direct agent task
  return processDirectTask(task, agent);
}

// ─── DIRECT AGENT TASK ────────────────────────────────────────────────────────

async function processDirectTask(task: any, agent: any | null) {
  try {
    logEntry(task.id, agent?.id || null, `Executing: "${task.description}"`, "command", "agent");

    // ── ReAct loop — think → act → observe → repeat ──────────────────────────
    // Append financial account context to task description when relevant
    let taskDescription = task.description;
    if (/transaction|transfer|wallet|balance|crypto|xmr|eth|btc/i.test(task.description)) {
      const accounts = queries.getAllAccounts.all() as any[];
      if (accounts.length > 0) {
        taskDescription += `\n\nAvailable financial accounts (${accounts.length} linked): ${accounts.map((a: any) => `${a.name} (${a.type}, ${a.currency})`).join(", ")}.`;
      }
    }

    const enrichedTask = { ...task, description: taskDescription };

    // Track the ReAct execution as a visible sub-task in the UI
    const subId = uuidv4();
    queries.insertSubTask.run(subId, task.id, "ReAct loop executing", "running");
    broadcast("SUB_TASK_CREATED", { id: subId, task_id: task.id, description: "ReAct loop executing", status: "running" });

    const response = await runReActLoop(enrichedTask, agent);

    queries.updateSubTask.run("completed", response.substring(0, 500), subId);
    broadcast("SUB_TASK_UPDATED", { id: subId, status: "completed", result: response.substring(0, 500) });

    // Mark task complete
    queries.updateTaskStatus.run("completed", response, "completed", "completed", task.id);
    broadcast("TASK_UPDATED", { id: task.id, status: "completed", result: response });
    logEntry(task.id, agent?.id || null, `Task completed successfully`, "info", "task");

    // Update agent back to idle
    if (agent?.id) {
      queries.updateAgentStatus.run("idle", agent.id);
      broadcast("AGENT_UPDATED", { id: agent.id, status: "idle" });
    }

  } catch (err: any) {
    const errMsg = err.message || "Unknown error";
    queries.updateTaskStatus.run("failed", errMsg, "failed", "failed", task.id);
    broadcast("TASK_UPDATED", { id: task.id, status: "failed", result: errMsg });
    logEntry(task.id, agent?.id || null, `Task failed: ${errMsg}`, "error", "task");

    if (agent?.id) {
      queries.updateAgentStatus.run("idle", agent.id);
      broadcast("AGENT_UPDATED", { id: agent.id, status: "idle" });
    }
  }
}

// ─── WORKFLOW TASK ────────────────────────────────────────────────────────────

async function processWorkflowTask(task: any, _agent: any | null) {
  try {
    const workflow = queries.getWorkflowById.get(task.workflow_id) as any;
    if (!workflow) throw new Error(`Workflow ${task.workflow_id} not found`);

    const nodes       = safeJSON(workflow.nodes, []);
    const connections = safeJSON(workflow.connections, []);
    let   variables   = safeJSON(workflow.variables, {});

    // Merge any runtime variables stored in task result field
    try {
      const rt = JSON.parse(task.result || "{}");
      if (rt.variables) variables = { ...variables, ...rt.variables };
    } catch { /* no runtime vars */ }

    logEntry(task.id, null, `Executing workflow "${workflow.name}" (${nodes.length} nodes)`, "command", "task");

    // Find start node
    const startNode = nodes.find((n: any) => n.data?.isStart);
    if (!startNode) throw new Error("Workflow has no start node");

    const executionResults: Record<string, any> = { ...variables };

    await executeWorkflowNode(startNode, nodes, connections, executionResults, task.id);

    const summary = `Workflow "${workflow.name}" completed. ${nodes.length} nodes executed.`;
    queries.updateTaskStatus.run("completed", summary, "completed", "completed", task.id);
    broadcast("TASK_UPDATED", { id: task.id, status: "completed", result: summary });
    logEntry(task.id, null, summary, "info", "task");

  } catch (err: any) {
    const errMsg = err.message || "Unknown error";
    queries.updateTaskStatus.run("failed", errMsg, "failed", "failed", task.id);
    broadcast("TASK_UPDATED", { id: task.id, status: "failed", result: errMsg });
    logEntry(task.id, null, `Workflow failed: ${errMsg}`, "error", "task");
  }
}

async function executeWorkflowNode(
  node: any,
  allNodes: any[],
  connections: any[],
  variables: Record<string, any>,
  taskId: string
): Promise<any> {

  logEntry(taskId, null, `Node "${node.label}" (${node.type}) executing`, "info", "task");

  const subId = uuidv4();
  queries.insertSubTask.run(subId, taskId, `Node: ${node.label}`, "running");
  broadcast("SUB_TASK_CREATED", { id: subId, task_id: taskId, description: `Node: ${node.label}`, status: "running" });

  let result: any = null;

  try {
    switch (node.type) {
      case "data":
        result = node.data;
        break;

      case "agent": {
        const agent = node.agentId ? (queries.getAgentById.get(node.agentId) as any) : null;
        if (!agent) throw new Error(`Agent ${node.agentId} not found`);

        const contextStr = Object.keys(variables).length > 0
          ? `\n\nContext from previous steps:\n${JSON.stringify(variables, null, 2)}`
          : "";

        const nodeTask = {
          id:          taskId,
          description: (node.data?.description || node.label) + contextStr,
          agent_id:    agent.id,
          task_type:   "workflow",
        };

        // Use the full ReAct loop — workflow nodes get real agentic execution
        result = await runReActLoop(nodeTask, agent);
        queries.updateAgentStatus.run("idle", agent.id);
        broadcast("AGENT_UPDATED", { id: agent.id, status: "idle" });
        break;
      }

      case "team": {
        const team = node.teamId
          ? (queries.getTeamById.get(node.teamId) as any)
          : null;
        if (!team) throw new Error(`Team ${node.teamId} not found`);

        const teamAgents = (queries.getAgentsByTeam.all(team.id) as any[]);
        const teamResults: string[] = [];

        if (team.workflow_mode === "parallel") {
          const promises = teamAgents.map((a: any) =>
            callAI({
              provider:    a.provider as any,
              model:       a.model,
              systemPrompt: a.system_prompt || `You are a ${a.agent_type} agent.`,
              messages:    [{ role: "user", content: node.data?.description || node.label }],
              maxTokens:   2048,
              taskId,
              agentId:     a.id,
            })
          );
          teamResults.push(...await Promise.all(promises));
        } else {
          for (const a of teamAgents) {
            const r = await callAI({
              provider:    a.provider as any,
              model:       a.model,
              systemPrompt: a.system_prompt || `You are a ${a.agent_type} agent.`,
              messages:    [{ role: "user", content: node.data?.description || node.label }],
              maxTokens:   2048,
              taskId,
              agentId:     a.id,
            });
            teamResults.push(r);
          }
        }
        result = teamResults.join("\n\n---\n\n");
        break;
      }

      case "human-in-loop": {
        // Suspend the parent task — set status to awaiting-human so the agent
        // loop will not re-pick it up. Execution resumes when POST /api/checkpoints/:id/approve
        // is called, which sets status back to 'approved'.
        logEntry(taskId, null, `Human approval required at checkpoint: "${node.label}"`, "warning", "task");
        queries.updateTaskStatus.run(
          "awaiting-human",
          JSON.stringify({ checkpoint: node.label, waiting_since: new Date().toISOString() }),
          "awaiting-human",
          "awaiting-human",
          taskId
        );
        broadcast("TASK_UPDATED", { id: taskId, status: "awaiting-human", checkpoint: node.label });

        // Poll until the task is approved or failed (max 24h, checking every 5s)
        const deadline = Date.now() + 24 * 60 * 60 * 1000;
        await new Promise<void>((resolve, reject) => {
          const poll = setInterval(() => {
            const current = queries.getTaskById.get(taskId) as any;
            if (!current || current.status === "failed") {
              clearInterval(poll);
              reject(new Error(`Human rejected checkpoint: ${node.label}`));
            } else if (current.status === "approved") {
              clearInterval(poll);
              resolve();
            } else if (Date.now() > deadline) {
              clearInterval(poll);
              reject(new Error(`Human checkpoint timed out after 24h: ${node.label}`));
            }
          }, 5000);
        });

        // Re-set to running now that human approved
        queries.updateTaskStatus.run("running", null, "running", "running", taskId);
        result = { approved: true, checkpoint: node.label };
        logEntry(taskId, null, `Checkpoint "${node.label}" approved — resuming workflow`, "info", "task");
        break;
      }

      case "condition": {
        const condition = node.data?.condition || "true";
        try {
          result = new Function("vars", `with(vars) { return (${condition}); }`)(variables);
        } catch {
          result = false;
        }
        logEntry(taskId, null, `Condition "${condition}" evaluated to: ${result}`, "info", "task");
        break;
      }

      case "api-call": {
        const endpoint = node.data?.endpoint;
        const method   = node.data?.method || "GET";
        if (!endpoint) throw new Error("API call node has no endpoint configured");

        const fetchRes = await fetch(endpoint, {
          method,
          headers: { "Content-Type": "application/json" },
          body: method !== "GET" ? JSON.stringify(node.data?.body || {}) : undefined,
        });

        if (!fetchRes.ok) throw new Error(`API call to ${endpoint} returned ${fetchRes.status}`);
        result = await fetchRes.json();
        logEntry(taskId, null, `API call to ${endpoint} succeeded`, "info", "task");
        break;
      }

      default:
        result = null;
    }

    variables[node.id] = result;

    queries.updateSubTask.run("completed", JSON.stringify(result)?.substring(0, 500) || "done", subId);
    broadcast("SUB_TASK_UPDATED", { id: subId, status: "completed" });

    // Follow connections to next nodes
    const nextConnections = connections.filter((c: any) => c.source === node.id);
    for (const conn of nextConnections) {
      const nextNode = allNodes.find((n: any) => n.id === conn.target);
      if (nextNode) {
        await executeWorkflowNode(nextNode, allNodes, connections, variables, taskId);
      }
    }

    return result;

  } catch (err: any) {
    queries.updateSubTask.run("failed", err.message, subId);
    broadcast("SUB_TASK_UPDATED", { id: subId, status: "failed", result: err.message });
    throw err;
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJSON(val: any, fallback: any) {
  if (!val) return fallback;
  try { return typeof val === "string" ? JSON.parse(val) : val; }
  catch { return fallback; }
}

// Import helpers needed from db that aren't re-exported
const { getAgentById, getTeamById, getAgentsByTeam } = queries;
