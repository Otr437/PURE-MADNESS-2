// src/run-production.ts
// Full production harness run.
// Integrates: rate limiting, circuit breakers, retry, concurrency caps,
//             cost tracking, tracing, task queue, fallback chain, evaluation.
//
// Run with: npx tsx src/run-production.ts

import "dotenv/config";
import { runAgentProduction } from "./agent-production.js";
import { concurrentAll } from "./concurrency.js";
import { costTracker } from "./cost-tracker.js";
import { tracer } from "./observability.js";
import { circuitBreakers } from "./resilience.js";
import { globalQueue } from "./task-queue.js";
import { evaluateResults } from "./evaluator.js";
import { printEvalReports } from "./evaluator.js";
import { printHarnessResult } from "./printer.js";
import { writeResults } from "./writer.js";
import type { AgentConfig, AgentTask, HarnessResult } from "./types.js";

// ─── AGENTS ───────────────────────────────────────────────────────────────────
const agents: AgentConfig[] = [
  {
    id: "claude-opus",
    provider: "claude",
    model: "claude-opus-4-7",
    temperature: 0.7,
    maxTokens: 2048,
  },
  {
    id: "gpt-55",
    provider: "openai",
    model: "gpt-5.5-2026-04-23",
    temperature: 0.7,
    maxTokens: 2048,
  },
  {
    id: "groq-gpt-oss",
    provider: "groq",
    model: "openai/gpt-oss-120b",
    temperature: 0.7,
    maxTokens: 2048,
  },
  {
    id: "deepseek-v4",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    temperature: 0.7,
    maxTokens: 2048,
  },
];

// ─── TASKS ────────────────────────────────────────────────────────────────────
const tasks: AgentTask[] = [
  {
    id: "task-reasoning",
    systemPrompt: "You are a senior software architect. Be precise and concise.",
    prompt:
      "What are the three most important design decisions when building a production multi-agent AI system? Answer in under 200 words.",
  },
  {
    id: "task-compare",
    systemPrompt: "You are a technical analyst.",
    prompt:
      "Compare fan-out parallelism vs pipeline orchestration for multi-agent systems. Give a concrete use case for each. Under 150 words.",
  },
  {
    id: "task-code",
    systemPrompt: "You are an expert TypeScript developer.",
    prompt:
      "Write a TypeScript function that takes an array of async tasks and runs them with a concurrency limit of N. Use a semaphore pattern. No external libraries.",
  },
];

// ─── ENV CHECK ────────────────────────────────────────────────────────────────
function validateEnv() {
  const required: Record<string, string> = {
    claude:   "ANTHROPIC_API_KEY",
    openai:   "OPENAI_API_KEY",
    groq:     "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };
  const used = new Set(agents.map((a) => a.provider));
  const missing = [...used]
    .map((p) => required[p])
    .filter((k) => !process.env[k]);

  if (missing.length > 0) {
    console.error(`\n[run-production] Missing env vars: ${missing.join(", ")}\n`);
    process.exit(1);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  validateEnv();

  // Init tracer (writes to traces/ dir)
  await tracer.init("traces");

  // Optional: set a cost ceiling (will throw if exceeded)
  // costTracker.setCostCeiling(0.50); // $0.50 max per run

  console.log(
    `\n[run-production] Starting production harness\n` +
    `  Agents : ${agents.length} (${agents.map((a) => a.provider).join(", ")})\n` +
    `  Tasks  : ${tasks.length}\n` +
    `  Mode   : fan-out (all agents × all tasks)\n` +
    `  Jobs   : ${agents.length * tasks.length} total\n`
  );

  const start = Date.now();

  // Build all (agent, task) pairs
  const pairs: Array<{ agent: AgentConfig; task: AgentTask }> = [];
  for (const task of tasks) {
    for (const agent of agents) {
      pairs.push({ agent, task });
    }
  }

  // Run with concurrency cap of 8 simultaneous in-flight requests
  const results = await concurrentAll(pairs, 8, ({ agent, task }) =>
    runAgentProduction(agent, task)
  );

  const totalDurationMs = Date.now() - start;

  // Build harness result for printer + writer
  const harnessResult: HarnessResult = {
    mode: "fan-out",
    totalDurationMs,
    results,
    summary: {
      byProvider: (() => {
        const out: HarnessResult["summary"]["byProvider"] = {};
        for (const r of results) {
          if (!out[r.provider]) out[r.provider] = { count: 0, avgDurationMs: 0, errors: 0 };
          const p = out[r.provider];
          p.count++;
          p.avgDurationMs = (p.avgDurationMs * (p.count - 1) + r.durationMs) / p.count;
          if (r.error) p.errors++;
        }
        return out;
      })(),
      totalTasks: results.length,
      succeeded: results.filter((r) => !r.error).length,
      failed: results.filter((r) => !!r.error).length,
    },
  };

  // Print results
  printHarnessResult(harnessResult);

  // Print cost
  costTracker.printSummary();

  // Print traces
  tracer.printSummary();

  // Print circuit breaker status
  const cbStatus = circuitBreakers.status();
  if (Object.keys(cbStatus).length > 0) {
    console.log("[circuit-breakers]", JSON.stringify(cbStatus, null, 2));
  }

  // Save results to disk
  await writeResults(harnessResult);

  // LLM-as-judge evaluation
  console.log("\n[run-production] Running LLM evaluation (judge model: claude-opus-4-7)...");
  const evalReports = await evaluateResults(results);
  printEvalReports(evalReports);

  // Final queue stats (if any tasks were queued via globalQueue)
  globalQueue.printStats();
}

main().catch((err) => {
  console.error("[run-production] Fatal:", err);
  process.exit(1);
});
