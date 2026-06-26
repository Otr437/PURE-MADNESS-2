// src/evaluator.ts
// LLM-as-judge evaluator.
// After fan-out mode, sends all provider outputs to a judge model which scores
// each response on accuracy, clarity, and completeness.
// Produces a ranked leaderboard per task.

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { AgentResult } from "./types.js";

export interface EvalScore {
  agentId: string;
  provider: string;
  model: string;
  taskId: string;
  scores: {
    accuracy: number;      // 1-10
    clarity: number;       // 1-10
    completeness: number;  // 1-10
    overall: number;       // weighted average
  };
  reasoning: string;
}

export interface EvalReport {
  taskId: string;
  prompt: string;
  scores: EvalScore[];
  winner: EvalScore;
  rankedList: EvalScore[];
}

// Uses Claude Opus as the judge (most capable reasoning).
// Swap to a different model if preferred.
const JUDGE_MODEL = anthropic("claude-opus-4-7");

async function judgeResponses(
  taskPrompt: string,
  responses: Array<{ agentId: string; provider: string; model: string; text: string }>
): Promise<EvalScore[]> {
  const responsesBlock = responses
    .map(
      (r, i) =>
        `### Response ${i + 1} [${r.provider}/${r.model}]\n${r.text}`
    )
    .join("\n\n---\n\n");

  const { text } = await generateText({
    model: JUDGE_MODEL,
    system:
      "You are an impartial LLM evaluator. Score each response on three dimensions: " +
      "accuracy (factual correctness, 1-10), clarity (how easy to understand, 1-10), " +
      "completeness (covers all aspects of the task, 1-10). " +
      "Respond ONLY with a valid JSON array. Each element: " +
      '{ "index": number, "accuracy": number, "clarity": number, "completeness": number, "reasoning": string }. ' +
      "No markdown. No extra text. Just the JSON array.",
    prompt: `Task: ${taskPrompt}\n\n${responsesBlock}`,
    maxTokens: 2048,
    temperature: 0.1,
  });

  const cleaned = text.trim().replace(/^```json|^```|```$/g, "").trim();
  const parsed: Array<{
    index: number;
    accuracy: number;
    clarity: number;
    completeness: number;
    reasoning: string;
  }> = JSON.parse(cleaned);

  return parsed.map((p) => {
    const r = responses[p.index - 1];
    const overall =
      Math.round(
        (p.accuracy * 0.4 + p.clarity * 0.3 + p.completeness * 0.3) * 10
      ) / 10;
    return {
      agentId: r.agentId,
      provider: r.provider,
      model: r.model,
      taskId: "",
      scores: {
        accuracy: p.accuracy,
        clarity: p.clarity,
        completeness: p.completeness,
        overall,
      },
      reasoning: p.reasoning,
    };
  });
}

export async function evaluateResults(
  results: AgentResult[]
): Promise<EvalReport[]> {
  // Group by task
  const byTask = new Map<string, AgentResult[]>();
  for (const r of results) {
    if (!byTask.has(r.task.id)) byTask.set(r.task.id, []);
    byTask.get(r.task.id)!.push(r);
  }

  const reports: EvalReport[] = [];

  for (const [taskId, taskResults] of byTask.entries()) {
    const successful = taskResults.filter((r) => !r.error && r.text.trim());
    if (successful.length === 0) continue;

    console.log(
      `  [evaluator] Judging ${successful.length} responses for task "${taskId}"...`
    );

    try {
      const scores = await judgeResponses(
        successful[0].task.prompt,
        successful.map((r) => ({
          agentId: r.agentId,
          provider: r.provider,
          model: r.model,
          text: r.text,
        }))
      );

      // Tag taskId
      for (const s of scores) s.taskId = taskId;

      const ranked = [...scores].sort(
        (a, b) => b.scores.overall - a.scores.overall
      );

      reports.push({
        taskId,
        prompt: successful[0].task.prompt,
        scores,
        winner: ranked[0],
        rankedList: ranked,
      });
    } catch (err) {
      console.error(`  [evaluator] Failed to evaluate task "${taskId}":`, err);
    }
  }

  return reports;
}

export function printEvalReports(reports: EvalReport[]): void {
  if (reports.length === 0) return;

  console.log("\n\x1b[1m═══════════════════════════════════════════════════════════════════\x1b[0m");
  console.log("\x1b[1m  EVALUATION RESULTS (LLM-as-Judge)\x1b[0m");
  console.log("\x1b[1m═══════════════════════════════════════════════════════════════════\x1b[0m");

  for (const report of reports) {
    console.log(`\nTask: \x1b[36m${report.taskId}\x1b[0m`);
    console.log(`Prompt: ${report.prompt.slice(0, 100)}${report.prompt.length > 100 ? "…" : ""}`);
    console.log(
      `\n  ${"Provider".padEnd(20)} ${"Accuracy".padEnd(10)} ${"Clarity".padEnd(10)} ${"Complete".padEnd(10)} Overall`
    );
    console.log("  " + "─".repeat(65));

    for (const s of report.rankedList) {
      const isWinner = s.agentId === report.winner.agentId;
      const label = `${s.provider}/${s.model}`.padEnd(20);
      const line =
        `  ${label} ` +
        `${String(s.scores.accuracy).padEnd(10)}` +
        `${String(s.scores.clarity).padEnd(10)}` +
        `${String(s.scores.completeness).padEnd(10)}` +
        `${s.scores.overall}`;
      console.log(isWinner ? `\x1b[32m${line} ← WINNER\x1b[0m` : line);
    }

    console.log(`\n  Winner reasoning: ${report.winner.reasoning.slice(0, 200)}`);
  }

  console.log("\n\x1b[1m═══════════════════════════════════════════════════════════════════\x1b[0m\n");
}
