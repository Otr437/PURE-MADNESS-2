// src/writer.ts
// Saves harness results to disk after each run.
// Outputs:
//   results/run-<timestamp>.json   → full structured data
//   results/run-<timestamp>.md     → human-readable markdown report

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { HarnessResult } from "./types.js";

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function toMarkdown(result: HarnessResult, runId: string): string {
  const lines: string[] = [];

  lines.push(`# Multi-Agent Harness Run: ${runId}`);
  lines.push(`**Mode:** ${result.mode}  `);
  lines.push(`**Total wall time:** ${formatMs(result.totalDurationMs)}  `);
  lines.push(
    `**Tasks:** ${result.summary.totalTasks} total | ${result.summary.succeeded} succeeded | ${result.summary.failed} failed`
  );
  lines.push("");

  // Summary table
  lines.push("## Summary by Provider");
  lines.push("");
  lines.push("| Provider | Tasks | Avg Duration | Errors |");
  lines.push("|----------|-------|-------------|--------|");
  for (const [provider, stats] of Object.entries(result.summary.byProvider)) {
    lines.push(
      `| ${provider} | ${stats.count} | ${formatMs(Math.round(stats.avgDurationMs))} | ${stats.errors} |`
    );
  }
  lines.push("");

  // Individual results
  lines.push("## Results");
  lines.push("");

  for (const r of result.results) {
    lines.push(`### [${r.provider} / ${r.model}] — Task: \`${r.task.id}\``);
    lines.push(`**Duration:** ${formatMs(r.durationMs)}`);
    if (r.tokensUsed) {
      lines.push(
        `**Tokens:** prompt=${r.tokensUsed.prompt} | completion=${r.tokensUsed.completion} | total=${r.tokensUsed.total}`
      );
    }
    lines.push("");

    if (r.error) {
      lines.push(`> ❌ **Error:** ${r.error}`);
    } else {
      lines.push(r.text);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

export async function writeResults(result: HarnessResult): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const runId = `run-${timestamp}`;
  const dir = join(process.cwd(), "results");

  await mkdir(dir, { recursive: true });

  const jsonPath = join(dir, `${runId}.json`);
  const mdPath = join(dir, `${runId}.md`);

  await writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  await writeFile(mdPath, toMarkdown(result, runId), "utf8");

  console.log(`\n[writer] Saved results:`);
  console.log(`  JSON → ${jsonPath}`);
  console.log(`  MD   → ${mdPath}`);

  return runId;
}
