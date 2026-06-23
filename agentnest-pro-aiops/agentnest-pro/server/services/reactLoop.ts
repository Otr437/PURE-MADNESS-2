/**
 * ReAct Loop Engine — Think → Act → Observe → repeat until done or budget exhausted.
 *
 * Replaces the single callAI() call in processDirectTask with a true iterative
 * agentic loop. Each iteration:
 *   1. Builds a prompt containing the task, tool list, memory context, and
 *      the full prior chain (thought/action/observation history).
 *   2. Calls the LLM. Parses the response to extract Thought, Action, and
 *      Action Input from structured output.
 *   3. If Action is "Final Answer" → loop terminates, result returned.
 *   4. Otherwise → executes the named tool, captures the Observation.
 *   5. Appends step to short-term memory and episodic log.
 *   6. Repeats up to maxSteps. Budget exceeded → forced final answer.
 *
 * Stop conditions enforced:
 *   - maxSteps per agent specialty
 *   - "Final Answer:" keyword in LLM output
 *   - Tool execution failure after 2 consecutive failures → bail out
 */

import { callAI }              from "./ai.js";
import { logEntry }            from "../db/index.js";
import { broadcast }           from "../websocket/index.js";
import {
  stmInit, stmAppend, stmSerialize, stmClear,
} from "./memory/shortTerm.js";
import {
  episodicWrite,
} from "./memory/episodic.js";
import {
  longTermQuery, longTermSerialize,
} from "./memory/longTerm.js";
import {
  getToolsForAgent,
  serializeToolsForPrompt,
  getTool,
  type ToolDefinition,
} from "./tools/index.js";
import {
  getAgentSpecialty,
} from "./agentSpecialties.js";

// ─── Tool imports (side-effects register each tool into the registry) ─────────
import "./tools/webSearch.js";
import "./tools/codeExecutor.js";
import "./tools/apiCaller.js";
import "./tools/memoryTools.js";
import "./tools/agentSpawner.js";
import "./tools/splunkSearch.js";
import "./tools/cveLookup.js";
import "./tools/emailDraft.js";
import "./tools/emailSend.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReActTask {
  id:          string;
  description: string;
  agent_id:    string | null;
  task_type:   string;
}

interface ParsedStep {
  thought:     string;
  action:      string | null;   // null = final answer
  actionInput: Record<string, any> | null;
  finalAnswer: string | null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the ReAct loop for one task with one agent.
 * Returns the final answer string.
 */
export async function runReActLoop(task: ReActTask, agent: any): Promise<string> {
  const agentType  = agent?.agent_type ?? "general-assistant";
  const specialty  = getAgentSpecialty(agentType);
  const tools      = getToolsForAgent(specialty.allowedTools);
  const maxSteps   = specialty.maxSteps;

  const taskId  = task.id;
  const agentId = agent?.id ?? null;

  // Initialise short-term memory for this task
  stmInit(taskId);

  // Prime long-term memory context (top-5 relevant memories)
  const priorMemories = agentId
    ? longTermQuery(agentId, task.description, 5)
    : [];
  const memoryContext = longTermSerialize(priorMemories);

  logEntry(taskId, agentId, `ReAct loop starting — ${tools.length} tools available, max ${maxSteps} steps`, "command", "agent");
  broadcast("TASK_UPDATED", { id: taskId, status: "running", react_step: 0 });

  let consecutiveFailures = 0;
  let finalAnswer: string | null = null;

  for (let step = 1; step <= maxSteps; step++) {
    broadcast("TASK_UPDATED", { id: taskId, react_step: step });
    logEntry(taskId, agentId, `ReAct step ${step}/${maxSteps}`, "info", "agent");

    // Build the prompt for this iteration
    const prompt = buildReActPrompt({
      task:          task.description,
      specialty,
      tools,
      priorChain:    stmSerialize(taskId),
      memoryContext,
      currentStep:   step,
      maxSteps,
    });

    let rawResponse: string;
    try {
      rawResponse = await callAI({
        provider:    agent?.provider ?? "anthropic",
        model:       agent?.model    ?? "claude-sonnet-4-6",
        systemPrompt: specialty.systemPrompt,
        messages:    [{ role: "user", content: prompt }],
        maxTokens:   2048,
        taskId,
        agentId,
      });
    } catch (err: any) {
      logEntry(taskId, agentId, `LLM call failed on step ${step}: ${err.message}`, "error", "agent");
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        finalAnswer = `Task terminated after repeated LLM failures. Last error: ${err.message}`;
        break;
      }
      continue;
    }

    // Parse the structured ReAct output
    const parsed = parseReActResponse(rawResponse);

    // Persist to episodic memory
    episodicWrite(
      taskId, agentId, step,
      parsed.thought,
      parsed.action,
      parsed.actionInput,
      null  // observation filled in after tool call
    );

    // If the model produced a Final Answer → done
    if (parsed.finalAnswer !== null) {
      stmAppend(taskId, {
        thought:     parsed.thought,
        action:      null,
        actionInput: null,
        observation: null,
      });
      finalAnswer = parsed.finalAnswer;
      logEntry(taskId, agentId, `Final answer produced on step ${step}`, "success", "agent");
      break;
    }

    // No action selected — treat the whole response as a final answer
    if (!parsed.action) {
      finalAnswer = rawResponse.trim();
      logEntry(taskId, agentId, "No action found — treating response as final answer", "info", "agent");
      break;
    }

    // Execute the tool
    const tool = getTool(parsed.action);
    let observation: string;

    if (!tool) {
      observation = `Error: Tool "${parsed.action}" is not available. Available tools: ${tools.map(t => t.name).join(", ")}`;
      consecutiveFailures++;
      logEntry(taskId, agentId, observation, "warning", "agent");
    } else {
      logEntry(taskId, agentId, `Executing tool: ${tool.name}(${JSON.stringify(parsed.actionInput ?? {})})`, "command", "agent");
      try {
        const result = await tool.execute(parsed.actionInput ?? {}, taskId, agentId);
        observation = result.success
          ? result.output
          : `Tool error: ${result.error}${result.output ? `\nPartial output: ${result.output}` : ""}`;

        if (!result.success) {
          consecutiveFailures++;
          logEntry(taskId, agentId, `Tool ${tool.name} failed: ${result.error}`, "warning", "agent");
        } else {
          consecutiveFailures = 0;
          logEntry(taskId, agentId, `Tool ${tool.name} returned ${result.output.length} chars`, "info", "agent");
        }
      } catch (err: any) {
        observation = `Tool threw an exception: ${err.message}`;
        consecutiveFailures++;
        logEntry(taskId, agentId, `Tool ${tool.name} threw: ${err.message}`, "error", "agent");
      }
    }

    // Append full step to short-term memory
    stmAppend(taskId, {
      thought:     parsed.thought,
      action:      parsed.action,
      actionInput: parsed.actionInput,
      observation,
    });

    // Update episodic log with the observation
    episodicWrite(taskId, agentId, step, parsed.thought, parsed.action, parsed.actionInput, observation);

    broadcast("TASK_UPDATED", {
      id:          taskId,
      react_step:  step,
      last_action: parsed.action,
      last_obs:    observation.substring(0, 200),
    });

    // Bail if too many consecutive failures
    if (consecutiveFailures >= 3) {
      finalAnswer = `Task aborted after ${consecutiveFailures} consecutive tool failures. Last observation: ${observation}`;
      logEntry(taskId, agentId, "Too many consecutive failures — aborting loop", "error", "agent");
      break;
    }
  }

  // Budget exhausted without a final answer
  if (finalAnswer === null) {
    const chain = stmSerialize(taskId);
    finalAnswer = await forceFinalAnswer({
      task:        task.description,
      chain,
      specialty,
      agent,
      taskId,
      agentId,
    });
    logEntry(taskId, agentId, `Max steps (${maxSteps}) reached — forced final answer`, "warning", "agent");
  }

  stmClear(taskId);
  return finalAnswer;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildReActPrompt(opts: {
  task:         string;
  specialty:    ReturnType<typeof getAgentSpecialty>;
  tools:        ToolDefinition[];
  priorChain:   string;
  memoryContext: string;
  currentStep:  number;
  maxSteps:     number;
}): string {
  const { task, tools, priorChain, memoryContext, currentStep, maxSteps, specialty } = opts;

  const toolBlock = serializeToolsForPrompt(tools);
  const memBlock  = memoryContext
    ? `\n\n## Relevant Prior Knowledge\n${memoryContext}`
    : "";
  const chainBlock = priorChain
    ? `\n\n## Prior Steps This Task\n${priorChain}`
    : "";

  return `## Task
${task}

## Stop Condition
${specialty.stopCondition}

## Available Tools
${toolBlock}
${memBlock}
${chainBlock}

## Instructions
You are on step ${currentStep} of a maximum ${maxSteps} steps.

Respond in EXACTLY this format — no deviations:

Thought: <your reasoning about what to do next>
Action: <tool name from the list above, OR the literal text "Final Answer">
Action Input: <JSON object of arguments for the tool, OR your complete final answer if Action is "Final Answer">

Rules:
- If you have enough information to answer completely, use Action: Final Answer
- Action Input must be valid JSON when calling a tool
- Never call a tool not in the Available Tools list
- Every Thought must explain WHY you are taking this action
- If the stop condition is met, use Final Answer immediately`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseReActResponse(raw: string): ParsedStep {
  const lines = raw.split("\n");

  let thought     = "";
  let action:      string | null = null;
  let actionInput: Record<string, any> | null = null;
  let finalAnswer: string | null = null;

  let mode: "thought" | "action" | "input" | "none" = "none";
  const inputLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("Thought:")) {
      thought = line.replace(/^Thought:\s*/, "").trim();
      mode    = "thought";
    } else if (line.startsWith("Action:")) {
      const a = line.replace(/^Action:\s*/, "").trim();
      action  = a === "Final Answer" ? null : a;
      mode    = "action";
      // If it IS Final Answer, we'll collect input lines as the answer text
      if (a === "Final Answer") finalAnswer = "";
    } else if (line.startsWith("Action Input:")) {
      const rest = line.replace(/^Action Input:\s*/, "").trim();
      inputLines.push(rest);
      mode = "input";
    } else if (mode === "input") {
      inputLines.push(line);
    } else if (mode === "thought") {
      // Multi-line thought
      thought += " " + line.trim();
    }
  }

  // Parse accumulated input lines
  const rawInput = inputLines.join("\n").trim();

  if (finalAnswer !== null) {
    // Final Answer: everything after Action Input: is the answer
    finalAnswer = rawInput || thought;
    action      = null;
    actionInput = null;
  } else if (action && rawInput) {
    // Tool call: parse JSON arguments
    try {
      actionInput = JSON.parse(rawInput);
    } catch {
      // Try to extract JSON block from the text
      const jsonMatch = rawInput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          actionInput = JSON.parse(jsonMatch[0]);
        } catch {
          actionInput = { input: rawInput };
        }
      } else {
        actionInput = { input: rawInput };
      }
    }
  }

  return {
    thought:     thought || raw.substring(0, 200),
    action:      action ?? null,
    actionInput: actionInput ?? null,
    finalAnswer: finalAnswer,
  };
}

// ─── Forced final answer when budget exhausted ────────────────────────────────

async function forceFinalAnswer(opts: {
  task:     string;
  chain:    string;
  specialty: ReturnType<typeof getAgentSpecialty>;
  agent:    any;
  taskId:   string;
  agentId:  string | null;
}): Promise<string> {
  const { task, chain, specialty, agent, taskId, agentId } = opts;

  const prompt = `## Task
${task}

## Work Done So Far
${chain || "(no steps completed)"}

## Instruction
You have reached the maximum step budget. Based on all the work done above, provide the best possible final answer now. Be complete — do not ask for more steps.`;

  try {
    return await callAI({
      provider:    agent?.provider ?? "anthropic",
      model:       agent?.model    ?? "claude-sonnet-4-6",
      systemPrompt: specialty.systemPrompt,
      messages:    [{ role: "user", content: prompt }],
      maxTokens:   2048,
      taskId,
      agentId,
    });
  } catch (err: any) {
    return `Task could not be completed within the step budget. Last error: ${err.message}`;
  }
}
