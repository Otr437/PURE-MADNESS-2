"""
Agent Memory Layer — May 30, 2026
Short-term (session), long-term (disk/vector), episodic (replay).
Semantic search over past sessions. Context injection.
"""

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger("memory")


@dataclass
class MemoryEntry:
    entry_id:   str   = field(default_factory=lambda: str(uuid.uuid4())[:10])
    session_id: str   = ""
    task:       str   = ""
    result:     str   = ""
    tags:       list  = field(default_factory=list)
    embedding:  list  = field(default_factory=list)   # float vector if available
    created_at: float = field(default_factory=time.time)
    metadata:   dict  = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "entry_id":   self.entry_id,
            "session_id": self.session_id,
            "task":       self.task,
            "result":     self.result[:500],
            "tags":       self.tags,
            "created_at": self.created_at,
            "metadata":   self.metadata,
        }


class ShortTermMemory:
    """In-session working memory — key/value store with TTL."""

    def __init__(self, ttl_seconds: float = 3600.0):
        self._store: dict[str, tuple[Any, float]] = {}   # key → (value, expires)
        self._ttl   = ttl_seconds

    def set(self, key: str, value: Any, ttl: float | None = None):
        expires = time.time() + (ttl or self._ttl)
        self._store[key] = (value, expires)

    def get(self, key: str) -> Any:
        entry = self._store.get(key)
        if not entry:
            return None
        value, expires = entry
        if time.time() > expires:
            del self._store[key]
            return None
        return value

    def delete(self, key: str):
        self._store.pop(key, None)

    def keys(self) -> list[str]:
        now = time.time()
        expired = [k for k, (_, exp) in self._store.items() if now > exp]
        for k in expired:
            del self._store[k]
        return list(self._store.keys())

    def all(self) -> dict:
        return {k: self.get(k) for k in self.keys()}

    def clear(self):
        self._store.clear()


class LongTermMemory:
    """
    Persistent memory across sessions.
    Stores to JSONL on disk. Optional vector search via sentence-transformers.
    Falls back to keyword search if no vector library available.
    """

    def __init__(self, storage_dir: str = "./agent_memory"):
        self._dir      = storage_dir
        self._index_f  = os.path.join(storage_dir, "memory_index.jsonl")
        self._entries: list[MemoryEntry] = []
        self._has_embeddings = False
        os.makedirs(storage_dir, exist_ok=True)
        self._load()
        self._try_init_embeddings()

    def _try_init_embeddings(self):
        try:
            from sentence_transformers import SentenceTransformer
            self._encoder = SentenceTransformer("all-MiniLM-L6-v2")
            self._has_embeddings = True
            logger.info("[MEMORY] Vector embeddings enabled (sentence-transformers)")
        except ImportError:
            logger.info("[MEMORY] sentence-transformers not installed — using keyword search")

    def store(self, session_id: str, task: str, result: str,
              tags: list | None = None, metadata: dict | None = None) -> MemoryEntry:
        entry = MemoryEntry(
            session_id = session_id,
            task       = task,
            result     = result[:1000],
            tags       = tags or [],
            metadata   = metadata or {},
        )
        if self._has_embeddings:
            try:
                entry.embedding = self._encoder.encode(
                    f"{task} {result[:200]}"
                ).tolist()
            except Exception:
                pass

        self._entries.append(entry)
        self._append_to_disk(entry)
        logger.debug(f"[MEMORY] Stored entry {entry.entry_id} for session {session_id}")
        return entry

    def search(self, query: str, top_k: int = 5, tag_filter: list | None = None) -> list[MemoryEntry]:
        """Semantic search (vector) or keyword fallback."""
        candidates = self._entries
        if tag_filter:
            candidates = [e for e in candidates if any(t in e.tags for t in tag_filter)]

        if not candidates:
            return []

        if self._has_embeddings and candidates and candidates[0].embedding:
            return self._vector_search(query, candidates, top_k)
        return self._keyword_search(query, candidates, top_k)

    def _vector_search(self, query: str, entries: list[MemoryEntry], top_k: int) -> list[MemoryEntry]:
        try:
            import numpy as np
            q_vec  = self._encoder.encode(query)
            scored = []
            for e in entries:
                if e.embedding:
                    vec   = np.array(e.embedding)
                    score = float(np.dot(q_vec, vec) / (np.linalg.norm(q_vec) * np.linalg.norm(vec) + 1e-9))
                    scored.append((score, e))
            scored.sort(key=lambda x: x[0], reverse=True)
            return [e for _, e in scored[:top_k]]
        except Exception as ex:
            logger.warning(f"[MEMORY] Vector search error: {ex}")
            return self._keyword_search(query, entries, top_k)

    def _keyword_search(self, query: str, entries: list[MemoryEntry], top_k: int) -> list[MemoryEntry]:
        terms  = query.lower().split()
        scored = []
        for e in entries:
            text  = f"{e.task} {e.result}".lower()
            score = sum(1 for t in terms if t in text)
            if score > 0:
                scored.append((score, e))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [e for _, e in scored[:top_k]]

    def get_session_history(self, session_id: str) -> list[MemoryEntry]:
        return [e for e in self._entries if e.session_id == session_id]

    def recent(self, n: int = 10) -> list[MemoryEntry]:
        return sorted(self._entries, key=lambda e: e.created_at, reverse=True)[:n]

    def delete_entry(self, entry_id: str):
        self._entries = [e for e in self._entries if e.entry_id != entry_id]
        self._rewrite_disk()

    def clear_all(self):
        self._entries = []
        self._rewrite_disk()

    def stats(self) -> dict:
        return {
            "total_entries":     len(self._entries),
            "unique_sessions":   len(set(e.session_id for e in self._entries)),
            "has_embeddings":    self._has_embeddings,
            "storage_dir":       self._dir,
            "oldest_entry":      min((e.created_at for e in self._entries), default=0),
            "newest_entry":      max((e.created_at for e in self._entries), default=0),
        }

    def to_context_string(self, query: str, top_k: int = 3) -> str:
        """Build a context snippet for injecting into agent prompts."""
        results = self.search(query, top_k=top_k)
        if not results:
            return ""
        lines = ["RELEVANT PAST SESSIONS:"]
        for e in results:
            lines.append(f"  [{e.created_at:.0f}] Task: {e.task[:80]} → {e.result[:120]}")
        return "\n".join(lines)

    def _load(self):
        if not os.path.exists(self._index_f):
            return
        try:
            with open(self._index_f) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    d = json.loads(line)
                    self._entries.append(MemoryEntry(
                        entry_id   = d.get("entry_id", str(uuid.uuid4())[:10]),
                        session_id = d.get("session_id", ""),
                        task       = d.get("task", ""),
                        result     = d.get("result", ""),
                        tags       = d.get("tags", []),
                        created_at = d.get("created_at", time.time()),
                        metadata   = d.get("metadata", {}),
                    ))
            logger.info(f"[MEMORY] Loaded {len(self._entries)} entries from disk")
        except Exception as e:
            logger.warning(f"[MEMORY] Load error: {e}")

    def _append_to_disk(self, entry: MemoryEntry):
        try:
            with open(self._index_f, "a") as f:
                f.write(json.dumps(entry.to_dict()) + "\n")
        except Exception as e:
            logger.warning(f"[MEMORY] Disk write error: {e}")

    def _rewrite_disk(self):
        try:
            with open(self._index_f, "w") as f:
                for e in self._entries:
                    f.write(json.dumps(e.to_dict()) + "\n")
        except Exception as e:
            logger.warning(f"[MEMORY] Disk rewrite error: {e}")


class AgentMemory:
    """
    Unified memory interface for agents.
    Combines short-term (in-session) + long-term (persistent).
    """

    def __init__(self, storage_dir: str = "./agent_memory", ttl_seconds: float = 3600.0):
        self.short = ShortTermMemory(ttl_seconds)
        self.long  = LongTermMemory(storage_dir)

    def remember(self, key: str, value: Any, persist: bool = False,
                 session_id: str = "", tags: list | None = None):
        """Store in short-term. Optionally persist to long-term."""
        self.short.set(key, value)
        if persist and session_id:
            self.long.store(
                session_id = session_id,
                task       = key,
                result     = str(value)[:500],
                tags       = tags or [],
            )

    def recall(self, key: str) -> Any:
        """Retrieve from short-term first, then try long-term search."""
        val = self.short.get(key)
        if val is not None:
            return val
        results = self.long.search(key, top_k=1)
        return results[0].result if results else None

    def inject_context(self, query: str, top_k: int = 3) -> str:
        """Build memory context string for agent prompt injection."""
        long_ctx  = self.long.to_context_string(query, top_k)
        short_ctx = self.short.all()
        parts = []
        if short_ctx:
            parts.append(f"WORKING MEMORY: {json.dumps(short_ctx, default=str)[:400]}")
        if long_ctx:
            parts.append(long_ctx)
        return "\n".join(parts)

    def save_session(self, session_id: str, task: str, result: str,
                     tags: list | None = None, metadata: dict | None = None):
        self.long.store(session_id, task, result, tags, metadata)

    def clear_short(self):
        self.short.clear()

    def stats(self) -> dict:
        return {
            "short_term_keys": len(self.short.keys()),
            "long_term":       self.long.stats(),
        }
