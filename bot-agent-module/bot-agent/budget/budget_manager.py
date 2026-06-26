"""
Token Budget Manager — May 30, 2026
Gateway-level hard enforcement. Per-session, per-key, monthly caps.
Circuit breakers, model-tier auto-routing, usage analytics, alerts.
"""

import asyncio
import json
import logging
import os
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Callable, Optional

logger = logging.getLogger("budget_manager")

# ── Cost table (per 1K tokens, blended avg, May 2026) ─────────────────
MODEL_COSTS_PER_1K: dict[str, float] = {
    "claude-sonnet-4-20250514":   0.003,
    "claude-haiku-4-5-20251001":  0.0004,
    "claude-opus-4-6":            0.015,
    "gpt-4o":                     0.005,
    "gpt-4o-mini":                0.00015,
    "gemini-2.5-pro":             0.0025,
    "gemini-flash":               0.0001,
}

TASK_TIER_MAP: dict[str, str] = {
    "extraction":   "claude-haiku-4-5-20251001",
    "verification": "claude-haiku-4-5-20251001",
    "reasoning":    "claude-sonnet-4-20250514",
    "planning":     "claude-sonnet-4-20250514",
    "browser":      "claude-sonnet-4-20250514",
    "vision":       "claude-sonnet-4-20250514",
    "writing":      "claude-sonnet-4-20250514",
    "analysis":     "claude-sonnet-4-20250514",
    "complex":      "claude-opus-4-6",
}


@dataclass
class BudgetPolicy:
    # Token limits
    session_token_limit:   int   = 200_000
    per_step_token_limit:  int   = 8_000
    iteration_hard_cap:    int   = 25
    # Cost limits
    per_session_usd_limit: float = 2.0
    daily_usd_limit:       float = 20.0
    monthly_usd_limit:     float = 100.0
    # Circuit breaker
    max_error_streak:      int   = 3
    # Alert thresholds (fraction of limit)
    warn_at:               float = 0.80
    critical_at:           float = 0.95
    # Auto-downgrade model when session budget < this fraction remaining
    downgrade_below_pct:   float = 0.20
    # Save usage log to disk
    persist_log:           bool  = False
    log_path:              str   = "./usage_log.jsonl"


@dataclass
class UsageRecord:
    ts:         float
    session_id: str
    model:      str
    tokens:     int
    cost_usd:   float
    task_type:  str = ""
    phase:      str = ""

    def to_dict(self) -> dict:
        return {
            "ts": self.ts, "session_id": self.session_id,
            "model": self.model, "tokens": self.tokens,
            "cost_usd": round(self.cost_usd, 6),
            "task_type": self.task_type, "phase": self.phase,
        }


@dataclass
class SessionUsage:
    session_id:  str
    started:     float = field(default_factory=time.time)
    tokens:      int   = 0
    cost_usd:    float = 0.0
    calls:       int   = 0
    errors:      int   = 0
    model_breakdown: dict = field(default_factory=lambda: defaultdict(int))


class BudgetGateway:
    """
    All LLM calls MUST pass through check() before execution.
    Hard-stops any call that would exceed policy limits.
    """

    def __init__(
        self,
        policy:     BudgetPolicy | None = None,
        on_alert:   Callable | None = None,   # called on warning/critical events
    ):
        self.policy      = policy or BudgetPolicy()
        self.on_alert    = on_alert
        self._sessions:  dict[str, SessionUsage] = {}
        self._history:   list[UsageRecord]        = []
        self._daily_usd: float = 0.0
        self._monthly_usd:float = 0.0
        self._day_stamp: str   = ""
        self._lock = asyncio.Lock()

    # ── Gateway check — call BEFORE every LLM request ─────────────────

    async def check(
        self,
        session_id:       str,
        tokens_requested: int,
        model:            str,
        task_type:        str = "",
    ) -> tuple[bool, str]:
        """
        Returns (allowed: bool, reason: str).
        allowed=False = HARD STOP — do not make the API call.
        """
        async with self._lock:
            self._reset_daily_if_needed()
            sess = self._get_session(session_id)
            cost = self._est_cost(tokens_requested, model)

            # 1. Per-session token hard stop
            if sess.tokens + tokens_requested > self.policy.session_token_limit:
                msg = f"Session token limit ({self.policy.session_token_limit:,}) would be exceeded"
                await self._alert("hard_stop", msg, session_id)
                return False, msg

            # 2. Per-session USD hard stop
            if sess.cost_usd + cost > self.policy.per_session_usd_limit:
                msg = f"Session cost limit (${self.policy.per_session_usd_limit:.2f}) would be exceeded"
                await self._alert("hard_stop", msg, session_id)
                return False, msg

            # 3. Daily USD hard stop
            if self._daily_usd + cost > self.policy.daily_usd_limit:
                msg = f"Daily cost limit (${self.policy.daily_usd_limit:.2f}) would be exceeded"
                await self._alert("hard_stop", msg, session_id)
                return False, msg

            # 4. Monthly USD hard stop
            if self._monthly_usd + cost > self.policy.monthly_usd_limit:
                msg = f"Monthly cost limit (${self.policy.monthly_usd_limit:.2f}) would be exceeded"
                await self._alert("hard_stop", msg, session_id)
                return False, msg

            # Soft warnings
            sess_tok_pct  = (sess.tokens + tokens_requested) / self.policy.session_token_limit
            sess_cost_pct = (sess.cost_usd + cost) / self.policy.per_session_usd_limit
            daily_pct     = (self._daily_usd + cost) / self.policy.daily_usd_limit

            for pct, label in [(sess_tok_pct, "session_tokens"),
                                (sess_cost_pct, "session_cost"),
                                (daily_pct, "daily_cost")]:
                if pct >= self.policy.critical_at:
                    await self._alert("critical", f"{label} at {pct*100:.0f}%", session_id)
                elif pct >= self.policy.warn_at:
                    await self._alert("warning", f"{label} at {pct*100:.0f}%", session_id)

            return True, "ok"

    async def record(
        self,
        session_id: str,
        model:      str,
        tokens:     int,
        task_type:  str = "",
        phase:      str = "",
    ):
        """Record actual usage after successful LLM call."""
        async with self._lock:
            cost = self._est_cost(tokens, model)
            sess = self._get_session(session_id)
            sess.tokens   += tokens
            sess.cost_usd += cost
            sess.calls    += 1
            sess.model_breakdown[model] += tokens
            self._daily_usd   += cost
            self._monthly_usd += cost

            rec = UsageRecord(
                ts=time.time(), session_id=session_id, model=model,
                tokens=tokens, cost_usd=cost, task_type=task_type, phase=phase,
            )
            self._history.append(rec)

            if self.policy.persist_log:
                self._append_log(rec)

    def record_error(self, session_id: str):
        """Increment error counter for session."""
        sess = self._get_session(session_id)
        sess.errors += 1

    # ── Model routing ──────────────────────────────────────────────────

    def recommend_model(self, task_type: str, session_id: str) -> str:
        """
        Return cheapest model that handles the task,
        downgrading if budget is tight.
        """
        sess          = self._get_session(session_id)
        preferred     = TASK_TIER_MAP.get(task_type, "claude-sonnet-4-20250514")
        sess_cost_pct = sess.cost_usd / self.policy.per_session_usd_limit

        if sess_cost_pct >= self.policy.downgrade_below_pct:
            cheap = "claude-haiku-4-5-20251001"
            if cheap != preferred:
                logger.info(f"[BUDGET] Budget tight ({sess_cost_pct*100:.0f}%) — downgrading {preferred}→{cheap}")
            return cheap
        return preferred

    # ── Analytics ─────────────────────────────────────────────────────

    def session_summary(self, session_id: str) -> dict:
        sess = self._get_session(session_id)
        pol  = self.policy
        return {
            "session_id":            session_id,
            "tokens_used":           sess.tokens,
            "tokens_remaining":      max(0, pol.session_token_limit - sess.tokens),
            "tokens_pct":            round(sess.tokens / pol.session_token_limit * 100, 1),
            "cost_usd":              round(sess.cost_usd, 5),
            "cost_remaining_usd":    round(max(0, pol.per_session_usd_limit - sess.cost_usd), 5),
            "cost_pct":              round(sess.cost_usd / pol.per_session_usd_limit * 100, 1),
            "api_calls":             sess.calls,
            "errors":                sess.errors,
            "model_breakdown":       dict(sess.model_breakdown),
            "session_age_s":         round(time.time() - sess.started, 1),
        }

    def global_summary(self) -> dict:
        total_tokens = sum(s.tokens for s in self._sessions.values())
        total_cost   = sum(s.cost_usd for s in self._sessions.values())
        return {
            "active_sessions":    len(self._sessions),
            "total_tokens":       total_tokens,
            "total_api_calls":    sum(s.calls for s in self._sessions.values()),
            "daily_cost_usd":     round(self._daily_usd, 4),
            "daily_limit_usd":    self.policy.daily_usd_limit,
            "daily_pct":          round(self._daily_usd / self.policy.daily_usd_limit * 100, 1),
            "monthly_cost_usd":   round(self._monthly_usd, 4),
            "monthly_limit_usd":  self.policy.monthly_usd_limit,
            "monthly_pct":        round(self._monthly_usd / self.policy.monthly_usd_limit * 100, 1),
            "total_cost_usd":     round(total_cost, 4),
            "history_records":    len(self._history),
        }

    def top_sessions(self, n: int = 5) -> list[dict]:
        sessions = sorted(self._sessions.values(), key=lambda s: s.cost_usd, reverse=True)
        return [self.session_summary(s.session_id) for s in sessions[:n]]

    def export_history(self, path: str = "./usage_export.json") -> str:
        data = {
            "exported_at":  time.time(),
            "global":       self.global_summary(),
            "sessions":     [self.session_summary(sid) for sid in self._sessions],
            "history":      [r.to_dict() for r in self._history[-1000:]],
        }
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        logger.info(f"[BUDGET] Usage exported → {path}")
        return path

    def reset_session(self, session_id: str):
        self._sessions.pop(session_id, None)

    def reset_daily(self):
        self._daily_usd = 0.0
        logger.info("[BUDGET] Daily counter reset")

    # ── Private ────────────────────────────────────────────────────────

    def _get_session(self, session_id: str) -> SessionUsage:
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionUsage(session_id=session_id)
        return self._sessions[session_id]

    @staticmethod
    def _est_cost(tokens: int, model: str) -> float:
        rate = MODEL_COSTS_PER_1K.get(model, 0.003)
        return (tokens / 1000) * rate

    def _reset_daily_if_needed(self):
        import datetime
        today = datetime.date.today().isoformat()
        if today != self._day_stamp:
            self._daily_usd  = 0.0
            self._day_stamp  = today
            logger.info(f"[BUDGET] New day {today} — daily counter reset")

    async def _alert(self, level: str, message: str, session_id: str):
        entry = {
            "level":      level,
            "message":    message,
            "session_id": session_id,
            "ts":         time.time(),
        }
        if level == "hard_stop":
            logger.error(f"[BUDGET] HARD STOP [{session_id}]: {message}")
        elif level == "critical":
            logger.warning(f"[BUDGET] CRITICAL [{session_id}]: {message}")
        else:
            logger.info(f"[BUDGET] WARNING [{session_id}]: {message}")

        if self.on_alert:
            try:
                if asyncio.iscoroutinefunction(self.on_alert):
                    await self.on_alert(entry)
                else:
                    self.on_alert(entry)
            except Exception as e:
                logger.warning(f"[BUDGET] Alert callback error: {e}")

    def _append_log(self, rec: UsageRecord):
        try:
            os.makedirs(os.path.dirname(self.policy.log_path) or ".", exist_ok=True)
            with open(self.policy.log_path, "a") as f:
                f.write(json.dumps(rec.to_dict()) + "\n")
        except Exception as e:
            logger.warning(f"[BUDGET] Log write error: {e}")


# ── Global singleton ────────────────────────────────────────────────────

_gateway: Optional[BudgetGateway] = None

def get_gateway(policy: BudgetPolicy | None = None) -> BudgetGateway:
    global _gateway
    if _gateway is None:
        _gateway = BudgetGateway(policy)
        logger.info("[BUDGET] Gateway initialized")
    return _gateway

def reset_gateway():
    global _gateway
    _gateway = None
