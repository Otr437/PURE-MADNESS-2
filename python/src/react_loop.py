"""
Production ReAct Loop — Python
Reason → Act → Observe, repeat until answer found.

Multi-provider via model_router: ANTHROPIC_API_KEY (Claude), DEEPSEEK_API_KEY,
or OPENAI_API_KEY depending on MODEL_PROVIDER env var.

pip install anthropic==0.50.0 openai==2.30.0 tavily-python==0.7.12 tenacity==9.1.2 structlog==24.4.0

export MODEL_PROVIDER=anthropic   # or deepseek | deepseek-openai | openai
export ANTHROPIC_API_KEY=sk-ant-...
export TAVILY_API_KEY=tvly-...
"""

import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import structlog
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from model_router import ModelRouter, TextBlock, ToolUseBlock, make_tool_result_message

# ── Logging ───────────────────────────────────────────────────────────────────
structlog.configure(processors=[
    structlog.processors.TimeStamper(fmt="iso"),
    structlog.processors.add_log_level,
    structlog.dev.ConsoleRenderer(),
])
log = structlog.get_logger()


# ── ReAct trace types ─────────────────────────────────────────────────────────
@dataclass
class Thought:
    content: str
    type: str = field(default="thought", init=False)


@dataclass
class Action:
    tool: str
    input: dict
    type: str = field(default="action", init=False)


@dataclass
class Observation:
    content: str
    is_error: bool = False
    type: str = field(default="observation", init=False)


@dataclass
class Answer:
    content: str
    type: str = field(default="answer", init=False)


@dataclass
class Trace:
    steps: list = field(default_factory=list)
    total_tokens: int = 0
    iterations: int = 0
    elapsed_s: float = 0.0

    def add(self, step):
        self.steps.append(step)

    def to_dict(self):
        out = []
        for s in self.steps:
            if isinstance(s, Thought):
                out.append({"type": "thought", "content": s.content})
            elif isinstance(s, Action):
                out.append({"type": "action", "tool": s.tool, "input": s.input})
            elif isinstance(s, Observation):
                out.append({"type": "observation", "content": s.content, "error": s.is_error})
            elif isinstance(s, Answer):
                out.append({"type": "answer", "content": s.content})
        return out


# ── Tool registry ─────────────────────────────────────────────────────────────
TOOL_REGISTRY: dict[str, Callable] = {}
TOOL_SCHEMAS: list[dict] = []


def tool(name: str, description: str, schema: dict):
    """Decorator to register a tool."""
    def decorator(fn: Callable):
        TOOL_REGISTRY[name] = fn
        TOOL_SCHEMAS.append({
            "name": name,
            "description": description,
            "input_schema": schema,
        })
        return fn
    return decorator


# ── Built-in tools ──────────────────────────────────────────────────────────────

@tool(
    name="think",
    description="Use this to reason step by step before acting. Does not call any external system.",
    schema={
        "type": "object",
        "properties": {"reasoning": {"type": "string", "description": "Your chain of thought"}},
        "required": ["reasoning"],
    },
)
def think(reasoning: str) -> str:
    return "OK"


# Lazily-constructed Tavily client (avoids hard failure if TAVILY_API_KEY unset at import time)
_tavily_client = None


def _get_tavily():
    global _tavily_client
    if _tavily_client is None:
        from tavily import TavilyClient
        api_key = os.environ.get("TAVILY_API_KEY")
        if not api_key:
            raise RuntimeError(
                "TAVILY_API_KEY is not set. Get a free key at https://app.tavily.com "
                "and `export TAVILY_API_KEY=tvly-...`"
            )
        _tavily_client = TavilyClient(api_key=api_key)
    return _tavily_client


@tool(
    name="search",
    description="Search the live web for current information. Returns titles, URLs, and content snippets.",
    schema={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "num_results": {"type": "integer", "description": "Number of results (default 5, max 10)"},
            "search_depth": {"type": "string", "enum": ["basic", "advanced"], "description": "basic (fast) or advanced (deeper, slower)"},
        },
        "required": ["query"],
    },
)
def search(query: str, num_results: int = 5, search_depth: str = "basic") -> str:
    client = _get_tavily()
    response = client.search(
        query=query,
        max_results=min(max(num_results, 1), 10),
        search_depth=search_depth,
        include_answer=True,
    )

    parts = []
    if response.get("answer"):
        parts.append(f"Direct answer: {response['answer']}")

    for i, r in enumerate(response.get("results", []), 1):
        content = r.get("content", "")[:600]
        parts.append(f"[{i}] {r.get('title', '')}\nURL: {r.get('url', '')}\n{content}")

    return "\n\n".join(parts) if parts else "No results found."


@tool(
    name="fetch_url",
    description="Fetch and extract the readable text content of a specific URL.",
    schema={
        "type": "object",
        "properties": {"url": {"type": "string"}},
        "required": ["url"],
    },
)
def fetch_url(url: str) -> str:
    try:
        # Prefer Tavily's extract endpoint for clean, agent-ready content
        client = _get_tavily()
        response = client.extract(urls=[url])
        results = response.get("results", [])
        if results:
            return results[0].get("raw_content", "")[:8000]
    except Exception:
        pass

    # Fallback: raw HTTP fetch + HTML strip
    import urllib.request
    with urllib.request.urlopen(url, timeout=10) as r:
        raw = r.read().decode("utf-8", errors="replace")
    clean = re.sub(r"<script.*?</script>", " ", raw, flags=re.S | re.I)
    clean = re.sub(r"<style.*?</style>", " ", clean, flags=re.S | re.I)
    clean = re.sub(r"<[^>]+>", " ", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean[:8000]


@tool(
    name="run_python",
    description="Execute Python code in a sandboxed subprocess. Returns combined stdout + stderr. Timeout 15s.",
    schema={
        "type": "object",
        "properties": {"code": {"type": "string"}},
        "required": ["code"],
    },
)
def run_python(code: str) -> str:
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, timeout=15,
    )
    out = result.stdout or ""
    err = result.stderr or ""
    combined = (out + err).strip()
    return combined[:8000] if combined else "(no output)"


@tool(
    name="read_file",
    description="Read a file from disk (UTF-8 text).",
    schema={
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
)
def read_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()[:16000]


@tool(
    name="write_file",
    description="Write content to a file on disk, creating parent directories if needed.",
    schema={
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": ["path", "content"],
    },
)
def write_file(path: str, content: str) -> str:
    import pathlib
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)
    return f"Written {len(content)} bytes to {path}"


@tool(
    name="finish",
    description="Call this when you have the final answer. Ends the loop.",
    schema={
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
    },
)
def finish(answer: str) -> str:
    return answer


# ── Model router (multi-provider: Claude / DeepSeek / OpenAI) ────────────────
_router = ModelRouter()


@retry(
    retry=retry_if_exception_type(Exception),
    wait=wait_exponential(multiplier=1, min=2, max=60),
    stop=stop_after_attempt(6),
)
def _call_model(messages: list, system: str):
    return _router.create(messages=messages, tools=TOOL_SCHEMAS, system=system, max_tokens=4096)


# ── ReAct system prompt ───────────────────────────────────────────────────────
REACT_SYSTEM = """You are an autonomous agent operating in a ReAct loop (Reason + Act + Observe).

For every task:
1. Use the `think` tool to reason about what to do next before acting.
2. Call the appropriate tool to act.
3. Observe the result and reason again.
4. Repeat until you have a complete, verified answer.
5. Call `finish` with your final answer when done.

Rules:
- Always think before acting. Never skip the think step.
- If a tool errors, reason about why and try a different approach.
- Do not guess. If unsure, use `search` or `fetch_url`.
- Be thorough. Do not call finish until the task is fully complete.
"""


# ── Core ReAct engine ─────────────────────────────────────────────────────────
def run_react(
    task: str,
    system_extra: str = "",
    max_iterations: int = 30,
    on_step: Callable[[Any], None] | None = None,
) -> tuple[str, Trace]:
    """
    Run a full ReAct loop.

    Args:
        task:           The task/question to solve.
        system_extra:   Additional system instructions appended to base prompt.
        max_iterations: Hard iteration cap.
        on_step:        Optional callback called after each Thought/Action/Observation.

    Returns:
        (final_answer: str, trace: Trace)
    """
    system = REACT_SYSTEM + ("\n\n" + system_extra if system_extra else "")
    messages: list[dict] = [{"role": "user", "content": task}]
    trace = Trace()
    start = time.time()

    log.info("react.start", task=task[:120], provider=_router.provider, model=_router.model)

    for i in range(max_iterations):
        trace.iterations = i + 1
        log.info("react.iteration", n=i + 1)

        response = _call_model(messages, system)
        trace.total_tokens += response.usage.input_tokens + response.usage.output_tokens
        messages.append(response.to_assistant_message())

        if response.stop_reason == "end_turn":
            for block in response.content:
                if isinstance(block, TextBlock) and block.text.strip():
                    answer = block.text.strip()
                    trace.add(Answer(answer))
                    trace.elapsed_s = round(time.time() - start, 2)
                    log.info("react.done", via="end_turn", **_trace_stats(trace))
                    return answer, trace

        if response.stop_reason == "tool_use":
            for block in response.content:
                if not isinstance(block, ToolUseBlock):
                    continue

                tool_name = block.name
                tool_input = block.input

                if tool_name == "think":
                    thought = Thought(tool_input.get("reasoning", ""))
                    trace.add(thought)
                    if on_step:
                        on_step(thought)
                    log.info("react.thought", content=thought.content[:200])
                    messages.append(make_tool_result_message(block.id, "OK"))
                    continue

                if tool_name == "finish":
                    answer = tool_input.get("answer", "")
                    trace.add(Answer(answer))
                    trace.elapsed_s = round(time.time() - start, 2)
                    log.info("react.done", via="finish", **_trace_stats(trace))
                    return answer, trace

                action = Action(tool=tool_name, input=tool_input)
                trace.add(action)
                if on_step:
                    on_step(action)
                log.info("react.action", tool=tool_name, input=str(tool_input)[:200])

                is_error = False
                try:
                    if tool_name not in TOOL_REGISTRY:
                        raise ValueError(f"Tool '{tool_name}' not registered")
                    result = str(TOOL_REGISTRY[tool_name](**tool_input))
                except Exception as e:
                    result = f"Tool error ({type(e).__name__}): {e}"
                    is_error = True
                    log.error("react.tool_error", tool=tool_name, error=str(e))

                observation = Observation(content=result, is_error=is_error)
                trace.add(observation)
                if on_step:
                    on_step(observation)
                log.info("react.observation", tool=tool_name,
                         result_len=len(result), error=is_error)

                messages.append(make_tool_result_message(block.id, result, is_error=is_error))

            continue

        log.warning("react.unexpected_stop", stop_reason=response.stop_reason)
        break

    trace.elapsed_s = round(time.time() - start, 2)
    raise RuntimeError(
        f"ReAct loop did not finish within {max_iterations} iterations. "
        f"Tokens used: {trace.total_tokens}"
    )


def _trace_stats(trace: Trace) -> dict:
    return {
        "iterations": trace.iterations,
        "tokens": trace.total_tokens,
        "elapsed_s": trace.elapsed_s,
        "steps": len(trace.steps),
    }


# ── CLI entry point ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    task = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else (
        "Calculate the 47th Fibonacci number using code, then explain the result."
    )

    def print_step(step):
        if isinstance(step, Thought):
            print(f"\n💭 THOUGHT: {step.content[:300]}")
        elif isinstance(step, Action):
            print(f"\n⚡ ACTION: {step.tool}({json.dumps(step.input)[:200]})")
        elif isinstance(step, Observation):
            marker = "❌" if step.is_error else "👁"
            print(f"\n{marker} OBSERVE: {step.content[:300]}")

    answer, trace = run_react(task, on_step=print_step)

    print("\n" + "=" * 60)
    print("FINAL ANSWER:")
    print(answer)
    print("=" * 60)
    print(f"Iterations: {trace.iterations} | Tokens: {trace.total_tokens} | Time: {trace.elapsed_s}s")
    print("\nFull trace (JSON):")
    print(json.dumps(trace.to_dict(), indent=2))
