/**
 * Eval Harness — TypeScript
 * Measures retrieval quality: Precision@K, Recall@K, MRR, NDCG@K.
 *
 * npx ts-node src/eval_harness.ts
 */

import { RAGEngine, Document, RetrievedChunk } from "./rag_engine";

export interface EvalCase {
  query:       string;
  relevantIds: Set<string>;
  description: string;
}

export interface EvalResult {
  caseQuery:      string;
  precisionAtK:   number;
  recallAtK:      number;
  reciprocalRank: number;
  ndcgAtK:        number;
  retrievedIds:   string[];
}

export interface EvalReport {
  topK:           number;
  numCases:       number;
  meanPrecision:  number;
  meanRecall:     number;
  meanMrr:        number;
  meanNdcg:       number;
  perCase:        EvalResult[];
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (k === 0) return 0;
  const hits = retrieved.slice(0, k).filter((id) => relevant.has(id)).length;
  return hits / k;
}

function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (!relevant.size) return 0;
  const hits = retrieved.slice(0, k).filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

function reciprocalRank(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

function ndcgAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const dcg = (ids: string[]): number => {
    let score = 0;
    ids.slice(0, k).forEach((id, i) => {
      if (relevant.has(id)) score += 1 / Math.log2(i + 2);
    });
    return score;
  };
  const actualDcg = dcg(retrieved);
  const ideal     = [...retrieved.filter((id) => relevant.has(id)), ...Array(relevant.size).fill("__rel__")];
  const idealDcg  = dcg(ideal);
  return idealDcg > 0 ? actualDcg / idealDcg : 0;
}

// ── Evaluator ─────────────────────────────────────────────────────────────────
export class RAGEvaluator {
  constructor(private engine: RAGEngine, private topK = 5) {}

  async evaluateCase(evalCase: EvalCase): Promise<EvalResult> {
    const chunks = await this.engine.retrieve(evalCase.query, this.topK);
    const ids    = chunks.map((c) => c.docId);
    return {
      caseQuery:      evalCase.query,
      precisionAtK:   precisionAtK(ids, evalCase.relevantIds, this.topK),
      recallAtK:      recallAtK(ids, evalCase.relevantIds, this.topK),
      reciprocalRank: reciprocalRank(ids, evalCase.relevantIds),
      ndcgAtK:        ndcgAtK(ids, evalCase.relevantIds, this.topK),
      retrievedIds:   ids,
    };
  }

  async evaluate(cases: EvalCase[]): Promise<EvalReport> {
    const results = await Promise.all(cases.map((c) => this.evaluateCase(c)));
    const n = results.length || 1;
    return {
      topK:          this.topK,
      numCases:      results.length,
      meanPrecision: results.reduce((s, r) => s + r.precisionAtK,   0) / n,
      meanRecall:    results.reduce((s, r) => s + r.recallAtK,      0) / n,
      meanMrr:       results.reduce((s, r) => s + r.reciprocalRank, 0) / n,
      meanNdcg:      results.reduce((s, r) => s + r.ndcgAtK,        0) / n,
      perCase:       results,
    };
  }
}

// ── Demo data ─────────────────────────────────────────────────────────────────
const DEMO_DOCS: Document[] = [
  { content: "Claude is an AI assistant made by Anthropic.", metadata: { source: "anthropic" } },
  { content: "RAG combines retrieval with generation to ground LLM answers.", metadata: { source: "rag_paper" } },
  { content: "Qdrant is a high-performance vector database written in Rust.", metadata: { source: "qdrant" } },
  { content: "Voyage AI provides state-of-the-art embedding and reranking models.", metadata: { source: "voyage" } },
  { content: "TypeScript is a statically typed superset of JavaScript.", metadata: { source: "typescript" } },
];

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const qdrant = new QdrantClient({ url: "http://localhost:6333" });
    const engine = new RAGEngine("eval_ts");
    await engine.ingest(DEMO_DOCS);

    const cases: EvalCase[] = DEMO_DOCS.map((d) => ({
      query:       `Tell me about ${d.metadata.source}`,
      relevantIds: new Set([d.docId ?? ""]),
      description: d.metadata.source,
    }));

    const evaluator = new RAGEvaluator(engine, 5);
    const report    = await evaluator.evaluate(cases);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`RAG Eval (TypeScript)  top_k=${report.topK}  n=${report.numCases}`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Mean Precision@${report.topK}: ${report.meanPrecision.toFixed(4)}`);
    console.log(`  Mean Recall@${report.topK}:    ${report.meanRecall.toFixed(4)}`);
    console.log(`  Mean MRR:               ${report.meanMrr.toFixed(4)}`);
    console.log(`  Mean NDCG@${report.topK}:      ${report.meanNdcg.toFixed(4)}`);
    console.log();
    report.perCase.forEach((r) => {
      const ok = r.precisionAtK > 0 ? "✅" : "❌";
      console.log(`  ${ok} [P=${r.precisionAtK.toFixed(2)} R=${r.recallAtK.toFixed(2)} MRR=${r.reciprocalRank.toFixed(2)}]  ${r.caseQuery.slice(0, 60)}`);
    });
  })().catch(console.error);
}
