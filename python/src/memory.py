"""
Conversation Memory — Python
Multi-turn session state for the RAG agent: stores message history per session,
persists to disk as JSON (safe — no pickle), and provides trimming/summarization
hooks to keep context within token budgets.

No extra dependencies beyond the stdlib + model_router (for summarization).
"""

import json
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

from model_router import ModelRouter, TextBlock

DEFAULT_STORE_DIR = os.environ.get("RAG_SESSION_DIR", os.path.join(os.getcwd(), ".rag_sessions"))
MAX_MESSAGES_BEFORE_SUMMARY = 40
KEEP_RECENT_MESSAGES = 10


@dataclass
class Session:
    session_id: str
    created_at: float
    updated_at: float
    messages:   list[dict] = field(default_factory=list)
    summary:    str = ""
    metadata:   dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "messages":   self.messages,
            "summary":    self.summary,
            "metadata":   self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Session":
        return cls(
            session_id=data["session_id"],
            created_at=data["created_at"],
            updated_at=data["updated_at"],
            messages=data.get("messages", []),
            summary=data.get("summary", ""),
            metadata=data.get("metadata", {}),
        )


class MemoryStore:
    """
    File-backed conversation memory store.
    Each session is a JSON file — never pickle — so loading a file cannot
    execute code even if the storage directory is untrusted.
    Thread-safe via a per-instance lock.
    """

    def __init__(self, store_dir: str = DEFAULT_STORE_DIR):
        self.store_dir = Path(store_dir)
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def _path(self, session_id: str) -> Path:
        safe_id = "".join(c for c in session_id if c.isalnum() or c == "-")
        if not safe_id:
            raise ValueError("Invalid session_id")
        return self.store_dir / f"{safe_id}.json"

    def create(self, metadata: dict | None = None) -> Session:
        now = time.time()
        session = Session(
            session_id=uuid.uuid4().hex,
            created_at=now,
            updated_at=now,
            messages=[],
            metadata=metadata or {},
        )
        self.save(session)
        return session

    def load(self, session_id: str) -> Session | None:
        path = self._path(session_id)
        if not path.exists():
            return None
        with self._lock:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, json.JSONDecodeError):
                return None
        return Session.from_dict(data)

    def save(self, session: Session) -> None:
        session.updated_at = time.time()
        path = self._path(session.session_id)
        tmp = path.with_suffix(".tmp")
        with self._lock:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(session.to_dict(), f, indent=2)
            tmp.replace(path)

    def delete(self, session_id: str) -> bool:
        path = self._path(session_id)
        with self._lock:
            if path.exists():
                path.unlink()
                return True
        return False

    def list_sessions(self) -> list[str]:
        return [p.stem for p in sorted(self.store_dir.glob("*.json"))]

    def append_user(self, session_id: str, content: str) -> Session:
        return self._append(session_id, {"role": "user", "content": content})

    def append_assistant(self, session_id: str, content: str | list) -> Session:
        return self._append(session_id, {"role": "assistant", "content": content})

    def _append(self, session_id: str, message: dict) -> Session:
        session = self.load(session_id)
        if session is None:
            session = Session(
                session_id=session_id,
                created_at=time.time(),
                updated_at=time.time(),
            )
        session.messages.append(message)
        self.save(session)
        return session


# ── Summarization ──────────────────────────────────────────────────────────────
_summarizer: ModelRouter | None = None


def _get_summarizer() -> ModelRouter:
    global _summarizer
    if _summarizer is None:
        _summarizer = ModelRouter()
    return _summarizer


def summarize_messages(messages: list[dict], existing_summary: str = "") -> str:
    transcript_lines = []
    for msg in messages:
        role = msg.get("role", "unknown")
        content = msg.get("content", "")
        if isinstance(content, list):
            content = " ".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            )
        if content:
            transcript_lines.append(f"{role}: {content}")

    transcript = "\n".join(transcript_lines)

    if existing_summary:
        prompt = (
            f"Prior summary:\n{existing_summary}\n\n"
            f"New conversation segment:\n{transcript}\n\n"
            "Produce an updated summary (3-6 sentences) merging both."
        )
    else:
        prompt = (
            f"Conversation:\n{transcript}\n\n"
            "Summarize in 3-5 sentences, preserving key facts and open questions."
        )

    response = _get_summarizer().create(
        messages=[{"role": "user", "content": prompt}],
        system="You are a precise conversation summarizer.",
        max_tokens=512,
    )
    for block in response.content:
        if isinstance(block, TextBlock):
            return block.text.strip()
    return existing_summary


def maybe_compact(store: MemoryStore, session: Session) -> Session:
    """Summarize and trim history when it grows too long."""
    if len(session.messages) <= MAX_MESSAGES_BEFORE_SUMMARY:
        return session
    to_summarize = session.messages[:-KEEP_RECENT_MESSAGES]
    session.summary = summarize_messages(to_summarize, session.summary)
    session.messages = session.messages[-KEEP_RECENT_MESSAGES:]
    store.save(session)
    return session


def build_context_messages(session: Session, new_user_message: str) -> list[dict]:
    """Build the full message list to send to the model for a new turn."""
    messages: list[dict] = []
    if session.summary:
        messages.append({"role": "user", "content": f"[Prior conversation summary]: {session.summary}"})
        messages.append({"role": "assistant", "content": "Understood, I have that context."})
    messages.extend(session.messages)
    messages.append({"role": "user", "content": new_user_message})
    return messages


# ── CLI demo ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    store = MemoryStore()
    session = store.create(metadata={"user": "demo"})
    print(f"Created session: {session.session_id}")
    store.append_user(session.session_id, "What is RAG?")
    store.append_assistant(session.session_id, "RAG is Retrieval-Augmented Generation.")
    loaded = store.load(session.session_id)
    print(f"Messages: {len(loaded.messages)}")
    for m in loaded.messages:
        print(f"  {m['role']}: {m['content']}")
