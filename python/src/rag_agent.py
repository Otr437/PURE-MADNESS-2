"""
RAG Agent v2 — Python
Wires RAGEngine (hybrid search, reranking, citations) + document loaders
into the multi-provider ReAct loop (react_loop.py / model_router.py).

pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...   (or DEEPSEEK_API_KEY / OPENAI_API_KEY + MODEL_PROVIDER)
export VOYAGE_API_KEY=...
export QDRANT_URL=http://localhost:6333   (or unset for in-memory)

CLI:
    python src/rag_agent.py "question"                       # built-in demo docs
    python src/rag_agent.py --dir ./mydocs "question"        # ingest a directory first
"""

import argparse
import json
import os
import sys

from qdrant_client import QdrantClient

from loaders import load_directory
from rag_engine import Document, RAGEngine, make_rag_tool
from react_loop import TOOL_REGISTRY, TOOL_SCHEMAS, run_react

# ── Wire RAG tool into the react_loop tool registry ───────────────────────────
_qdrant_url = os.environ.get("QDRANT_URL", ":memory:")
_qdrant = QdrantClient(":memory:") if _qdrant_url == ":memory:" else QdrantClient(url=_qdrant_url)
_engine = RAGEngine("default", qdrant=_qdrant)

_rag_schema, _rag_fn = make_rag_tool(_engine)
if not any(s["name"] == "rag_search" for s in TOOL_SCHEMAS):
    TOOL_SCHEMAS.append(_rag_schema)
    TOOL_REGISTRY["rag_search"] = _rag_fn


RAG_SYSTEM_PROMPT = (
    "You have access to a 'rag_search' tool that searches a knowledge base of "
    "ingested documents using hybrid (dense + sparse) retrieval with reranking. "
    "Results include citation markers like [source_id:chunk_idx]. "
    "Use rag_search to find relevant context before answering factual questions. "
    "When you use retrieved information in your answer, cite the source using the "
    "citation marker provided. Always search first, reason second, then answer."
)


def ingest_and_run(
    documents: list[Document],
    task: str,
    system_extra: str = "",
    max_iterations: int = 30,
    verbose: bool = True,
) -> tuple[str, dict]:
    """
    Ingest documents into the RAG engine, then run the ReAct agent on a task.

    Returns:
        (answer: str, report: dict with trace/tokens/elapsed/chunk_count)
    """
    chunk_count = _engine.ingest(documents) if documents else 0
    info = _engine.collection_info()
    print(
        f"\n[rag-agent] Ingested {len(documents)} docs → {chunk_count} chunks "
        f"(collection: {info['name']}, total points: {info['points']})\n",
        file=sys.stderr,
    )

    combined_system = RAG_SYSTEM_PROMPT + ("\n\n" + system_extra if system_extra else "")

    def on_step(step):
        if not verbose:
            return
        if step.type == "thought":
            print(f"\n💭 THOUGHT\n{step.content[:300]}")
        elif step.type == "action":
            inp = json.dumps(getattr(step, "input", {}))
            tool = getattr(step, "tool", "?")
            print(f"\n⚡ ACTION  {tool}\n{inp[:200]}")
        elif step.type == "observation":
            prefix = "❌ ERROR" if step.is_error else "👁 OBSERVE"
            print(f"\n{prefix}\n{step.content[:300]}")

    answer, trace = run_react(
        task=task,
        system_extra=combined_system,
        max_iterations=max_iterations,
        on_step=on_step,
    )

    report = {
        "answer":       answer,
        "iterations":   trace.iterations,
        "total_tokens": trace.total_tokens,
        "elapsed_s":    trace.elapsed_s,
        "chunk_count":  chunk_count,
        "trace":        trace.to_dict(),
    }
    return answer, report


# ── CLI entry point ───────────────────────────────────────────────────────────
def _default_docs() -> list[Document]:
    return [
        Document(
            content=(
                "The Anthropic Model Specification defines how Claude should behave. "
                "It covers honesty, helpfulness, and harm avoidance. "
                "Claude is trained to follow instructions while maintaining ethical boundaries."
            ),
            metadata={"source": "anthropic_spec"},
        ),
        Document(
            content=(
                "ReAct is a prompting technique combining Reasoning and Acting. "
                "The model interleaves chain-of-thought with tool calls. "
                "Each tool observation is fed back into the context for the next reasoning step."
            ),
            metadata={"source": "react_paper"},
        ),
        Document(
            content=(
                "Vector databases store embeddings as high-dimensional float vectors. "
                "Similarity search uses cosine distance or dot product to find nearest neighbours. "
                "HNSW (Hierarchical Navigable Small World) is the most common indexing algorithm."
            ),
            metadata={"source": "vector_db_primer"},
        ),
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="RAG Agent CLI")
    parser.add_argument("task", nargs="*", help="Task / question for the agent")
    parser.add_argument("--dir", dest="directory", help="Directory of documents to ingest first")
    parser.add_argument("--max-iterations", type=int, default=30)
    parser.add_argument("--quiet", action="store_true", help="Suppress step trace")
    args = parser.parse_args()

    if args.directory:
        documents = load_directory(args.directory)
        if not documents:
            print(f"[rag-agent] No supported documents found in {args.directory}", file=sys.stderr)
    else:
        documents = _default_docs()

    task = " ".join(args.task) or "Explain how the ReAct pattern works and how it relates to RAG."

    answer, report = ingest_and_run(
        documents, task,
        max_iterations=args.max_iterations,
        verbose=not args.quiet,
    )

    print("\n" + "=" * 64)
    print("FINAL ANSWER")
    print("=" * 64)
    print(answer)
    print("=" * 64)
    print(
        f"Iterations: {report['iterations']} | Tokens: {report['total_tokens']} | "
        f"Time: {report['elapsed_s']}s | Chunks in KB: {report['chunk_count']}"
    )


if __name__ == "__main__":
    main()
