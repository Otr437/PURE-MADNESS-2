"""
Production Agentic Loop — Python
Multi-provider via ModelRouter (Claude / DeepSeek / OpenAI).
All tools are real implementations pulled from react_loop.TOOL_REGISTRY — no stubs.

export MODEL_PROVIDER=anthropic|deepseek|openai
export ANTHROPIC_API_KEY=sk-ant-...  (or DEEPSEEK_API_KEY / OPENAI_API_KEY)
export TAVILY_API_KEY=tvly-...       (for the search tool)

Usage:
    from agent_loop import AgentLoop
    loop = AgentLoop()
    answer = loop.run("Find the current Bitcoin price and summarise in one sentence.")

CLI:
    python src/agent_loop.py "your task"
"""

import json
import sys
import time
from typing import Callable

import structlog

from model_router import ModelRouter, TextBlock, ToolUseBlock
from react_loop import TOOL_REGISTRY, TOOL_SCHEMAS

# ── Structured logger ─────────────────────────────────────────────────────────
structlog.configure(processors=[
    structlog.processors.TimeStamper(fmt="iso"),
    structlog.processors.add_log_level,
    structlog.processors.JSONRenderer(),
])
log = structlog.get_logger()


class AgentLoop:
    """
    Minimal single-shot agentic loop using ModelRouter + react_loop tool registry.
    For multi-step ReAct behaviour with explicit Thought/Act/Observe, use RunReact()
    from react_loop.py instead.

    All tools are real implementations registered in react_loop.py:
      - think        : chain-of-thought reasoning (no external call)
      - search       : live web search via Tavily API
      - fetch_url    : HTTP fetch + HTML strip via Tavily extract
      - run_python   : subprocess Python execution (15s timeout)
      - read_file    : read file from disk (UTF-8)
      - write_file   : write file to disk
      - finish       : terminate the loop and return the answer
      - rag_search   : hybrid RAG retrieval (if injected by rag_agent.py)

    Additional tools can be registered at runtime:
        from react_loop import TOOL_REGISTRY, TOOL_SCHEMAS
        TOOL_REGISTRY["my_tool"] = lambda **kwargs: "result"
        TOOL_SCHEMAS.append({ "name": "my_tool", ... })
    """

    def __init__(
        self,
        provider: str | None = None,
        model:    str | None = None,
        max_iterations: int = 20,
        system: str | None = None,
    ) -> None:
        self._router = ModelRouter(provider=provider, model=model)
        self._max_iterations = max_iterations
        self._system = system or (
            "You are a helpful assistant. Use the provided tools to complete tasks. "
            "Think before acting, and call finish with your final answer when done."
        )
        log.info(
            "agent_loop.init",
            provider=self._router.provider,
            model=self._router.model,
            max_iterations=self._max_iterations,
        )

    def run(
        self,
        user_message: str,
        on_tool_call: Callable[[str, dict, str, bool], None] | None = None,
    ) -> str:
        """
        Run the agentic loop until finish() is called or max_iterations reached.

        Args:
            user_message:  Task for the agent to complete.
            on_tool_call:  Optional callback(tool_name, tool_input, result, is_error).

        Returns:
            Final answer string.

        Raises:
            RuntimeError if the loop does not finish within max_iterations.
        """
        messages: list[dict] = [{"role": "user", "content": user_message}]
        start = time.perf_counter()
        total_tokens = 0

        log.info("agent_loop.start", task=user_message[:120],
                 provider=self._router.provider, model=self._router.model)

        for i in range(self._max_iterations):
            log.info("agent_loop.iteration", n=i + 1)

            response = self._router.create(
                messages=messages,
                tools=TOOL_SCHEMAS,
                system=self._system,
                max_tokens=4096,
            )
            total_tokens += response.usage.input_tokens + response.usage.output_tokens
            messages.append(response.to_assistant_message())

            if response.stop_reason == "end_turn":
                for block in response.content:
                    if isinstance(block, TextBlock) and block.text.strip():
                        elapsed = round(time.perf_counter() - start, 3)
                        log.info("agent_loop.done", via="end_turn",
                                 iterations=i + 1, total_tokens=total_tokens, elapsed_s=elapsed)
                        return block.text.strip()

            if response.stop_reason == "tool_use":
                tool_result_blocks: list[dict] = []

                for block in response.content:
                    if not isinstance(block, ToolUseBlock):
                        continue

                    name  = block.name
                    input_ = block.input

                    # finish — return immediately
                    if name == "finish":
                        answer = str(input_.get("answer", ""))
                        elapsed = round(time.perf_counter() - start, 3)
                        log.info("agent_loop.done", via="finish",
                                 iterations=i + 1, total_tokens=total_tokens, elapsed_s=elapsed)
                        return answer

                    # think — no external call, just log
                    if name == "think":
                        reasoning = str(input_.get("reasoning", ""))
                        log.info("agent_loop.thought", content=reasoning[:200])
                        tool_result_blocks.append({
                            "type":        "tool_result",
                            "tool_use_id": block.id,
                            "content":     "OK",
                        })
                        continue

                    log.info("agent_loop.action", tool=name,
                             input=json.dumps(input_)[:200])

                    fn = TOOL_REGISTRY.get(name)
                    is_error = False
                    if fn is None:
                        result   = f"Tool '{name}' is not registered"
                        is_error = True
                        log.error("agent_loop.tool_missing", tool=name)
                    else:
                        try:
                            result = str(fn(**input_))
                        except Exception as exc:
                            result   = f"Tool error ({name}): {exc}"
                            is_error = True
                            log.error("agent_loop.tool_error", tool=name, error=str(exc))

                    log.info("agent_loop.observation", tool=name,
                             result_len=len(result), error=is_error)

                    if on_tool_call:
                        on_tool_call(name, input_, result, is_error)

                    tool_result_blocks.append({
                        "type":        "tool_result",
                        "tool_use_id": block.id,
                        "content":     result,
                        "is_error":    is_error,
                    })

                messages.append({"role": "user", "content": tool_result_blocks})
                continue

            log.warning("agent_loop.unexpected_stop", stop_reason=response.stop_reason)
            break

        elapsed = round(time.perf_counter() - start, 3)
        raise RuntimeError(
            f"AgentLoop did not finish within {self._max_iterations} iterations. "
            f"Tokens used: {total_tokens}, elapsed: {elapsed}s"
        )


# ── CLI entry point ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    task = " ".join(sys.argv[1:]) or (
        "Use bash to find the current date and time, then report it clearly."
    )

    loop = AgentLoop()
    answer = loop.run(
        task,
        on_tool_call=lambda name, inp, result, err: print(
            f"\n{'❌' if err else '⚡'} {name}({json.dumps(inp)[:100]})"
            f"\n{'❌' if err else '👁'} {result[:200]}"
        ),
    )
    print(f"\n{'='*60}\nFINAL ANSWER\n{'='*60}\n{answer}")
