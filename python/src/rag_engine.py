"""
RAG Engine v2 — Python
Document ingestion, hybrid (dense + sparse) retrieval, reranking, citations, caching.

pip install qdrant-client==1.18.0 httpx==0.28.1 tenacity==9.1.2 structlog==24.4.0

Required env vars:
  VOYAGE_API_KEY   = Voyage AI API key (https://www.voyageai.com) — embeddings + reranking
  QDRANT_URL       = http://localhost:6333  (omit / use ":memory:" for in-process)
  QDRANT_API_KEY   = optional, for Qdrant Cloud
"""

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import structlog
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    PointStruct,
    VectorParams,
    SparseVectorParams,
    SparseVector,
    NamedVector,
    NamedSparseVector,
    Modifier,
)
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

structlog.configure(processors=[
    structlog.processors.TimeStamper(fmt="iso"),
    structlog.processors.add_log_level,
    structlog.processors.JSONRenderer(),
])
log = structlog.get_logger()

# ── Config ────────────────────────────────────────────────────────────────────
VOYAGE_API_BASE   = "https://api.voyageai.com/v1"
EMBEDDING_MODEL   = os.environ.get("VOYAGE_EMBED_MODEL", "voyage-3.5")
RERANK_MODEL      = os.environ.get("VOYAGE_RERANK_MODEL", "rerank-2.5")
EMBEDDING_DIM     = 1024
COLLECTION_PREFIX = "rag_"
DEFAULT_TOP_K     = 5
DEFAULT_FETCH_K   = 20      # candidates fetched before rerank
CHUNK_SIZE        = 800
CHUNK_OVERLAP     = 120
DENSE_VEC_NAME    = "dense"
SPARSE_VEC_NAME   = "sparse"
CACHE_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days

_http = httpx.Client(timeout=60.0)


# ── Safe JSON-file embedding cache ────────────────────────────────────────────
#
# diskcache uses pickle by default and has an unpatched deserialization RCE
# (CVE-2025-69872, affects all versions <= 5.6.3, no fix available). To avoid
# that risk entirely, embeddings are cached as plain JSON files on disk —
# JSON cannot execute code on load, so this is safe even if the cache
# directory is ever shared or writable by another process.
class _JsonFileCache:
    """Minimal, dependency-free, RCE-safe disk cache backed by JSON files."""

    def __init__(self, directory: str):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        digest = hashlib.sha256(key.encode()).hexdigest()
        # Two-level sharding to avoid huge flat directories
        return self.dir / digest[:2] / f"{digest}.json"

    def get(self, key: str):
        path = self._path(key)
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                record = json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
        if record.get("expires_at", 0) < time.time():
            try:
                path.unlink()
            except OSError:
                pass
            return None
        return record.get("value")

    def set(self, key: str, value, expire: int = CACHE_TTL_SECONDS) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {"value": value, "expires_at": time.time() + expire}
        tmp_path = path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(record, f)
        tmp_path.replace(path)  # atomic on POSIX


_CACHE_DIR = os.environ.get("RAG_CACHE_DIR", os.path.join(os.getcwd(), ".rag_cache"))
_cache = _JsonFileCache(_CACHE_DIR)


def _qdrant_client() -> QdrantClient:
    url = os.environ.get("QDRANT_URL", ":memory:")
    api_key = os.environ.get("QDRANT_API_KEY") or None
    if url == ":memory:":
        return QdrantClient(":memory:")
    return QdrantClient(url=url, api_key=api_key, timeout=30)


# ── Document / Chunk models ───────────────────────────────────────────────────
@dataclass
class Document:
    content: str
    metadata: dict = field(default_factory=dict)
    doc_id:   str  = ""

    def __post_init__(self):
        if not self.doc_id:
            self.doc_id = hashlib.sha256(self.content.encode()).hexdigest()[:16]


@dataclass
class Chunk:
    text:     str
    doc_id:   str
    chunk_idx: int
    metadata: dict = field(default_factory=dict)
    chunk_id: str  = ""

    def __post_init__(self):
        if not self.chunk_id:
            self.chunk_id = hashlib.sha256(
                f"{self.doc_id}:{self.chunk_idx}".encode()
            ).hexdigest()[:16]


@dataclass
class RetrievedChunk:
    text:     str
    score:    float
    doc_id:   str
    chunk_idx: int
    metadata: dict
    citation: str = ""   # e.g. "[source.pdf, p.3, chunk 2]"


# ── Semantic / recursive chunking ─────────────────────────────────────────────
_SPLIT_PATTERNS = [
    re.compile(r"\n#{1,6}\s"),     # markdown headings
    re.compile(r"\n\n+"),          # paragraph breaks
    re.compile(r"(?<=[.!?])\s+"),  # sentence boundaries
    re.compile(r"\s+"),            # whitespace fallback
]


def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """
    Recursive/semantic chunking: tries to split on headings, then paragraphs,
    then sentences, then whitespace — whichever keeps chunks closest to
    `chunk_size` without exceeding it, with `overlap` characters of context
    carried into the next chunk.
    """
    text = text.strip()
    if len(text) <= chunk_size:
        return [text] if text else []

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        window = text[start:end]

        if end < len(text):
            best_pos = -1
            for pattern in _SPLIT_PATTERNS:
                matches = list(pattern.finditer(window))
                for m in reversed(matches):
                    if m.start() > chunk_size * 0.4:
                        best_pos = m.start()
                        break
                if best_pos != -1:
                    break
            if best_pos != -1:
                end = start + best_pos

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        if end <= start:
            end = start + chunk_size  # safety: force progress
        next_start = end - overlap
        start = next_start if next_start > start else end

    return chunks


# ── Sparse (BM25-ish) term vectors for hybrid search ──────────────────────────
_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
    "is", "are", "was", "were", "be", "been", "with", "as", "by", "this", "that",
    "it", "from", "into", "their", "its", "such", "can", "will", "would",
}


def _tokenize(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in _STOPWORDS and len(t) > 1]


def sparse_vector(text: str) -> SparseVector:
    """
    Produce a term-frequency sparse vector over a fixed hashing vocabulary
    (hashing trick, 2^18 buckets) — enables hybrid dense+sparse search in
    Qdrant without needing an external BM25 index.
    """
    tokens = _tokenize(text)
    if not tokens:
        return SparseVector(indices=[], values=[])
    counts: dict[int, float] = {}
    vocab_size = 2 ** 18
    for tok in tokens:
        idx = int(hashlib.md5(tok.encode()).hexdigest(), 16) % vocab_size
        counts[idx] = counts.get(idx, 0.0) + 1.0
    # log-scaled term frequency
    import math
    indices = list(counts.keys())
    values = [1.0 + math.log(v) for v in counts.values()]
    return SparseVector(indices=indices, values=values)


# ── Embedding (Voyage AI) with disk cache ─────────────────────────────────────
@retry(
    retry=retry_if_exception_type((httpx.ConnectError, httpx.ReadTimeout, httpx.HTTPStatusError)),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    stop=stop_after_attempt(5),
)
def _voyage_embed_batch(texts: list[str], input_type: str) -> list[list[float]]:
    api_key = os.environ.get("VOYAGE_API_KEY")
    if not api_key:
        raise RuntimeError("VOYAGE_API_KEY is not set. Get one at https://www.voyageai.com")

    resp = _http.post(
        f"{VOYAGE_API_BASE}/embeddings",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": EMBEDDING_MODEL, "input": texts, "input_type": input_type},
    )
    resp.raise_for_status()
    data = resp.json()
    return [item["embedding"] for item in data["data"]]


def embed_texts(texts: list[str], input_type: str = "document") -> list[list[float]]:
    """
    Embed texts via Voyage AI, with a persistent disk cache keyed on
    (model, input_type, sha256(text)).

    input_type: "document" when embedding chunks for storage,
                "query" when embedding a search query (Voyage tunes each
                differently for retrieval quality).
    """
    results: list[list[float] | None] = [None] * len(texts)
    to_fetch: list[tuple[int, str]] = []

    for i, text in enumerate(texts):
        key = f"emb:{EMBEDDING_MODEL}:{input_type}:{hashlib.sha256(text.encode()).hexdigest()}"
        cached = _cache.get(key)
        if cached is not None:
            results[i] = cached
        else:
            to_fetch.append((i, text))

    if to_fetch:
        batch_texts = [t for _, t in to_fetch]
        vectors = _voyage_embed_batch(batch_texts, input_type)
        for (i, text), vec in zip(to_fetch, vectors):
            results[i] = vec
            key = f"emb:{EMBEDDING_MODEL}:{input_type}:{hashlib.sha256(text.encode()).hexdigest()}"
            _cache.set(key, vec, expire=60 * 60 * 24 * 30)  # 30 days

    return results  # type: ignore[return-value]


# ── Reranking (Voyage AI) ──────────────────────────────────────────────────────
@retry(
    retry=retry_if_exception_type((httpx.ConnectError, httpx.ReadTimeout, httpx.HTTPStatusError)),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    stop=stop_after_attempt(5),
)
def rerank(query: str, documents: list[str], top_k: int) -> list[tuple[int, float]]:
    """
    Rerank `documents` against `query` using Voyage AI's rerank endpoint.
    Returns list of (original_index, relevance_score), sorted by score desc.
    """
    api_key = os.environ.get("VOYAGE_API_KEY")
    if not api_key:
        # Fallback: no reranking available, preserve original order with score=1.0
        return [(i, 1.0) for i in range(min(top_k, len(documents)))]

    resp = _http.post(
        f"{VOYAGE_API_BASE}/rerank",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": RERANK_MODEL, "query": query, "documents": documents, "top_k": top_k},
    )
    resp.raise_for_status()
    data = resp.json()
    return [(item["index"], item["relevance_score"]) for item in data["results"]]


# ── RAG Engine ────────────────────────────────────────────────────────────────
class RAGEngine:
    """
    Manages a Qdrant collection with hybrid (dense + sparse) vectors,
    Voyage AI embeddings + reranking, semantic chunking, and citation tracking.
    """

    def __init__(self, collection_name: str, qdrant: QdrantClient | None = None):
        self.collection_name = COLLECTION_PREFIX + collection_name
        self._qdrant = qdrant or _qdrant_client()
        self._ensure_collection()

    def _ensure_collection(self) -> None:
        existing = {c.name for c in self._qdrant.get_collections().collections}
        if self.collection_name not in existing:
            self._qdrant.create_collection(
                collection_name=self.collection_name,
                vectors_config={
                    DENSE_VEC_NAME: VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
                },
                sparse_vectors_config={
                    SPARSE_VEC_NAME: SparseVectorParams(modifier=Modifier.IDF),
                },
            )
            log.info("rag.collection_created", name=self.collection_name)

    # ── Ingest ─────────────────────────────────────────────────────────────────

    def ingest(self, documents: list[Document], batch_size: int = 32) -> int:
        """Chunk, embed (dense + sparse), and upsert all documents. Returns chunk count."""
        all_chunks: list[Chunk] = []
        for doc in documents:
            raw_chunks = chunk_text(doc.content)
            for i, text in enumerate(raw_chunks):
                all_chunks.append(Chunk(
                    text=text,
                    doc_id=doc.doc_id,
                    chunk_idx=i,
                    metadata={**doc.metadata, "source_doc_id": doc.doc_id},
                ))

        log.info("rag.ingest_start", docs=len(documents), chunks=len(all_chunks))

        for batch_start in range(0, len(all_chunks), batch_size):
            batch = all_chunks[batch_start: batch_start + batch_size]
            texts = [c.text for c in batch]
            dense_vectors = embed_texts(texts, input_type="document")

            points = [
                PointStruct(
                    id=int(c.chunk_id, 16) % (2 ** 63),
                    vector={
                        DENSE_VEC_NAME:  dense_vectors[i],
                        SPARSE_VEC_NAME: sparse_vector(c.text),
                    },
                    payload={
                        "text":      c.text,
                        "doc_id":    c.doc_id,
                        "chunk_idx": c.chunk_idx,
                        "metadata":  json.dumps(c.metadata),
                    },
                )
                for i, c in enumerate(batch)
            ]
            self._qdrant.upsert(collection_name=self.collection_name, points=points)
            log.info("rag.batch_upserted", batch=batch_start // batch_size + 1, count=len(points))

        return len(all_chunks)

    # ── Hybrid retrieval + reranking ──────────────────────────────────────────

    def retrieve(
        self,
        query: str,
        top_k: int = DEFAULT_TOP_K,
        fetch_k: int = DEFAULT_FETCH_K,
        use_reranking: bool = True,
    ) -> list[RetrievedChunk]:
        """
        1. Embed query (dense) + build sparse vector.
        2. Fetch `fetch_k` candidates from each of dense and sparse search.
        3. Merge + dedupe candidates.
        4. Rerank with Voyage AI rerank-2.5, keep top `top_k`.
        """
        query_dense = embed_texts([query], input_type="query")[0]
        query_sparse = sparse_vector(query)

        dense_hits = self._qdrant.search(
            collection_name=self.collection_name,
            query_vector=NamedVector(name=DENSE_VEC_NAME, vector=query_dense),
            limit=fetch_k,
            with_payload=True,
        )
        sparse_hits = self._qdrant.search(
            collection_name=self.collection_name,
            query_vector=NamedSparseVector(name=SPARSE_VEC_NAME, vector=query_sparse),
            limit=fetch_k,
            with_payload=True,
        )

        # Merge + dedupe by point ID
        merged: dict[int, any] = {}
        for hit in dense_hits + sparse_hits:
            if hit.id not in merged:
                merged[hit.id] = hit

        candidates = list(merged.values())
        if not candidates:
            return []

        if use_reranking and len(candidates) > 1:
            texts = [c.payload["text"] for c in candidates]
            ranked = rerank(query, texts, top_k=min(top_k, len(candidates)))
            ordered = [(candidates[idx], score) for idx, score in ranked]
        else:
            ordered = [(c, c.score) for c in candidates[:top_k]]

        results = []
        for hit, score in ordered:
            payload = hit.payload
            metadata = json.loads(payload.get("metadata", "{}"))
            results.append(RetrievedChunk(
                text=payload["text"],
                score=float(score),
                doc_id=payload["doc_id"],
                chunk_idx=payload["chunk_idx"],
                metadata=metadata,
                citation=self._build_citation(metadata, payload["chunk_idx"]),
            ))
        return results

    @staticmethod
    def _build_citation(metadata: dict, chunk_idx: int) -> str:
        source = metadata.get("source", metadata.get("source_doc_id", "unknown"))
        parts = [str(source)]
        if "page_count" in metadata:
            parts.append(f"chunk {chunk_idx + 1}")
        else:
            parts.append(f"chunk {chunk_idx + 1}")
        return f"[{', '.join(parts)}]"

    def retrieve_as_context(self, query: str, top_k: int = DEFAULT_TOP_K) -> str:
        """Return retrieved chunks formatted as a context block with inline citations."""
        chunks = self.retrieve(query, top_k=top_k)
        if not chunks:
            return "No relevant context found."
        parts = [
            f"{c.citation} (score={c.score:.3f}) {c.text}"
            for c in chunks
        ]
        return "\n\n".join(parts)

    # ── Deletion / management ─────────────────────────────────────────────────

    def delete_document(self, doc_id: str) -> None:
        from qdrant_client.models import Filter, FieldCondition, MatchValue
        self._qdrant.delete(
            collection_name=self.collection_name,
            points_selector=Filter(
                must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))]
            ),
        )
        log.info("rag.document_deleted", doc_id=doc_id)

    def drop_collection(self) -> None:
        self._qdrant.delete_collection(self.collection_name)
        log.info("rag.collection_dropped", name=self.collection_name)

    def collection_info(self) -> dict:
        info = self._qdrant.get_collection(self.collection_name)
        return {
            "name":   self.collection_name,
            "points": info.points_count,
            "status": str(info.status),
        }


# ── RAG-aware tool for agent loops ────────────────────────────────────────────
def make_rag_tool(engine: RAGEngine) -> tuple[dict, callable]:
    schema = {
        "name": "rag_search",
        "description": (
            "Search the knowledge base for context relevant to a query using hybrid "
            "dense+sparse retrieval with reranking. Returns top matching passages "
            "with citations."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "top_k": {"type": "integer", "description": "Number of results (default 5)"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    }

    def fn(query: str, top_k: int = DEFAULT_TOP_K) -> str:
        return engine.retrieve_as_context(query, top_k=top_k)

    return schema, fn


# ── CLI demo ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    engine = RAGEngine("demo", qdrant=QdrantClient(":memory:"))

    docs = [
        Document(
            content=(
                "Claude is a large language model made by Anthropic. "
                "It is designed to be helpful, harmless, and honest. "
                "Claude can write code, answer questions, and reason through complex problems."
            ),
            metadata={"source": "anthropic_docs.md", "topic": "claude"},
        ),
        Document(
            content=(
                "RAG stands for Retrieval-Augmented Generation. "
                "It combines a retrieval system with a generative model. "
                "Documents are split into chunks, embedded, and stored in a vector database. "
                "At inference time, relevant chunks are retrieved and appended to the prompt."
            ),
            metadata={"source": "ml_glossary.md", "topic": "rag"},
        ),
        Document(
            content=(
                "Qdrant is a high-performance vector database written in Rust. "
                "It supports filtering, payload storage, hybrid dense+sparse search, "
                "and on-disk persistence. Qdrant can run in-memory for development."
            ),
            metadata={"source": "qdrant_docs.md", "topic": "infrastructure"},
        ),
    ]

    chunk_count = engine.ingest(docs)
    print(f"\nIngested {len(docs)} docs → {chunk_count} chunks\n")

    query = "How does RAG work?"
    print(f"Query: {query}\n")
    context = engine.retrieve_as_context(query, top_k=3)
    print("Retrieved context:")
    print(context)
    print()
    print("Collection info:", engine.collection_info())
