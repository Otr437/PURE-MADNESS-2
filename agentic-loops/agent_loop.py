"""
Production Agentic Loop — Python
pip install anthropic tenacity structlog
export ANTHROPIC_API_KEY=sk-ant-...
"""

import os
import json
import time
import logging
import structlog
from typing import Callable, Any
from anthropic import Anthropic, APIStatusError, APIConnectionError, RateLimitError
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

# ── Logging ───────────────────────────────────────────────────────────────────
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.dev.ConsoleRenderer(),
    ]
)
log = structlog.get_logger()

# ── Client ────────────────────────────────────────────────────────────────────
client = Anthropic(
    api_key=os.environ["ANTHROPIC_API_KEY"],
    timeout=60.0,
    max_retries=0,  # we handle retries manually via tenacity
)

# ── Tool registry ─────────────────────────────────────────────────────────────
# Register callables here: name → python function
TOOL_REGISTRY: dict[str, Callable[..., Any]] = {}

def register_tool(name: str):
    def decorator(fn: Callable):
        TOOL_REGISTRY[name] = fn
        return fn
    return decorator

# ── Example tools (replace with your real ones) ───────────────────────────────
@register_tool("get_weather")
def get_weather(city: str) -> str:
    # TODO: call real weather API
    return f"72°F, sunny in {city}"

@register_tool("search_web")
def search_web(query: str) -> str:
    # TODO: call real search API
    return f"Top results for: {query}"

@register_tool("run_python")
def run_python(code: str) -> str:
    import subprocess, sys
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, timeout=10
    )
    return result.stdout or result.stderr

# ── Tool definitions for the API ──────────────────────────────────────────────
TOOLS = [
    {
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "input_schema": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
    {
        "name": "search_web",
        "description": "Search the web for a query.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "run_python",
        "description": "Execute Python code and return stdout/stderr.",
        "input_schema": {
            "type": "object",
            "properties": {"code": {"type": "string"}},
            "required": ["code"],
        },
    },
]

# ── Retryable API call ────────────────────────────────────────────────────────
@retry(
    retry=retry_if_exception_type((APIConnectionError, RateLimitError)),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    stop=stop_after_attempt(5),
)
def call_api(messages: list, system: str | None = None) -> Any:
    kwargs = dict(
        model="claude-opus-4-6",
        max_tokens=4096,
        tools=TOOLS,
        messages=messages,
    )
    if system:
        kwargs["system"] = system
    return client.messages.create(**kwargs)

# ── Core agent loop ───────────────────────────────────────────────────────────
def run_agent(
    user_message: str,
    system: str | None = None,
    max_iterations: int = 20,
    on_tool_call: Callable[[str, dict, str], None] | None = None,
) -> str:
    """
    Run a full agentic loop.

    Args:
        user_message:   The task to complete.
        system:         Optional system prompt.
        max_iterations: Hard cap on loop turns.
        on_tool_call:   Optional callback(tool_name, tool_input, result).

    Returns:
        Final text response from the model.

    Raises:
        RuntimeError on unrecoverable API error or unknown tool.
    """
    messages = [{"role": "user", "content": user_message}]
    iteration = 0
    start_time = time.time()

    log.info("agent.start", message=user_message[:120])

    while iteration < max_iterations:
        iteration += 1
        log.info("agent.iteration", n=iteration)

        try:
            response = call_api(messages, system=system)
        except APIStatusError as e:
            log.error("agent.api_error", status=e.status_code, body=e.message)
            raise RuntimeError(f"API error {e.status_code}: {e.message}") from e

        messages.append({"role": "assistant", "content": response.content})

        log.info("agent.response", stop_reason=response.stop_reason,
                 usage=response.usage.model_dump())

        # ── Done ──────────────────────────────────────────────────────────────
        if response.stop_reason == "end_turn":
            elapsed = round(time.time() - start_time, 2)
            log.info("agent.done", iterations=iteration, elapsed_s=elapsed)
            for block in response.content:
                if hasattr(block, "text"):
                    return block.text
            return ""

        # ── Tool use ──────────────────────────────────────────────────────────
        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue

                tool_name = block.name
                tool_input = block.input

                if tool_name not in TOOL_REGISTRY:
                    err = f"Tool '{tool_name}' not registered."
                    log.error("agent.tool_missing", tool=tool_name)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": err,
                        "is_error": True,
                    })
                    continue

                log.info("agent.tool_call", tool=tool_name, input=tool_input)
                try:
                    result = str(TOOL_REGISTRY[tool_name](**tool_input))
                except Exception as exc:
                    result = f"Tool error: {exc}"
                    log.error("agent.tool_error", tool=tool_name, error=str(exc))

                log.info("agent.tool_result", tool=tool_name,
                         result_len=len(result))

                if on_tool_call:
                    on_tool_call(tool_name, tool_input, result)

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                })

            messages.append({"role": "user", "content": tool_results})
            continue

        # ── Unexpected stop reason ────────────────────────────────────────────
        log.warning("agent.unexpected_stop", stop_reason=response.stop_reason)
        break

    raise RuntimeError(f"Agent did not complete within {max_iterations} iterations.")


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    result = run_agent(
        user_message="Search the web for the latest news on AI agents, then write a 3-bullet summary.",
        system="You are a research assistant. Be concise.",
    )
    print("\n=== FINAL ANSWER ===")
    print(result)
