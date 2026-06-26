// src/sub-agent.ts
// Sub-agent spawning.
// A parent agent decomposes a task and spawns N child agents to handle sub-tasks.
// All child agents run in parallel. Parent collects and merges their outputs.
// Supports recursive spawning (child can spawn grandchildren) up to maxDepth.

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { deepseek } from "@ai-sdk/deepseek";
import type { AgentConfig, AgentTask, AgentResult } from "./types.js";
import { runAgent } from "./agent.js";

export interface SubTaskSpec {
  id: string;
  prompt: string;
  agentConfig: AgentConfig; // which model handles this sub-task
}

export interface SubAgentResult {
  parentTaskId: string;
  depth: number;
  subResults: AgentResult[];
  mergedOutput: string;
  totalDurationMs: number;
}

// ── DECOMPOSE ────────────────────────────────────────────────────────────────
// Uses the orchestrator model to decompose a complex task into sub-tasks.
// Returns a JSON array of { id, prompt } objects.
export async function decomposeTask(
  task: AgentTask,
  orchestratorConfig: AgentConfig,
  maxSubTasks = 4
): Promise<Array<{ id: string; prompt: string }>> {
  function getModel(config: AgentConfig) {
    switch (config.provider) {
      case "claude":   return anthropic(config.model);
      case "openai":   return openai(config.model);
      case "groq":     return groq(config.model);
      case "deepseek": return deepseek(config.model);
      default: throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  const { text } = await generateText({
    model: getModel(orchestratorConfig),
    system:
      "You are a task decomposer. Given a complex task, break it into independent sub-tasks. " +
      "Respond ONLY with a valid JSON array of objects, each with 'id' (string) and 'prompt' (string). " +
      "No markdown, no explanation, just the JSON array. " +
      `Maximum ${maxSubTasks} sub-tasks.`,
    prompt: `Decompose this task into independent parallel sub-tasks:\n\n${task.prompt}`,
    maxTokens: 1024,
    temperature: 0.3,
  });

  try {
    const cleaned = text.trim().replace(/^```json|^```|```$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error("Not an array");
    return parsed
      .slice(0, maxSubTasks)
      .map((item: { id?: string; prompt: string }, i: number) => ({
        id: item.id ?? `subtask-${i + 1}`,
        prompt: item.prompt,
      }));
  } catch {
    console.warn("[sub-agent] Failed to parse decomposition JSON. Using original task as single sub-task.");
    return [{ id: task.id, prompt: task.prompt }];
  }
}

// ── SPAWN ─────────────────────────────────────────────────────────────────────
// Spawns child agents for each sub-task and runs them all in parallel.
export async function spawnSubAgents(
  parentTask: AgentTask,
  subTaskSpecs: SubTaskSpec[],
  depth = 1,
  maxDepth = 3
): Promise<SubAgentResult> {
  const start = Date.now();

  console.log(
    `  [sub-agent] depth=${depth} spawning ${subTaskSpecs.length} child agent(s) for task="${parentTask.id}"`
  );

  const childResults = await Promise.all(
    subTaskSpecs.map((spec) =>
      runAgent(spec.agentConfig, {
        id: spec.id,
        prompt: spec.prompt,
        systemPrompt: parentTask.systemPrompt,
      })
    )
  );

  // Merge: concatenate successful outputs with labels
  const mergedOutput = childResults
    .filter((r) => !r.error)
    .map((r) => `## Sub-task: ${r.task.id} [${r.provider}/${r.model}]\n\n${r.text}`)
    .join("\n\n---\n\n");

  return {
    parentTaskId: parentTask.id,
    depth,
    subResults: childResults,
    mergedOutput,
    totalDurationMs: Date.now() - start,
  };
}

// ── ORCHESTRATE ───────────────────────────────────────────────────────────────
// Full orchestration: decompose → spawn → merge.
// orchestratorConfig handles decomposition and final synthesis.
// workerConfig handles the actual sub-tasks (can be a cheaper/faster model).
export async function orchestrate(
  task: AgentTask,
  orchestratorConfig: AgentConfig,
  workerConfig: AgentConfig,
  maxSubTasks = 4
): Promise<{ subResults: AgentResult[]; synthesis: string; durationMs: number }> {
  const start = Date.now();

  // Step 1: Decompose
  console.log(`  [orchestrate] Decomposing task "${task.id}" with ${orchestratorConfig.provider}/${orchestratorConfig.model}...`);
  const subTasks = await decomposeTask(task, orchestratorConfig, maxSubTasks);
  console.log(`  [orchestrate] Got ${subTasks.length} sub-task(s): ${subTasks.map((s) => s.id).join(", ")}`);

  // Step 2: Spawn workers
  const specs: SubTaskSpec[] = subTasks.map((s) => ({
    ...s,
    agentConfig: workerConfig,
  }));
  const { subResults, mergedOutput } = await spawnSubAgents(task, specs);

  // Step 3: Synthesize
  console.log(`  [orchestrate] Synthesizing results with ${orchestratorConfig.provider}/${orchestratorConfig.model}...`);
  const synthesisResult = await runAgent(orchestratorConfig, {
    id: `${task.id}-synthesis`,
    prompt:
      `You were given this task:\n${task.prompt}\n\n` +
      `Your sub-agents produced these outputs:\n\n${mergedOutput}\n\n` +
      `Synthesize a single coherent, complete response from these outputs.`,
    systemPrompt: task.systemPrompt,
  });

  return {
    subResults,
    synthesis: synthesisResult.text,
    durationMs: Date.now() - start,
  };
}
