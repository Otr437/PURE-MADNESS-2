// src/run-orchestrate.ts
// Sub-agent orchestration run.
// Claude Opus acts as orchestrator: decomposes the task, spawns DeepSeek/Groq/GPT workers,
// then synthesizes their outputs into a final response.
//
// Run with: npx tsx src/run-orchestrate.ts

import "dotenv/config";
import { orchestrate } from "./sub-agent.js";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const orchestratorConfig = {
  id: "orchestrator",
  provider: "claude" as const,
  model: "claude-opus-4-7",
  temperature: 0.3,
  maxTokens: 4096,
};

const workerConfig = {
  id: "worker",
  provider: "groq" as const,
  model: "openai/gpt-oss-120b",
  temperature: 0.7,
  maxTokens: 2048,
};

const task = {
  id: "complex-research",
  systemPrompt:
    "You are a technical research assistant. Be thorough, cite reasoning, and be concise.",
  prompt:
    "Produce a comprehensive technical overview of multi-agent AI systems in 2026: " +
    "cover architecture patterns, leading frameworks, key challenges, and production deployment best practices.",
};

function validateEnv() {
  const keys = ["ANTHROPIC_API_KEY", "GROQ_API_KEY"];
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`\n[run-orchestrate] Missing: ${missing.join(", ")}\n`);
    process.exit(1);
  }
}

async function main() {
  validateEnv();

  console.log("\n[run-orchestrate] Starting orchestrated run...");
  console.log(`  Orchestrator : ${orchestratorConfig.provider}/${orchestratorConfig.model}`);
  console.log(`  Workers      : ${workerConfig.provider}/${workerConfig.model}`);
  console.log(`  Task         : ${task.id}\n`);

  const { subResults, synthesis, durationMs } = await orchestrate(
    task,
    orchestratorConfig,
    workerConfig,
    4
  );

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  SUB-AGENT OUTPUTS");
  console.log("══════════════════════════════════════════════════════");
  for (const r of subResults) {
    console.log(`\n[${r.provider}/${r.model}] Task: ${r.task.id}`);
    console.log("────────────────────────────────────────────────────");
    if (r.error) {
      console.error(`ERROR: ${r.error}`);
    } else {
      console.log(r.text);
    }
  }

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  SYNTHESIZED OUTPUT");
  console.log("══════════════════════════════════════════════════════");
  console.log(synthesis);
  console.log(`\n[run-orchestrate] Done in ${(durationMs / 1000).toFixed(2)}s`);

  // Save synthesis to results/
  const dir = join(process.cwd(), "results");
  await mkdir(dir, { recursive: true });
  const ts = Temporal.Now.instant().toString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(dir, `orchestrate-${ts}.md`);
  const md =
    `# Orchestrated Run: ${task.id}\n\n` +
    `**Duration:** ${(durationMs / 1000).toFixed(2)}s\n\n` +
    `## Synthesis\n\n${synthesis}\n\n` +
    `## Sub-task Outputs\n\n` +
    subResults
      .map(
        (r) =>
          `### ${r.task.id} [${r.provider}/${r.model}]\n\n${r.error ? `ERROR: ${r.error}` : r.text}`
      )
      .join("\n\n---\n\n");

  await writeFile(outPath, md, "utf8");
  console.log(`[run-orchestrate] Saved to ${outPath}`);
}

main().catch((err) => {
  console.error("[run-orchestrate] Fatal:", err);
  process.exit(1);
});
