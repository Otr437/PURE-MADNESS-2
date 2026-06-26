// src/printer.ts
import type { HarnessResult, AgentResult } from "./types.js";

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

const PROVIDER_COLORS: Record<string, string> = {
  claude: COLORS.magenta,
  openai: COLORS.green,
  groq: COLORS.yellow,
  deepseek: COLORS.cyan,
};

function color(text: string, c: string) {
  return `${c}${text}${COLORS.reset}`;
}

function divider(char = "─", width = 80) {
  return char.repeat(width);
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function printResult(result: AgentResult) {
  const provColor = PROVIDER_COLORS[result.provider] ?? COLORS.white;
  const label = color(
    `[${result.provider.toUpperCase()} / ${result.model}]`,
    provColor + COLORS.bold
  );
  const taskLabel = color(`Task: ${result.task.id}`, COLORS.dim);
  const timeLabel = color(`(${formatMs(result.durationMs)})`, COLORS.dim);

  console.log(`\n${label} ${taskLabel} ${timeLabel}`);
  console.log(divider());

  if (result.error) {
    console.log(color(`ERROR: ${result.error}`, COLORS.red));
  } else {
    console.log(result.text);
    if (result.tokensUsed) {
      console.log(
        color(
          `\nTokens — prompt: ${result.tokensUsed.prompt} | completion: ${result.tokensUsed.completion} | total: ${result.tokensUsed.total}`,
          COLORS.dim
        )
      );
    }
  }
}

export function printHarnessResult(result: HarnessResult) {
  console.log(
    "\n" +
      color("═".repeat(80), COLORS.bold) +
      "\n" +
      color(
        `  MULTI-AGENT HARNESS RESULTS  [mode: ${result.mode.toUpperCase()}]`,
        COLORS.bold + COLORS.white
      ) +
      "\n" +
      color("═".repeat(80), COLORS.bold)
  );

  for (const r of result.results) {
    printResult(r);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + color("═".repeat(80), COLORS.bold));
  console.log(color("  SUMMARY", COLORS.bold + COLORS.white));
  console.log(color("═".repeat(80), COLORS.bold));

  console.log(
    `\nTotal wall time : ${color(formatMs(result.totalDurationMs), COLORS.cyan)}`
  );
  console.log(
    `Tasks           : ${result.summary.totalTasks} total | ` +
      color(`${result.summary.succeeded} succeeded`, COLORS.green) +
      " | " +
      (result.summary.failed > 0
        ? color(`${result.summary.failed} failed`, COLORS.red)
        : color("0 failed", COLORS.dim))
  );

  console.log("\nBy provider:");
  for (const [provider, stats] of Object.entries(result.summary.byProvider)) {
    const provColor = PROVIDER_COLORS[provider] ?? COLORS.white;
    console.log(
      `  ${color(provider.padEnd(10), provColor + COLORS.bold)}` +
        `tasks: ${stats.count}  ` +
        `avg: ${formatMs(Math.round(stats.avgDurationMs))}  ` +
        (stats.errors > 0
          ? color(`errors: ${stats.errors}`, COLORS.red)
          : color("no errors", COLORS.dim))
    );
  }

  console.log("\n" + color("═".repeat(80), COLORS.bold) + "\n");
}
