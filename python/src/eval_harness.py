"""
Eval Harness — Python
Measures retrieval quality of the RAG engine against a labelled test set.

Metrics:
  - Precision@K  : fraction of retrieved chunks that are relevant
  - Recall@K     : fraction of relevant chunks that were retrieved
  - MRR          : Mean Reciprocal Rank (first relevant result position)
  - NDCG@K       : Normalized Discounted Cumulative Gain

Usage:
    python src/eval_harness.py
    python src/eval_harness.py --top-k 10 --collection eval
"""

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass, field
from typing import Callable

from qdrant_client import QdrantClient

from rag_engine import Document, RAGEngine


# ── Test case definition ───────────────────────────────────────────────────────
@dataclass
class EvalCase:
    """
    A single eval case: a query paired with the set of doc_ids that are
    considered relevant (ground truth). At least one retrieved chunk from a
    relevant doc_id counts as a hit.
    """
    query:        str
    relevant_ids: set[str]          # set of relevant doc_ids (ground truth)
    description:  str = ""


@dataclass
class EvalResult:
    case:         EvalCase
    retrieved:    list              # list[RetrievedChunk]
    precision_at_k: float
    recall_at_k:  float
    reciprocal_rank: float
    ndcg_at_k:    float

    def to_dict(self) -> dict:
        return {
            "query":            self.case.query,
            "relevant_ids":     list(self.case.relevant_ids),
            "precision_at_k":   round(self.precision_at_k, 4),
            "recall_at_k":      round(self.recall_at_k, 4),
            "reciprocal_rank":  round(self.reciprocal_rank, 4),
            "ndcg_at_k":        round(self.ndcg_at_k, 4),
            "retrieved_doc_ids": [c.doc_id for c in self.retrieved],
        }


@dataclass
class EvalReport:
    results:      list[EvalResult]
    top_k:        int
    mean_precision: float = field(init=False)
    mean_recall:    float = field(init=False)
    mean_mrr:       float = field(init=False)
    mean_ndcg:      float = field(init=False)

    def __post_init__(self):
        n = len(self.results)
        if n == 0:
            self.mean_precision = self.mean_recall = self.mean_mrr = self.mean_ndcg = 0.0
            return
        self.mean_precision = sum(r.precision_at_k   for r in self.results) / n
        self.mean_recall    = sum(r.recall_at_k      for r in self.results) / n
        self.mean_mrr       = sum(r.reciprocal_rank  for r in self.results) / n
        self.mean_ndcg      = sum(r.ndcg_at_k        for r in self.results) / n

    def to_dict(self) -> dict:
        return {
            "top_k":          self.top_k,
            "num_cases":      len(self.results),
            "mean_precision": round(self.mean_precision, 4),
            "mean_recall":    round(self.mean_recall, 4),
            "mean_mrr":       round(self.mean_mrr, 4),
            "mean_ndcg":      round(self.mean_ndcg, 4),
            "per_case":       [r.to_dict() for r in self.results],
        }

    def print_summary(self) -> None:
        print(f"\n{'='*60}")
        print(f"RAG Eval Report  (top_k={self.top_k}, n={len(self.results)})")
        print(f"{'='*60}")
        print(f"  Mean Precision@{self.top_k}: {self.mean_precision:.4f}")
        print(f"  Mean Recall@{self.top_k}:    {self.mean_recall:.4f}")
        print(f"  Mean MRR:               {self.mean_mrr:.4f}")
        print(f"  Mean NDCG@{self.top_k}:      {self.mean_ndcg:.4f}")
        print(f"{'='*60}")
        for r in self.results:
            status = "✅" if r.precision_at_k > 0 else "❌"
            print(f"  {status} [{r.precision_at_k:.2f}P / {r.recall_at_k:.2f}R / {r.reciprocal_rank:.2f}MRR]  {r.case.query[:60]}")
        print()


# ── Metric calculations ────────────────────────────────────────────────────────
def _precision_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    top_k = retrieved_ids[:k]
    hits = sum(1 for rid in top_k if rid in relevant_ids)
    return hits / k if k > 0 else 0.0


def _recall_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    if not relevant_ids:
        return 0.0
    top_k = retrieved_ids[:k]
    hits = sum(1 for rid in top_k if rid in relevant_ids)
    return hits / len(relevant_ids)


def _reciprocal_rank(retrieved_ids: list[str], relevant_ids: set[str]) -> float:
    for i, rid in enumerate(retrieved_ids, 1):
        if rid in relevant_ids:
            return 1.0 / i
    return 0.0


def _ndcg_at_k(retrieved_ids: list[str], relevant_ids: set[str], k: int) -> float:
    def dcg(ids: list[str]) -> float:
        score = 0.0
        for i, rid in enumerate(ids[:k], 1):
            rel = 1.0 if rid in relevant_ids else 0.0
            score += rel / math.log2(i + 1)
        return score

    actual_dcg  = dcg(retrieved_ids)
    ideal_ids   = [rid for rid in retrieved_ids if rid in relevant_ids]
    ideal_ids  += ["__relevant__"] * max(0, len(relevant_ids) - len(ideal_ids))
    ideal_dcg   = dcg(ideal_ids)
    return actual_dcg / ideal_dcg if ideal_dcg > 0 else 0.0


# ── Evaluator ─────────────────────────────────────────────────────────────────
class RAGEvaluator:
    def __init__(self, engine: RAGEngine, top_k: int = 5):
        self.engine = engine
        self.top_k  = top_k

    def evaluate_case(self, case: EvalCase) -> EvalResult:
        chunks = self.engine.retrieve(case.query, top_k=self.top_k)
        retrieved_ids = [c.doc_id for c in chunks]
        return EvalResult(
            case=case,
            retrieved=chunks,
            precision_at_k=_precision_at_k(retrieved_ids, case.relevant_ids, self.top_k),
            recall_at_k=_recall_at_k(retrieved_ids, case.relevant_ids, self.top_k),
            reciprocal_rank=_reciprocal_rank(retrieved_ids, case.relevant_ids),
            ndcg_at_k=_ndcg_at_k(retrieved_ids, case.relevant_ids, self.top_k),
        )

    def evaluate(self, cases: list[EvalCase]) -> EvalReport:
        results = [self.evaluate_case(c) for c in cases]
        return EvalReport(results=results, top_k=self.top_k)


# ── Built-in demo test set ────────────────────────────────────────────────────
_DEMO_DOCS = [
    Document(content="Claude is an AI assistant made by Anthropic.", metadata={"source": "anthropic"}),
    Document(content="RAG combines retrieval with generation to ground LLM answers in real documents.", metadata={"source": "rag_paper"}),
    Document(content="Qdrant is a high-performance vector database written in Rust.", metadata={"source": "qdrant"}),
    Document(content="Voyage AI provides state-of-the-art embedding and reranking models.", metadata={"source": "voyage"}),
    Document(content="Python is a popular programming language for AI and data science.", metadata={"source": "python"}),
]


def _build_demo_cases(docs: list[Document]) -> list[EvalCase]:
    id_map = {d.metadata["source"]: d.doc_id for d in docs}
    return [
        EvalCase("What is Claude?", {id_map["anthropic"]}, "Anthropic query"),
        EvalCase("How does RAG work?", {id_map["rag_paper"]}, "RAG query"),
        EvalCase("What is Qdrant?", {id_map["qdrant"]}, "Qdrant query"),
        EvalCase("Which company makes embedding models?", {id_map["voyage"]}, "Voyage query"),
        EvalCase("What language is used for AI?", {id_map["python"]}, "Python query"),
    ]


# ── CLI ───────────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="RAG Eval Harness")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--collection", default="eval")
    parser.add_argument("--output-json", help="Write full report to this JSON file")
    args = parser.parse_args()

    qdrant = QdrantClient(":memory:")
    engine = RAGEngine(args.collection, qdrant=qdrant)

    docs = _DEMO_DOCS
    engine.ingest(docs)
    cases = _build_demo_cases(docs)

    evaluator = RAGEvaluator(engine, top_k=args.top_k)
    report = evaluator.evaluate(cases)
    report.print_summary()

    if args.output_json:
        with open(args.output_json, "w", encoding="utf-8") as f:
            json.dump(report.to_dict(), f, indent=2)
        print(f"Full report written to {args.output_json}")


if __name__ == "__main__":
    main()
