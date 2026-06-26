#!/usr/bin/env ts-node
/**
 * Production Runtime Harness — TypeScript
 * Wires react_loop.ts into a fully runnable CLI agent.
 *
 * Usage:
 *   npx ts-node run_agent.ts "your task here"
 *   npx ts-node run_agent.ts --system "You are a DevOps expert." "audit /tmp"
 *   npx ts-node run_agent.ts --max-iter 50 --json-out /tmp/result.json "task"
 *   echo "task" | npx ts-node run_agent.ts -
 *
 * Environment:
 *   ANTHROPIC_API_KEY   required
 *   AGENT_MAX_ITER      default 30
 *   AGENT_SYSTEM        system prompt override
 *   AGENT_LOG_LEVEL     debug | info (default info)
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ── Validate environment ──────────────────────────────────────────────────────
function validateEnv() {
  const provider = (process.env.MODEL_PROVIDER ?? "anthropic").trim().toLowerCase();
  const keyMap: Record<string, string> = {
    "anthropic":       "ANTHROPIC_API_KEY",
    "deepseek":        "DEEPSEEK_API_KEY",
    "deepseek-openai": "DEEPSEEK_API_KEY",
    "openai":          "OPENAI_API_KEY",
  };
  const envVar = keyMap[provider];
  if (!envVar) {
    process.stderr.write(`[harness] ERROR: unknown MODEL_PROVIDER '${provider}'\n`);
    process.exit(1);
  }
  const key = (process.env[envVar] ?? "").trim();
  if (!key) {
    process.stderr.write(`[harness] ERROR: ${envVar} is not set (required for provider '${provider}')\n`);
    process.exit(1);
  }
  process.stderr.write(`[harness] provider=${provider} model=${process.env.MODEL_NAME ?? "(default)"}\n`);
}

// ── Logger ────────────────────────────────────────────────────────────────────
const logLevel = (process.env.AGENT_LOG_LEVEL ?? "info").toLowerCase();
function log(level: "info" | "warn" | "error" | "debug", msg: string) {
  if (level === "debug" && logLevel !== "debug") return;
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} [${level.toUpperCase()}] ${msg}\n`);
}

// ── Signal handling ───────────────────────────────────────────────────────────
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) { process.stderr.write("\n[harness] Force quit\n"); process.exit(130); }
  interrupted = true;
  process.stderr.write("\n[harness] Interrupt — finishing current iteration...\n");
});

// ── Import engine ─────────────────────────────────────────────────────────────
import { runReact, Step } from "./react_loop";

// ── Step printer ──────────────────────────────────────────────────────────────
function makeStepPrinter(verbose: boolean) {
  if (!verbose) return undefined;
  return (step: Step) => {
    if (interrupted) throw new Error("Agent interrupted by user");
    if (step.type === "thought") {
      process.stdout.write(`\n\x1b[94m💭 THOUGHT\x1b[0m\n${step.content}\n`);
    } else if (step.type === "action") {
      const inp = JSON.stringify((step as any).input, null, 2);
      process.stdout.write(`\n\x1b[93m⚡ ACTION\x1b[0m  ${(step as any).tool}\n${inp}\n`);
    } else if (step.type === "observation") {
      const color  = (step as any).error ? "\x1b[91m" : "\x1b[92m";
      const label  = (step as any).error ? "❌ ERROR" : "👁 OBSERVE";
      const preview = step.content.slice(0, 600) + (step.content.length > 600 ? "..." : "");
      process.stdout.write(`\n${color}${label}\x1b[0m\n${preview}\n`);
    }
  };
}

// ── Arg parser ────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    task:     "",
    system:   process.env.AGENT_SYSTEM ?? "",
    maxIter:  parseInt(process.env.AGENT_MAX_ITER ?? "30", 10),
    jsonOut:  null as string | null,
    quiet:    false,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--system":   opts.system  = args[++i]; break;
      case "--max-iter": opts.maxIter = parseInt(args[++i], 10); break;
      case "--json-out": opts.jsonOut = args[++i]; break;
      case "--quiet":    opts.quiet   = true; break;
      default:           opts.task    = args[i]; break;
    }
    i++;
  }
  return opts;
}

// ── Read stdin ────────────────────────────────────────────────────────────────
async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    const lines: string[] = [];
    rl.on("line", (l) => lines.push(l));
    rl.on("close", () => resolve(lines.join("\n").trim()));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  validateEnv();
  const opts = parseArgs();

  if (!opts.task || opts.task === "-") {
    opts.task = await readStdin();
  }
  if (!opts.task) {
    process.stderr.write("[harness] ERROR: No task provided\n");
    process.exit(1);
  }

  log("info", `Task: ${opts.task.slice(0, 200)}`);
  log("info", `Max iterations: ${opts.maxIter}`);

  const start = Date.now();

  try {
    const { answer, trace } = await runReact(opts.task, {
      systemExtra:   opts.system,
      maxIterations: opts.maxIter,
      onStep:        makeStepPrinter(!opts.quiet),
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    const sep = "=".repeat(64);

    process.stdout.write(`\n${sep}\nFINAL ANSWER\n${sep}\n${answer}\n${sep}\n`);
    process.stdout.write(`Iterations: ${trace.iterations} | Tokens: ${trace.totalTokens} | Time: ${elapsed}s\n`);

    if (opts.jsonOut) {
      const out = {
        task:        opts.task,
        answer,
        iterations:  trace.iterations,
        totalTokens: trace.totalTokens,
        elapsedS:    parseFloat(elapsed),
        steps:       trace.steps,
      };
      fs.writeFileSync(opts.jsonOut, JSON.stringify(out, null, 2), "utf8");
      log("info", `Result written to ${opts.jsonOut}`);
    }

    process.exit(0);

  } catch (e: unknown) {
    const err = e as Error;
    if (interrupted || err.message?.includes("interrupted")) {
      log("warn", "Agent stopped by user");
      process.exit(130);
    }
    log("error", `Agent failed: ${err.message}`);
    process.exit(1);
  }
}

main();
