// src/run-tools.ts
// Entry point for the tool-calling harness.
// Run with: npx tsx src/run-tools.ts
//
// All four providers run the same tool-enabled task in parallel.
// Tool calls (calculator, fetch_json, web_search) are logged to stdout.
// Full results are saved to results/run-<timestamp>.json + .md

import "dotenv/config";
import { runAgentWithTools } from "./agent-tools.js";
import { printHarnessResult } from "./printer.js";
import { writeResults } from "./writer.js";
import type { AgentConfig, AgentTask, HarnessResult } from "./types.js";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const agents: AgentConfig[] = [
  {
    id: "claude-opus",
    provider: "claude",
    model: "claude-opus-4-7",
    temperature: 0.5,
    maxTokens: 4096,
  },
  {
    id: "gpt-55",
    provider: "openai",
    model: "gpt-5.5-2026-04-23",
    temperature: 0.5,
    maxTokens: 4096,
  },
  {
    id: "groq-gpt-oss",
    provider: "groq",
    model: "openai/gpt-oss-120b",
    temperature: 0.5,
    maxTokens: 4096,
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    temperature: 0.5,
    maxTokens: 4096,
  },
];

// All agents run this same task. Edit the prompt to whatever you need.
const task: AgentTask = {
  id: "tools-task-1",
  systemPrompt:
    "You are a helpful research assistant with access to tools. " +
    "Use the calculator tool for any math. Use fetch_json to retrieve data when needed. " +
    "Think step by step.",
  prompt:
    "What is 2 to the power of 32? Then divide that by 1024. Show your work using the calculator tool.",
};

// ─── ENV VALIDATION ───────────────────────────────────────────────────────────
function validateEnv() {
  const required: Record<string, string> = {
    claude: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };
  const missing = agents
    .map((a) => required[a.provider])
    .filter((k) => !process.env[k]);

  if (missing.length > 0) {
    console.error(`\n[run-tools] Missing env vars: ${missing.join(", ")}\n`);
    process.exit(1);
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
async function main() {
  validateEnv();

  console.log(
    `\n[run-tools] Running tool-calling harness across ${agents.length} providers in parallel...\n`
  );

  const start = Date.now();

  // Fan-out: all agents run the same task simultaneously
  const results = await Promise.all(
    agents.map((agent) => runAgentWithTools(agent, task, 5))
  );

  const harnessResult: HarnessResult = {
    mode: "fan-out",
    totalDurationMs: Date.now() - start,
    results,
    summary: {
      byProvider: Object.fromEntries(
        results.map((r) => [
          r.provider,
          {
            count: 1,
            avgDurationMs: r.durationMs,
            errors: r.error ? 1 : 0,
          },
        ])
      ),
      totalTasks: results.length,
      succeeded: results.filter((r) => !r.error).length,
      failed: results.filter((r) => !!r.error).length,
    },
  };

  printHarnessResult(harnessResult);
  await writeResults(harnessResult);
}

main().catch((err) => {
  console.error("[run-tools] Fatal:", err);
  process.exit(1);
});
