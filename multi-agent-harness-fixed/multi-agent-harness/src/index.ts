// src/index.ts
import "dotenv/config";
import { runHarness } from "./harness.js";
import { printHarnessResult } from "./printer.js";
import type { HarnessConfig } from "./types.js";

// ─── CONFIGURE YOUR AGENTS ────────────────────────────────────────────────────
// Keys are read from .env:
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY
//
// Models as of May 2026:
//   Claude   → claude-opus-4-7  (latest, $5/$25 per M tokens)
//   OpenAI   → gpt-5.5-2026-04-23  (flagship) | chat-latest (GPT-5.5 Instant)
//   Groq     → openai/gpt-oss-120b  (current flagship on Groq LPU)
//   DeepSeek → deepseek-v4-pro  (flagship, 75% discount until 2026-05-31)
//              deepseek-v4-flash  (fast/cheap; "deepseek-chat" alias deprecated 2026-07-24)

const config: HarnessConfig = {
  // ─── MODE ─────────────────────────────────────────────────────────────────
  // "fan-out"        → every agent runs every task (compare providers side-by-side)
  // "parallel-tasks" → each agent gets a different task, all run at once
  // "pipeline"       → tasks run sequentially, each agent's output feeds the next
  mode: "fan-out",

  // ─── AGENTS ───────────────────────────────────────────────────────────────
  agents: [
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
      id: "deepseek-v4-pro",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      temperature: 0.7,
      maxTokens: 2048,
    },
  ],

  // ─── TASKS ────────────────────────────────────────────────────────────────
  // Edit these prompts to whatever you need.
  // In fan-out mode all agents run all tasks.
  // In parallel-tasks mode agent[i] runs task[i].
  // In pipeline mode only task[0] is used as the initial prompt.
  tasks: [
    {
      id: "task-1",
      systemPrompt:
        "You are a senior software engineer. Be concise and precise.",
      prompt:
        "Explain the tradeoffs between fan-out parallelism and pipeline orchestration in multi-agent systems. Keep it under 200 words.",
    },
    {
      id: "task-2",
      systemPrompt: "You are a technical writer. Be clear and structured.",
      prompt:
        "Write a 5-bullet summary of why TypeScript is preferred over Python for building production AI agent harnesses in 2026.",
    },
  ],
};

// ─── ENV VALIDATION ───────────────────────────────────────────────────────────
function validateEnv() {
  const required: Record<string, string> = {
    claude: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };

  const usedProviders = new Set(config.agents.map((a) => a.provider));
  const missing: string[] = [];

  for (const provider of usedProviders) {
    const key = required[provider];
    if (!process.env[key]) {
      missing.push(`${key} (for ${provider})`);
    }
  }

  if (missing.length > 0) {
    console.error(
      `\n[harness] Missing env vars:\n${missing.map((m) => `  • ${m}`).join("\n")}\n` +
        `Copy .env.example → .env and fill in your keys.\n`
    );
    process.exit(1);
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
async function main() {
  validateEnv();

  const providerList = [...new Set(config.agents.map((a) => a.provider))].join(
    ", "
  );
  const taskCount = config.tasks.length;
  const agentCount = config.agents.length;

  console.log(`\n[harness] mode=${config.mode} | agents=${agentCount} (${providerList}) | tasks=${taskCount}`);
  console.log("[harness] Dispatching...\n");

  const result = await runHarness(config);
  printHarnessResult(result);
}

main().catch((err) => {
  console.error("[harness] Fatal error:", err);
  process.exit(1);
});
