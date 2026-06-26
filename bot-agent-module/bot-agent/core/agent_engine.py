"""
Autonomous ReAct Agent Engine — May 30, 2026
Perceive → Reason → Plan → Act → Observe loop
Self-healing, token budget tracking, hard iteration caps,
streaming support, session export, graceful shutdown.
"""

import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Callable, Optional

logger = logging.getLogger("agent_engine")

# ─────────────────────────────────────────────
# Types & State
# ─────────────────────────────────────────────

class AgentPhase(str, Enum):
    PERCEIVE   = "perceive"
    REASON     = "reason"
    PLAN       = "plan"
    ACT        = "act"
    OBSERVE    = "observe"
    COMPLETE   = "complete"
    FAILED     = "failed"
    BUDGET_HIT = "budget_hit"
    CANCELLED  = "cancelled"


class ToolStatus(str, Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    TIMEOUT = "timeout"
    RETRY   = "retry"
    SKIPPED = "skipped"


@dataclass
class ToolCall:
    name: str
    args: dict
    result: Any = None
    status: ToolStatus = ToolStatus.SUCCESS
    error: Optional[str] = None
    tokens_used: int = 0
    duration_ms: float = 0.0
    attempt: int = 1

    def to_dict(self) -> dict:
        return {
            "name": self.name, "args": self.args,
            "result": self.result, "status": self.status.value,
            "error": self.error, "tokens_used": self.tokens_used,
            "duration_ms": round(self.duration_ms, 1), "attempt": self.attempt,
        }


@dataclass
class AgentStep:
    step_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    phase: AgentPhase = AgentPhase.PERCEIVE
    thought: str = ""
    plan: list[str] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    observation: str = ""
    tokens_used: int = 0
    confidence: float = 0.0
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "step_id": self.step_id, "phase": self.phase.value,
            "thought": self.thought, "plan": self.plan,
            "tool_calls": [t.to_dict() for t in self.tool_calls],
            "observation": self.observation, "tokens_used": self.tokens_used,
            "confidence": self.confidence,
            "timestamp": round(self.timestamp, 3),
        }


@dataclass
class BudgetState:
    """Hard token budget with circuit breakers."""
    session_limit: int   = 200_000
    per_step_limit: int  = 8_000
    total_used: int      = 0
    step_used: int       = 0
    iteration_limit: int = 25
    iterations_done: int = 0
    cost_usd: float      = 0.0
    error_streak: int    = 0
    max_error_streak: int= 3
    same_action_streak: int = 0
    last_action: str     = ""
    max_same_action: int = 3
    MODEL_COSTS: dict = field(default_factory=lambda: {
        "claude-sonnet-4-20250514":   0.003,
        "claude-haiku-4-5-20251001":  0.0004,
        "claude-opus-4-6":            0.015,
        "gpt-4o":                     0.005,
        "gpt-4o-mini":                0.00015,
        "gemini-2.5-pro":             0.0025,
        "gemini-flash":               0.0001,
    })

    def charge(self, tokens: int, model: str) -> bool:
        """Returns False = hard stop."""
        self.total_used += tokens
        self.step_used  += tokens
        rate = self.MODEL_COSTS.get(model, 0.003)
        self.cost_usd  += (tokens / 1000) * rate
        if self.total_used >= self.session_limit:
            logger.warning(f"[BUDGET] Session token limit hit: {self.total_used:,}/{self.session_limit:,}")
            return False
        if self.step_used >= self.per_step_limit:
            logger.warning(f"[BUDGET] Step token limit hit: {self.step_used}/{self.per_step_limit}")
            return False
        return True

    def track_action(self, action: str):
        """Detect infinite loops — same action repeated too many times."""
        if action == self.last_action:
            self.same_action_streak += 1
        else:
            self.same_action_streak = 1
            self.last_action = action

    @property
    def is_looping(self) -> bool:
        return self.same_action_streak >= self.max_same_action

    def reset_step(self):
        self.step_used = 0

    @property
    def remaining(self) -> int:
        return max(0, self.session_limit - self.total_used)

    @property
    def iter_remaining(self) -> int:
        return max(0, self.iteration_limit - self.iterations_done)

    def summary(self) -> dict:
        return {
            "tokens_used":        self.total_used,
            "tokens_left":        self.remaining,
            "tokens_pct":         round(self.total_used / self.session_limit * 100, 1),
            "iterations":         f"{self.iterations_done}/{self.iteration_limit}",
            "cost_usd":           round(self.cost_usd, 5),
            "error_streak":       self.error_streak,
            "same_action_streak": self.same_action_streak,
        }


@dataclass
class AgentSession:
    session_id: str = field(default_factory=lambda: str(uuid.uuid4())[:12])
    task: str = ""
    model: str = "claude-sonnet-4-20250514"
    steps: list[AgentStep] = field(default_factory=list)
    budget: BudgetState = field(default_factory=BudgetState)
    phase: AgentPhase = AgentPhase.PERCEIVE
    final_result: Any = None
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    context: dict = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)     # e.g. ["browser", "prod"]
    metadata: dict = field(default_factory=dict)       # caller-supplied

    def duration_s(self) -> float:
        return round((self.ended_at or time.time()) - self.started_at, 2)

    def to_history(self, max_steps: int = 20) -> list[dict]:
        """
        Build conversation history. Trims oldest steps if too long
        to avoid blowing the context window.
        """
        history = []
        recent = self.steps[-max_steps:]
        for step in recent:
            if step.thought:
                history.append({"role": "assistant", "content": f"[THOUGHT] {step.thought}"})
            for tc in step.tool_calls:
                history.append({"role": "assistant",
                                 "content": f"[TOOL_USE] {tc.name}({json.dumps(tc.args)})"})
                result_str = json.dumps(tc.result)[:600] if tc.result else "null"
                history.append({"role": "user",
                                 "content": f"[TOOL_RESULT status={tc.status.value}] {result_str}"})
            if step.observation:
                history.append({"role": "assistant", "content": f"[OBSERVE] {step.observation}"})
        return history

    def export(self) -> dict:
        """Full session export — save to disk, send to logging system, etc."""
        return {
            "session_id":   self.session_id,
            "task":         self.task,
            "model":        self.model,
            "phase":        self.phase.value,
            "final_result": self.final_result,
            "started_at":   self.started_at,
            "ended_at":     self.ended_at,
            "duration_s":   self.duration_s(),
            "budget":       self.budget.summary(),
            "tags":         self.tags,
            "metadata":     self.metadata,
            "steps":        [s.to_dict() for s in self.steps],
        }

    def save(self, path: str | None = None) -> str:
        """Save session JSON to disk. Returns file path."""
        import os
        out_dir = path or os.environ.get("AGENT_SESSION_DIR", "./sessions")
        os.makedirs(out_dir, exist_ok=True)
        fname = os.path.join(out_dir, f"session_{self.session_id}.json")
        with open(fname, "w") as f:
            json.dump(self.export(), f, indent=2, default=str)
        logger.info(f"[SESSION] Saved → {fname}")
        return fname


# ─────────────────────────────────────────────
# Tool Registry
# ─────────────────────────────────────────────

class ToolRegistry:
    """Central registry for all agent-callable tools."""

    def __init__(self):
        self._tools:   dict[str, Callable] = {}
        self._schemas: dict[str, dict]     = {}
        self._timeout: dict[str, float]    = {}
        self._retries: dict[str, int]      = {}

    def register(
        self,
        name: str,
        fn: Callable,
        schema: dict,
        timeout_s: float = 30.0,
        max_retries: int = 2,
    ):
        self._tools[name]   = fn
        self._schemas[name] = schema
        self._timeout[name] = timeout_s
        self._retries[name] = max_retries
        logger.debug(f"[REGISTRY] Registered tool: {name}")

    def unregister(self, name: str):
        for d in (self._tools, self._schemas, self._timeout, self._retries):
            d.pop(name, None)

    def list_tools(self) -> list[str]:
        return list(self._tools.keys())

    async def call(self, tool_call: ToolCall) -> ToolCall:
        fn          = self._tools.get(tool_call.name)
        timeout     = self._timeout.get(tool_call.name, 30.0)
        max_retries = self._retries.get(tool_call.name, 2)

        if not fn:
            tool_call.status = ToolStatus.FAILURE
            tool_call.error  = f"Unknown tool '{tool_call.name}'. Available: {self.list_tools()}"
            return tool_call

        for attempt in range(1, max_retries + 2):
            tool_call.attempt = attempt
            t0 = time.perf_counter()
            try:
                coro = fn(**tool_call.args) if asyncio.iscoroutinefunction(fn) \
                       else asyncio.to_thread(fn, **tool_call.args)
                result = await asyncio.wait_for(coro, timeout=timeout)
                tool_call.result      = result
                tool_call.status      = ToolStatus.SUCCESS
                tool_call.duration_ms = (time.perf_counter() - t0) * 1000
                logger.info(f"[TOOL] ✓ {tool_call.name} in {tool_call.duration_ms:.0f}ms")
                return tool_call
            except asyncio.TimeoutError:
                tool_call.status = ToolStatus.TIMEOUT
                tool_call.error  = f"Timeout >{timeout}s (attempt {attempt})"
                logger.warning(f"[TOOL] ⏱ {tool_call.name} timeout attempt {attempt}")
            except Exception as e:
                tool_call.status = ToolStatus.FAILURE
                tool_call.error  = f"{type(e).__name__}: {e}"
                logger.warning(f"[TOOL] ✗ {tool_call.name}: {e}")

            if attempt <= max_retries:
                delay = min(1.5 ** attempt, 8.0)
                logger.debug(f"[TOOL] Retrying {tool_call.name} in {delay:.1f}s")
                await asyncio.sleep(delay)

        return tool_call

    def schemas(self) -> list[dict]:
        return list(self._schemas.values())


# ─────────────────────────────────────────────
# LLM Provider — Claude / OpenAI / Gemini
# ─────────────────────────────────────────────

class LLMProvider:
    """
    Unified async interface for Claude, OpenAI, Gemini.
    Loads API keys from env (or .env via python-dotenv).
    Supports streaming.
    """

    MODELS = {
        "claude":   "claude-sonnet-4-20250514",
        "opus":     "claude-opus-4-6",
        "fast":     "claude-haiku-4-5-20251001",
        "openai":   "gpt-4o",
        "openai-mini": "gpt-4o-mini",
        "gemini":   "gemini-2.5-pro",
        "gemini-flash": "gemini-flash",
    }

    def __init__(self, model_alias: str = "claude"):
        self.model = self.MODELS.get(model_alias, model_alias)
        self._load_env()

    @staticmethod
    def _load_env():
        """Load .env if present."""
        try:
            from dotenv import load_dotenv
            load_dotenv(override=False)
        except ImportError:
            pass

    async def complete(
        self,
        messages:   list[dict],
        system:     str,
        tools:      list[dict] | None = None,
        max_tokens: int = 2048,
    ) -> tuple[str, int]:
        """Returns (text, tokens_used)."""
        if "claude" in self.model:
            return await self._claude(messages, system, tools, max_tokens)
        if "gpt" in self.model:
            return await self._openai(messages, system, tools, max_tokens)
        if "gemini" in self.model:
            return await self._gemini(messages, system, tools, max_tokens)
        raise ValueError(f"Unrecognised model: {self.model}")

    async def stream(
        self,
        messages: list[dict],
        system: str,
        max_tokens: int = 2048,
    ) -> AsyncIterator[str]:
        """Yield text chunks as they arrive (Claude streaming)."""
        if "claude" not in self.model:
            text, _ = await self.complete(messages, system, max_tokens=max_tokens)
            yield text
            return
        try:
            import anthropic
            client = anthropic.AsyncAnthropic()
            async with client.messages.stream(
                model=self.model, max_tokens=max_tokens,
                system=system, messages=messages,
            ) as s:
                async for chunk in s.text_stream:
                    yield chunk
        except ImportError:
            yield self._mock_response("claude-stream")

    # ── Private provider implementations ─────────────────────────────────

    async def _claude(self, messages, system, tools, max_tokens):
        try:
            import anthropic
            client = anthropic.AsyncAnthropic(
                api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            )
            kwargs: dict = dict(
                model=self.model, max_tokens=max_tokens,
                system=system, messages=messages,
            )
            if tools:
                kwargs["tools"] = [
                    {"name": t["name"], "description": t.get("description", ""),
                     "input_schema": t.get("parameters", {})}
                    for t in tools
                ]
            resp   = await client.messages.create(**kwargs)
            text   = ""
            for block in resp.content:
                if hasattr(block, "text"):
                    text += block.text
            tokens = resp.usage.input_tokens + resp.usage.output_tokens
            return text, tokens
        except ImportError:
            return self._mock_response("claude"), 500
        except Exception as e:
            logger.error(f"[LLM] Claude error: {e}")
            return json.dumps({"thought": f"LLM error: {e}", "action": "wait", "done": False}), 50

    async def _openai(self, messages, system, tools, max_tokens):
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))
            msgs   = [{"role": "system", "content": system}] + messages
            kwargs: dict = dict(model=self.model, max_tokens=max_tokens, messages=msgs)
            if tools:
                kwargs["tools"] = [{"type": "function", "function": t} for t in tools]
                kwargs["tool_choice"] = "auto"
            resp   = await client.chat.completions.create(**kwargs)
            msg    = resp.choices[0].message
            # Handle tool_calls response from OpenAI
            if msg.tool_calls:
                tc = msg.tool_calls[0]
                return json.dumps({
                    "thought": msg.content or "Using tool",
                    "action":  tc.function.name,
                    "args":    json.loads(tc.function.arguments),
                    "done":    False,
                }), resp.usage.total_tokens
            return msg.content or "", resp.usage.total_tokens
        except ImportError:
            return self._mock_response("openai"), 500
        except Exception as e:
            logger.error(f"[LLM] OpenAI error: {e}")
            return json.dumps({"thought": f"LLM error: {e}", "action": "wait", "done": False}), 50

    async def _gemini(self, messages, system, tools, max_tokens):
        try:
            import google.generativeai as genai
            genai.configure(api_key=os.environ.get("GOOGLE_API_KEY", ""))
            mdl    = genai.GenerativeModel(self.model, system_instruction=system)
            prompt = "\n".join(m["content"] for m in messages)
            resp   = await asyncio.to_thread(mdl.generate_content, prompt)
            tokens = getattr(getattr(resp, "usage_metadata", None), "total_token_count", 800)
            return resp.text, tokens
        except ImportError:
            return self._mock_response("gemini"), 500
        except Exception as e:
            logger.error(f"[LLM] Gemini error: {e}")
            return json.dumps({"thought": f"LLM error: {e}", "action": "wait", "done": False}), 50

    @staticmethod
    def _mock_response(provider: str) -> str:
        return json.dumps({
            "thought": f"[MOCK {provider.upper()}] SDK not installed — returning mock.",
            "action":  "complete",
            "args":    {},
            "plan":    ["Install SDK: pip install anthropic / openai / google-generativeai"],
            "confidence": 0.1,
            "done":    True,
        })


# ─────────────────────────────────────────────
# ReAct System Prompt
# ─────────────────────────────────────────────

SYSTEM_PROMPT = """You are an autonomous agent running the 2026 ReAct loop:
  Perceive → Reason → Plan → Act → Observe (repeat until done)

EVERY response MUST be valid JSON in this exact format:
{
  "thought":     "<internal reasoning — required, never empty>",
  "phase":       "perceive|reason|plan|act|observe|complete",
  "plan":        ["remaining step 1", "remaining step 2", ...],
  "action":      "<tool_name | 'complete' | 'wait'>",
  "args":        { ...tool arguments or {} },
  "confidence":  0.0-1.0,
  "done":        false
}

RULES:
1. Always reason BEFORE acting. The thought field must contain genuine reasoning.
2. If a tool fails: adapt the plan, try a different approach or different tool.
3. If you are looping (same action 3+ times): stop, rethink, choose different action.
4. Track remaining plan steps. Remove completed steps.
5. When the task is fully complete: set done=true and put the final answer in thought.
6. Be efficient — use the minimum steps needed.
7. NEVER emit anything outside the JSON block.
"""


# ─────────────────────────────────────────────
# Core ReAct Engine
# ─────────────────────────────────────────────

class ReActEngine:
    """
    Autonomous Perceive→Reason→Plan→Act→Observe loop.
    Features: self-healing, loop detection, token budget hard stops,
    streaming callbacks, session export, graceful cancel.
    """

    def __init__(
        self,
        registry: ToolRegistry,
        provider: LLMProvider,
        budget:   BudgetState | None = None,
        on_step:  Callable | None = None,
    ):
        self.registry   = registry
        self.provider   = provider
        self.budget     = budget or BudgetState()
        self.on_step    = on_step
        self._cancel    = asyncio.Event()

    def cancel(self):
        """Signal graceful shutdown."""
        self._cancel.set()
        logger.info("[ENGINE] Cancel requested")

    async def run(
        self,
        task: str,
        context: dict | None = None,
        tags: list[str] | None = None,
        metadata: dict | None = None,
        save_session: bool = False,
    ) -> AgentSession:
        session = AgentSession(
            task     = task,
            model    = self.provider.model,
            budget   = self.budget,
            context  = context or {},
            tags     = tags or [],
            metadata = metadata or {},
        )
        logger.info(f"[ENGINE] ▶ Session {session.session_id} | model={self.provider.model} | task={task[:80]}")

        try:
            await self._loop(session)
        except asyncio.CancelledError:
            session.phase = AgentPhase.CANCELLED
            logger.warning(f"[ENGINE] Session {session.session_id} cancelled")
        finally:
            session.ended_at = time.time()
            logger.info(
                f"[ENGINE] ■ Session {session.session_id} | phase={session.phase.value} | "
                f"steps={len(session.steps)} | duration={session.duration_s()}s | "
                f"tokens={session.budget.total_used:,} | cost=${session.budget.cost_usd:.5f}"
            )
            if save_session:
                session.save()

        return session

    async def _loop(self, session: AgentSession):
        while True:
            # ── Hard stops ───────────────────────────────────────────────
            if self._cancel.is_set():
                session.phase = AgentPhase.CANCELLED
                break
            if session.budget.iter_remaining == 0:
                session.phase = AgentPhase.BUDGET_HIT
                logger.error("[ENGINE] Iteration cap reached")
                break
            if session.budget.remaining < 300:
                session.phase = AgentPhase.BUDGET_HIT
                logger.error("[ENGINE] Token budget exhausted")
                break
            if session.budget.error_streak >= session.budget.max_error_streak:
                session.phase = AgentPhase.FAILED
                logger.error("[ENGINE] Error streak cap — halting")
                break
            if session.budget.is_looping:
                # Inject loop-breaking instruction into context
                session.context["LOOP_DETECTED"] = (
                    f"You have called '{session.budget.last_action}' "
                    f"{session.budget.same_action_streak} times. STOP. Choose a DIFFERENT action."
                )
                logger.warning(f"[ENGINE] Loop detected on '{session.budget.last_action}'")

            # ── New step ─────────────────────────────────────────────────
            step = AgentStep()
            session.budget.reset_step()
            session.budget.iterations_done += 1
            step.phase = AgentPhase.PERCEIVE

            # ── PERCEIVE: build context ──────────────────────────────────
            history  = session.to_history()
            user_msg = self._build_user_message(session)
            messages = history + [{"role": "user", "content": user_msg}]

            # ── REASON + PLAN: call LLM ──────────────────────────────────
            step.phase = AgentPhase.REASON
            raw, tokens = await self.provider.complete(
                messages   = messages,
                system     = SYSTEM_PROMPT,
                tools      = self.registry.schemas() or None,
                max_tokens = min(2048, max(256, session.budget.per_step_limit - 200)),
            )
            ok = session.budget.charge(tokens, self.provider.model)
            step.tokens_used = tokens

            parsed = self._parse_response(raw)
            step.thought    = parsed.get("thought", raw[:300])
            step.plan       = parsed.get("plan", [])
            step.confidence = float(parsed.get("confidence", 0.5))

            try:
                step.phase = AgentPhase(parsed.get("phase", "act"))
            except ValueError:
                step.phase = AgentPhase.ACT

            action = parsed.get("action", "wait")
            session.budget.track_action(action)

            logger.info(
                f"[ENGINE] Step {session.budget.iterations_done:02d} | "
                f"phase={step.phase.value:<8} action={action:<20} "
                f"conf={step.confidence:.2f} tokens={tokens}"
            )

            # ── DONE check ───────────────────────────────────────────────
            if parsed.get("done") or action == "complete":
                session.final_result = step.thought
                session.phase        = AgentPhase.COMPLETE
                session.steps.append(step)
                break

            # ── ACT ──────────────────────────────────────────────────────
            step.phase = AgentPhase.ACT
            if action and action not in ("wait", "none", ""):
                tc = ToolCall(name=action, args=parsed.get("args", {}))
                tc = await self.registry.call(tc)
                step.tool_calls.append(tc)

                if tc.status == ToolStatus.SUCCESS:
                    session.budget.error_streak = 0
                    # Merge dict results into shared context
                    if isinstance(tc.result, dict):
                        session.context.update(
                            {f"last_{action}": tc.result}
                        )
                else:
                    session.budget.error_streak += 1

                # ── OBSERVE ──────────────────────────────────────────────
                step.phase       = AgentPhase.OBSERVE
                step.observation = self._format_observation(tc)

            session.steps.append(step)

            # ── Emit to UI / callback ────────────────────────────────────
            if self.on_step:
                payload = {
                    "session_id":  session.session_id,
                    "iteration":   session.budget.iterations_done,
                    "phase":       step.phase.value,
                    "thought":     step.thought,
                    "plan":        step.plan,
                    "confidence":  step.confidence,
                    "tools":       [t.to_dict() for t in step.tool_calls],
                    "observation": step.observation,
                    "budget":      session.budget.summary(),
                }
                if asyncio.iscoroutinefunction(self.on_step):
                    await self.on_step(payload)
                else:
                    self.on_step(payload)

            if not ok:
                session.phase = AgentPhase.BUDGET_HIT
                break

    # ── Helpers ──────────────────────────────────────────────────────────

    def _build_user_message(self, session: AgentSession) -> str:
        b   = session.budget
        ctx = session.context
        # Keep context snippet small — only last 800 chars
        ctx_str = json.dumps(ctx, default=str)
        if len(ctx_str) > 800:
            ctx_str = ctx_str[-800:]
        loop_warn = ""
        if "LOOP_DETECTED" in ctx:
            loop_warn = f"\n⚠️  WARNING: {ctx['LOOP_DETECTED']}\n"
        return (
            f"TASK: {session.task}\n"
            f"ITERATION: {b.iterations_done + 1}/{b.iteration_limit} | "
            f"TOKENS LEFT: {b.remaining:,} | COST SO FAR: ${b.cost_usd:.4f}\n"
            f"AVAILABLE TOOLS: {self.registry.list_tools()}\n"
            f"{loop_warn}"
            f"CONTEXT:\n{ctx_str}\n\n"
            "What is your next action? Respond ONLY in the required JSON format."
        )

    @staticmethod
    def _parse_response(raw: str) -> dict:
        clean = raw.strip()
        # Strip markdown fences
        if "```" in clean:
            parts = clean.split("```")
            for part in parts:
                p = part.lstrip("json").strip()
                try:
                    return json.loads(p)
                except Exception:
                    continue
        try:
            return json.loads(clean)
        except Exception:
            # Last resort: extract first JSON object
            import re
            m = re.search(r'\{.*\}', clean, re.DOTALL)
            if m:
                try:
                    return json.loads(m.group())
                except Exception:
                    pass
        return {"thought": raw[:300], "action": "wait", "done": False, "confidence": 0.1}

    @staticmethod
    def _format_observation(tc: ToolCall) -> str:
        if tc.status == ToolStatus.SUCCESS:
            result_str = json.dumps(tc.result, default=str)[:800] if tc.result is not None else "null"
            return f"✓ '{tc.name}' succeeded ({tc.duration_ms:.0f}ms): {result_str}"
        return f"✗ '{tc.name}' {tc.status.value} (attempt {tc.attempt}): {tc.error}"
