/**
 * RAG Agent — TypeScript
 * Wires RAGEngine into the ReAct loop so the agent can search its knowledge base.
 *
 * npx ts-node rag_agent.ts "your question"
 */

import * as process from "process";
import { RAGEngine, Document, makeRagTool } from "./rag_engine";
import { toolRegistry, toolSchemas, runReact } from "./react_loop";

// ── Build and register the RAG tool ───────────────────────────────────────────
const engine = new RAGEngine("default");
const { schema: ragSchema, fn: ragFn } = makeRagTool(engine);
toolSchemas.push(ragSchema as any);
toolRegistry.set("rag_search", ({ query, top_k }: { query: string; top_k?: number }) =>
  ragFn({ query, top_k })
);

// ── RAG Agent entry point ─────────────────────────────────────────────────────
export async function ingestAndRun(
  documents: Document[],
  task: string,
  options: { systemExtra?: string; maxIterations?: number; verbose?: boolean } = {},
): Promise<{ answer: string; report: Record<string, unknown> }> {
  const { systemExtra = "", maxIterations = 30, verbose = true } = options;

  const chunkCount = await engine.ingest(documents);
  const info = await engine.collectionInfo();
  console.error(
    `[rag-agent] Ingested ${documents.length} docs → ${chunkCount} chunks ` +
    `(collection: ${info.name}, total points: ${info.points})`
  );

  const ragSystem =
    "You have access to a 'rag_search' tool that searches a knowledge base. " +
    "Use it to find relevant context before answering factual questions. " +
    "Always search first, reason second, then answer.";
  const combinedSystem = ragSystem + (systemExtra ? "\n\n" + systemExtra : "");

  const onStep = verbose
    ? (step: any) => {
        if (step.type === "thought") {
          process.stdout.write(`\n💭 THOUGHT\n${String(step.content).slice(0, 300)}\n`);
        } else if (step.type === "action") {
          process.stdout.write(
            `\n⚡ ACTION  ${step.tool}\n${JSON.stringify(step.input).slice(0, 200)}\n`
          );
        } else if (step.type === "observation") {
          const label = step.error ? "❌ ERROR" : "👁 OBSERVE";
          process.stdout.write(`\n${label}\n${String(step.content).slice(0, 300)}\n`);
        }
      }
    : undefined;

  const { answer, trace } = await runReact(task, {
    systemExtra:   combinedSystem,
    maxIterations,
    onStep,
  });

  const report = {
    answer,
    iterations:   trace.iterations,
    totalTokens:  trace.totalTokens,
    elapsedMs:    trace.elapsedMs,
    chunkCount,
    steps:        trace.steps.length,
  };
  return { answer, report };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const sampleDocs: Document[] = [
    {
      content:
        "The ReAct pattern combines chain-of-thought reasoning with tool-use actions. " +
        "At each step the model emits a Thought, selects an Action, and observes the result.",
      metadata: { source: "react_paper" },
    },
    {
      content:
        "Retrieval-Augmented Generation (RAG) augments an LLM with an external knowledge base. " +
        "Documents are chunked, embedded, and stored in a vector database. " +
        "Queries retrieve the nearest-neighbour chunks which are prepended to the prompt.",
      metadata: { source: "rag_survey" },
    },
    {
      content:
        "TypeScript adds static types to JavaScript, catching bugs at compile time. " +
        "It supports interfaces, generics, union types, and decorators.",
      metadata: { source: "ts_docs" },
    },
  ];

  const task =
    process.argv.slice(2).join(" ") ||
    "Explain what RAG is and how the ReAct pattern relates to it.";

  ingestAndRun(sampleDocs, task)
    .then(({ answer, report }) => {
      process.stdout.write(`\n${"=".repeat(64)}\nFINAL ANSWER\n${"=".repeat(64)}\n`);
      process.stdout.write(answer + "\n");
      process.stdout.write(`${"=".repeat(64)}\n`);
      process.stdout.write(
        `Iterations: ${report.iterations} | Tokens: ${report.totalTokens} | ` +
        `Chunks: ${report.chunkCount}\n`
      );
    })
    .catch((err) => {
      process.stderr.write(`[rag-agent] ERROR: ${err}\n`);
      process.exit(1);
    });
}
