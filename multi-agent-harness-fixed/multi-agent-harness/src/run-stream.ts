// src/run-stream.ts
// Entry point for the streaming harness.
// Run with: npx tsx src/run-stream.ts
//
// NOTE: Because all four providers stream simultaneously to stdout,
// tokens interleave. Each line is prefixed with a color-coded provider label.
// For clean sequential output, run in pipeline mode (src/index.ts mode: "pipeline").

import "dotenv/config";
import { runAgentStream } from "./agent-stream.js";
import { writeResults } from "./writer.js";
import type { AgentConfig, AgentTask, HarnessResult } from "./types.js";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const agents: AgentConfig[] = [
  {
    id: "claude-opus",
    provider: "claude",
    model: "claude-opus-4-7",
    temperature: 0.7,
    maxTokens: 512,
  },
  {
    id: "gpt-55",
    provider: "openai",
    model: "gpt-5.5-2026-04-23",
    temperature: 0.7,
    maxTokens: 512,
  },
  {
    id: "groq-gpt-oss",
    provider: "groq",
    model: "openai/gpt-oss-120b",
    temperature: 0.7,
    maxTokens: 512,
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    temperature: 0.7,
    maxTokens: 512,
  },
];

const task: AgentTask = {
  id: "stream-task-1",
  systemPrompt: "You are a concise technical assistant.",
  prompt:
    "In exactly 3 sentences, explain what makes a good multi-agent orchestration system.",
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
    console.error(`\n[run-stream] Missing env vars: ${missing.join(", ")}\n`);
    process.exit(1);
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
async function main() {
  validateEnv();

  console.log(
    `\n[run-stream] Streaming from ${agents.length} providers simultaneously...\n` +
    `(tokens interleave — each line is prefixed with [provider/model])\n`
  );

  const start = Date.now();

  const results = await Promise.all(
    agents.map((agent) => runAgentStream(agent, task))
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

  console.log(`\n[run-stream] All streams complete. Wall time: ${Date.now() - start}ms`);
  await writeResults(harnessResult);
}

main().catch((err) => {
  console.error("[run-stream] Fatal:", err);
  process.exit(1);
});
