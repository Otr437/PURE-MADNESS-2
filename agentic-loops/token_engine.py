"""
RBAC Token Engine + Monitor — Python
Plugs directly into react_loop.py and run_agent.py.

Roles define token budgets. Every agent run is assigned a role.
The engine tracks usage, enforces budgets, emits alerts, and logs a full audit trail.

Usage:
    from token_engine import TokenEngine, Role, RBACConfig

    config = RBACConfig(roles={
        "admin":    Role(max_tokens=100_000, max_iter=50,  alert_pct=0.8),
        "operator": Role(max_tokens=40_000,  max_iter=30,  alert_pct=0.75),
        "user":     Role(max_tokens=10_000,  max_iter=15,  alert_pct=0.7),
        "readonly": Role(max_tokens=2_000,   max_iter=5,   alert_pct=0.6),
    })

    engine = TokenEngine(config)
    session = engine.start_session(role="operator", task="summarise logs")
    # ... run agent ...
    engine.record_usage(session.id, input_tokens=500, output_tokens=300)
    engine.end_session(session.id, answer="done")
    engine.print_monitor()
"""

import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

# ── Role definition ───────────────────────────────────────────────────────────
@dataclass
class Role:
    max_tokens:  int            # total token budget for a single session
    max_iter:    int            # max agent iterations allowed
    alert_pct:   float = 0.75  # emit alert when this fraction of budget used
    cost_per_1k: float = 0.015 # USD per 1k tokens (blended in/out, adjust per model)

# ── RBAC config ───────────────────────────────────────────────────────────────
@dataclass
class RBACConfig:
    roles: dict[str, Role]

    def get(self, role_name: str) -> Role:
        r = self.roles.get(role_name)
        if r is None:
            raise PermissionError(f"Unknown role: '{role_name}'. Valid roles: {list(self.roles)}")
        return r

# ── Session ───────────────────────────────────────────────────────────────────
@dataclass
class Session:
    id:              str
    role:            str
    task:            str
    budget:          Role
    started_at:      datetime        = field(default_factory=lambda: datetime.now(timezone.utc))
    ended_at:        Optional[datetime] = None
    input_tokens:    int             = 0
    output_tokens:   int             = 0
    iterations:      int             = 0
    answer:          str             = ""
    alerts:          list[str]       = field(default_factory=list)
    aborted:         bool            = False
    abort_reason:    str             = ""

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    @property
    def budget_used_pct(self) -> float:
        return self.total_tokens / self.budget.max_tokens if self.budget.max_tokens else 0.0

    @property
    def estimated_cost_usd(self) -> float:
        return (self.total_tokens / 1000) * self.budget.cost_per_1k

    @property
    def elapsed_s(self) -> float:
        end = self.ended_at or datetime.now(timezone.utc)
        return (end - self.started_at).total_seconds()

    def to_dict(self) -> dict:
        return {
            "id":               self.id,
            "role":             self.role,
            "task":             self.task[:200],
            "started_at":       self.started_at.isoformat(),
            "ended_at":         self.ended_at.isoformat() if self.ended_at else None,
            "elapsed_s":        round(self.elapsed_s, 2),
            "input_tokens":     self.input_tokens,
            "output_tokens":    self.output_tokens,
            "total_tokens":     self.total_tokens,
            "budget_tokens":    self.budget.max_tokens,
            "budget_used_pct":  round(self.budget_used_pct * 100, 1),
            "estimated_cost_usd": round(self.estimated_cost_usd, 6),
            "iterations":       self.iterations,
            "max_iter":         self.budget.max_iter,
            "alerts":           self.alerts,
            "aborted":          self.aborted,
            "abort_reason":     self.abort_reason,
            "answer_preview":   self.answer[:200],
        }

# ── Token Engine ──────────────────────────────────────────────────────────────
class TokenEngine:
    """
    Thread-safe RBAC token engine.
    Tracks sessions, enforces budgets, fires callbacks, writes audit log.
    """

    def __init__(
        self,
        config:       RBACConfig,
        audit_path:   Optional[str]      = None,
        on_alert:     Optional[Callable] = None,  # fn(session, message)
        on_abort:     Optional[Callable] = None,  # fn(session, reason)
    ):
        self.config     = config
        self.audit_path = audit_path or os.environ.get("AGENT_AUDIT_LOG", "/tmp/agent_audit.jsonl")
        self.on_alert   = on_alert
        self.on_abort   = on_abort
        self._sessions: dict[str, Session] = {}
        self._lock      = threading.Lock()

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def start_session(self, role: str, task: str) -> Session:
        budget = self.config.get(role)  # raises PermissionError if unknown
        session = Session(
            id     = str(uuid.uuid4()),
            role   = role,
            task   = task,
            budget = budget,
        )
        with self._lock:
            self._sessions[session.id] = session
        self._audit("session_start", session)
        return session

    def record_usage(
        self,
        session_id:    str,
        input_tokens:  int,
        output_tokens: int,
        iteration:     Optional[int] = None,
    ) -> None:
        """Call after every LLM API response."""
        session = self._get(session_id)
        with self._lock:
            session.input_tokens  += input_tokens
            session.output_tokens += output_tokens
            if iteration is not None:
                session.iterations = iteration

        self._audit("usage", session, extra={
            "delta_input":  input_tokens,
            "delta_output": output_tokens,
        })
        self._check_budget(session)

    def end_session(self, session_id: str, answer: str = "") -> Session:
        session = self._get(session_id)
        with self._lock:
            session.ended_at = datetime.now(timezone.utc)
            session.answer   = answer
        self._audit("session_end", session)
        return session

    def abort_session(self, session_id: str, reason: str) -> Session:
        session = self._get(session_id)
        with self._lock:
            session.aborted      = True
            session.abort_reason = reason
            session.ended_at     = datetime.now(timezone.utc)
        self._audit("session_abort", session, extra={"reason": reason})
        if self.on_abort:
            self.on_abort(session, reason)
        raise BudgetExceededError(reason)

    # ── Budget enforcement ────────────────────────────────────────────────────

    def check_iteration(self, session_id: str, iteration: int) -> None:
        """Call before each agent iteration to enforce iteration cap."""
        session = self._get(session_id)
        if iteration > session.budget.max_iter:
            self.abort_session(
                session_id,
                f"Role '{session.role}' iteration limit reached: "
                f"{session.budget.max_iter} max, attempted #{iteration}"
            )

    def _check_budget(self, session: Session) -> None:
        pct = session.budget_used_pct

        # Alert threshold
        if pct >= session.budget.alert_pct and not any("alert" in a for a in session.alerts):
            msg = (f"[ALERT] Role '{session.role}' session {session.id[:8]} "
                   f"at {pct*100:.1f}% of token budget "
                   f"({session.total_tokens}/{session.budget.max_tokens})")
            with self._lock:
                session.alerts.append(msg)
            self._emit_alert(session, msg)

        # Hard limit
        if session.total_tokens >= session.budget.max_tokens:
            self.abort_session(
                session.id,
                f"Role '{session.role}' token budget exhausted: "
                f"{session.total_tokens}/{session.budget.max_tokens}"
            )

    def _emit_alert(self, session: Session, message: str) -> None:
        print(f"\n\033[93m⚠  TOKEN ALERT\033[0m  {message}", flush=True)
        self._audit("alert", session, extra={"message": message})
        if self.on_alert:
            self.on_alert(session, message)

    # ── Monitor / reporting ───────────────────────────────────────────────────

    def print_monitor(self, active_only: bool = False) -> None:
        """Print a live monitor table of all sessions."""
        sessions = list(self._sessions.values())
        if active_only:
            sessions = [s for s in sessions if s.ended_at is None]

        sep = "─" * 110
        print(f"\n{'TOKEN MONITOR':^110}")
        print(sep)
        print(f"{'SESSION':^10} {'ROLE':^12} {'TOKENS':^12} {'BUDGET':^10} {'USED%':^8} "
              f"{'ITER':^8} {'COST$':^10} {'ELAPSED':^10} {'STATUS':^10}")
        print(sep)

        for s in sorted(sessions, key=lambda x: x.started_at, reverse=True):
            status = "ABORTED" if s.aborted else ("DONE" if s.ended_at else "RUNNING")
            color  = "\033[91m" if s.aborted else ("\033[92m" if s.ended_at else "\033[93m")
            bar_filled = int(s.budget_used_pct * 10)
            bar = "█" * bar_filled + "░" * (10 - bar_filled)
            print(
                f"{s.id[:8]:^10} "
                f"{s.role:^12} "
                f"{s.total_tokens:^12,} "
                f"{s.budget.max_tokens:^10,} "
                f"{bar} {s.budget_used_pct*100:4.1f}% "
                f"{s.iterations:^4}/{s.budget.max_iter:<4} "
                f"${s.estimated_cost_usd:^9.4f} "
                f"{s.elapsed_s:^8.1f}s "
                f"{color}{status:^10}\033[0m"
            )

        print(sep)
        total_tokens = sum(s.total_tokens for s in sessions)
        total_cost   = sum(s.estimated_cost_usd for s in sessions)
        print(f"  Total sessions: {len(sessions)}  |  "
              f"Total tokens: {total_tokens:,}  |  "
              f"Total cost: ${total_cost:.4f}")
        print(sep + "\n")

    def get_report(self) -> list[dict]:
        return [s.to_dict() for s in self._sessions.values()]

    def write_report(self, path: str) -> None:
        with open(path, "w") as f:
            json.dump(self.get_report(), f, indent=2, ensure_ascii=False)

    # ── Audit log ─────────────────────────────────────────────────────────────

    def _audit(self, event: str, session: Session, extra: dict = None) -> None:
        record = {
            "ts":         datetime.now(timezone.utc).isoformat(),
            "event":      event,
            "session_id": session.id,
            "role":       session.role,
            "tokens":     session.total_tokens,
            "budget":     session.budget.max_tokens,
            "pct":        round(session.budget_used_pct * 100, 1),
            "cost_usd":   round(session.estimated_cost_usd, 6),
        }
        if extra:
            record.update(extra)
        with self._lock:
            with open(self.audit_path, "a") as f:
                f.write(json.dumps(record) + "\n")

    def _get(self, session_id: str) -> Session:
        s = self._sessions.get(session_id)
        if s is None:
            raise KeyError(f"Unknown session: {session_id}")
        return s

# ── Exception ─────────────────────────────────────────────────────────────────
class BudgetExceededError(RuntimeError):
    pass

# ── Default config ────────────────────────────────────────────────────────────
DEFAULT_CONFIG = RBACConfig(roles={
    "admin":    Role(max_tokens=200_000, max_iter=50,  alert_pct=0.8,  cost_per_1k=0.015),
    "operator": Role(max_tokens=50_000,  max_iter=30,  alert_pct=0.75, cost_per_1k=0.015),
    "user":     Role(max_tokens=10_000,  max_iter=15,  alert_pct=0.7,  cost_per_1k=0.015),
    "readonly": Role(max_tokens=2_000,   max_iter=5,   alert_pct=0.6,  cost_per_1k=0.015),
})

# ── Wired run_react with RBAC ─────────────────────────────────────────────────
def run_react_rbac(
    task:          str,
    role:          str,
    engine:        TokenEngine,
    system_extra:  str = "",
    on_step=None,
) -> tuple[str, "Session"]:
    """
    Drop-in replacement for run_react() with full RBAC token enforcement.
    Returns (answer, session) instead of (answer, trace).
    """
    from react_loop import run_react, Thought, Action, Observation

    session = engine.start_session(role=role, task=task)
    print(f"\n[token] Session {session.id[:8]} | Role: {role} | Budget: {session.budget.max_tokens:,} tokens\n")

    iteration_counter = [0]

    def wrapped_step(step):
        if isinstance(step, Action):
            iteration_counter[0] += 1
            engine.check_iteration(session.id, iteration_counter[0])
        if on_step:
            on_step(step)

    try:
        answer, trace = run_react(
            user_message   = task,
            system_extra   = system_extra,
            max_iterations = session.budget.max_iter,
            on_tool_call   = wrapped_step,
        )
        engine.record_usage(
            session.id,
            input_tokens  = trace.total_tokens // 2,  # approximate split
            output_tokens = trace.total_tokens - trace.total_tokens // 2,
            iteration     = trace.iterations,
        )
        engine.end_session(session.id, answer=answer)
        return answer, engine._get(session.id)

    except BudgetExceededError:
        raise
    except Exception as e:
        engine.abort_session(session.id, str(e))

# ── CLI demo ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    role = sys.argv[1] if len(sys.argv) > 1 else "user"
    task = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else \
        "Calculate the 10th Fibonacci number using code."

    engine = TokenEngine(DEFAULT_CONFIG)

    try:
        answer, session = run_react_rbac(task=task, role=role, engine=engine)
        print(f"\nAnswer: {answer}")
    except BudgetExceededError as e:
        print(f"\n[BUDGET EXCEEDED] {e}")
    except PermissionError as e:
        print(f"\n[ACCESS DENIED] {e}")
    finally:
        engine.print_monitor()
        engine.write_report("/tmp/token_report.json")
        print("Audit log → /tmp/agent_audit.jsonl")
        print("Report    → /tmp/token_report.json")
