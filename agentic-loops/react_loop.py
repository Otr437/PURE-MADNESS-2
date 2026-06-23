"""
Production ReAct Loop — Python
Reason → Act → Observe, repeat until answer found.

pip install anthropic tenacity structlog
export ANTHROPIC_API_KEY=sk-ant-...
"""

import os
import re
import time
import json
import subprocess
import sys
from typing import Callable, Any
from dataclasses import dataclass, field

import structlog
from anthropic import Anthropic, APIStatusError, APIConnectionError, RateLimitError
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

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

@dataclass
class Action:
    tool: str
    input: dict

@dataclass
class Observation:
    content: str
    is_error: bool = False

@dataclass
class Answer:
    content: str

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

# ── Built-in tools (replace bodies with real implementations) ─────────────────

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

@tool(
    name="search",
    description="Search the web for current information.",
    schema={
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "num_results": {"type": "integer", "default": 5},
        },
        "required": ["query"],
    },
)
def search(query: str, num_results: int = 5) -> str:
    # Replace with: SerpAPI, Brave Search, Tavily, etc.
    raise NotImplementedError("Wire up your search API here")

@tool(
    name="fetch_url",
    description="Fetch the text content of a URL.",
    schema={
        "type": "object",
        "properties": {"url": {"type": "string"}},
        "required": ["url"],
    },
)
def fetch_url(url: str) -> str:
    import urllib.request
    with urllib.request.urlopen(url, timeout=10) as r:
        raw = r.read().decode("utf-8", errors="replace")
    # Strip HTML tags
    clean = re.sub(r"<[^>]+>", " ", raw)
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean[:8000]  # truncate to avoid context overflow

@tool(
    name="run_python",
    description="Execute Python code. Returns stdout + stderr. Timeout 15s.",
    schema={
        "type": "object",
        "properties": {"code": {"type": "string"}},
        "required": ["code"],
    },
)
def run_python(code: str) -> str:
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, timeout=15
    )
    out = result.stdout or ""
    err = result.stderr or ""
    combined = (out + err).strip()
    return combined[:8000] if combined else "(no output)"

@tool(
    name="read_file",
    description="Read a file from disk.",
    schema={
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
)
def read_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

@tool(
    name="write_file",
    description="Write content to a file on disk.",
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
    with open(path, "w", encoding="utf-8") as f:
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

# ── API call with retry ───────────────────────────────────────────────────────
client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"], timeout=60.0, max_retries=0)

@retry(
    retry=retry_if_exception_type((APIConnectionError, RateLimitError)),
    wait=wait_exponential(multiplier=1, min=2, max=60),
    stop=stop_after_attempt(6),
)
def _call_api(messages: list, system: str) -> Any:
    return client.messages.create(
        model="claude-opus-4-6",
        max_tokens=4096,
        system=system,
        tools=TOOL_SCHEMAS,
        messages=messages,
    )

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
- Do not guess. If unsure, search or fetch.
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
    messages = [{"role": "user", "content": task}]
    trace = Trace()
    start = time.time()

    log.info("react.start", task=task[:120])

    for i in range(max_iterations):
        trace.iterations = i + 1
        log.info("react.iteration", n=i + 1)

        try:
            response = _call_api(messages, system)
        except APIStatusError as e:
            log.error("react.api_error", status=e.status_code, body=e.message)
            raise RuntimeError(f"API error {e.status_code}: {e.message}") from e

        trace.total_tokens += response.usage.input_tokens + response.usage.output_tokens
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason == "end_turn":
            # Model responded with text instead of tool call — treat as final answer
            for block in response.content:
                if hasattr(block, "text") and block.text.strip():
                    answer = block.text.strip()
                    trace.add(Answer(answer))
                    trace.elapsed_s = round(time.time() - start, 2)
                    log.info("react.done", via="end_turn", **_trace_stats(trace))
                    return answer, trace

        if response.stop_reason == "tool_use":
            tool_results = []

            for block in response.content:
                if block.type == "tool_use":
                    tool_name = block.name
                    tool_input = block.input

                    # Record thought separately from actions
                    if tool_name == "think":
                        thought = Thought(tool_input.get("reasoning", ""))
                        trace.add(thought)
                        if on_step:
                            on_step(thought)
                        log.info("react.thought", content=thought.content[:200])
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": "OK",
                        })
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

                    # Execute tool
                    is_error = False
                    try:
                        if tool_name not in TOOL_REGISTRY:
                            raise ValueError(f"Tool '{tool_name}' not registered")
                        result = str(TOOL_REGISTRY[tool_name](**tool_input))
                    except NotImplementedError as e:
                        result = f"Tool not yet implemented: {e}. Use a different approach."
                        is_error = True
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

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                        "is_error": is_error,
                    })

            messages.append({"role": "user", "content": tool_results})
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
    import sys

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
