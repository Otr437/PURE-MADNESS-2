// src/harness.ts
import { runAgent } from "./agent.js";
import type { HarnessConfig, HarnessResult, AgentResult } from "./types.js";

// ─── FAN-OUT ──────────────────────────────────────────────────────────────────
// Every agent runs every task simultaneously.
// Use this to compare outputs across all providers for the same prompt.
async function fanOut(config: HarnessConfig): Promise<AgentResult[]> {
  const jobs: Promise<AgentResult>[] = [];

  for (const task of config.tasks) {
    for (const agent of config.agents) {
      jobs.push(runAgent(agent, task));
    }
  }

  return Promise.all(jobs);
}

// ─── PARALLEL-TASKS ───────────────────────────────────────────────────────────
// Each agent is assigned a different task. All run simultaneously.
// agents[0] → tasks[0], agents[1] → tasks[1], etc.
// If there are more tasks than agents, remaining tasks are round-robined.
async function parallelTasks(config: HarnessConfig): Promise<AgentResult[]> {
  const jobs: Promise<AgentResult>[] = config.tasks.map((task, i) => {
    const agent = config.agents[i % config.agents.length];
    return runAgent(agent, task);
  });

  return Promise.all(jobs);
}

// ─── PIPELINE ─────────────────────────────────────────────────────────────────
// Tasks run in sequence. Each agent handles one stage.
// The output of agent[n] becomes the prompt for agent[n+1].
// config.tasks[0] is the initial prompt. Subsequent tasks are ignored.
async function pipeline(config: HarnessConfig): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  const initialTask = config.tasks[0];

  if (!initialTask) throw new Error("Pipeline mode requires at least one task.");

  let currentPrompt = initialTask.prompt;

  for (const agent of config.agents) {
    const task = { ...initialTask, prompt: currentPrompt };
    const result = await runAgent(agent, task);
    results.push(result);

    if (result.error) {
      console.error(
        `[pipeline] Agent ${agent.id} failed: ${result.error}. Halting pipeline.`
      );
      break;
    }

    // Feed this agent's output into the next agent's prompt
    currentPrompt = result.text;
  }

  return results;
}

// ─── SUMMARY ──────────────────────────────────────────────────────────────────
function buildSummary(results: AgentResult[]): HarnessResult["summary"] {
  const byProvider: Record<
    string,
    { count: number; avgDurationMs: number; errors: number }
  > = {};

  for (const r of results) {
    if (!byProvider[r.provider]) {
      byProvider[r.provider] = { count: 0, avgDurationMs: 0, errors: 0 };
    }
    const p = byProvider[r.provider];
    p.count++;
    p.avgDurationMs =
      (p.avgDurationMs * (p.count - 1) + r.durationMs) / p.count;
    if (r.error) p.errors++;
  }

  return {
    byProvider,
    totalTasks: results.length,
    succeeded: results.filter((r) => !r.error).length,
    failed: results.filter((r) => !!r.error).length,
  };
}

// ─── MAIN HARNESS RUNNER ──────────────────────────────────────────────────────
export async function runHarness(config: HarnessConfig): Promise<HarnessResult> {
  const start = Date.now();

  let results: AgentResult[];

  switch (config.mode) {
    case "fan-out":
      results = await fanOut(config);
      break;
    case "parallel-tasks":
      results = await parallelTasks(config);
      break;
    case "pipeline":
      results = await pipeline(config);
      break;
    default:
      throw new Error(`Unknown mode: ${config.mode}`);
  }

  return {
    mode: config.mode,
    totalDurationMs: Date.now() - start,
    results,
    summary: buildSummary(results),
  };
}
