#!/usr/bin/env python3
"""
Production Runtime Harness — Python
Wires react_loop.py into a fully runnable CLI agent.

Usage:
  python run_agent.py "your task here"
  python run_agent.py --system "You are a DevOps expert." "audit my /tmp directory"
  python run_agent.py --max-iter 50 --json-out /tmp/result.json "your task"
  echo "your task" | python run_agent.py -

Environment:
  ANTHROPIC_API_KEY   required
  AGENT_MAX_ITER      default 30
  AGENT_SYSTEM        default system prompt override
  AGENT_LOG_LEVEL     debug | info (default info)
"""

import argparse
import json
import logging
import os
import signal
import sys
import time
import traceback
from pathlib import Path

# ── Logging setup ─────────────────────────────────────────────────────────────
log_level = os.environ.get("AGENT_LOG_LEVEL", "info").upper()
logging.basicConfig(
    level=getattr(logging, log_level, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    stream=sys.stderr,
)
log = logging.getLogger("harness")

# ── Validate environment ──────────────────────────────────────────────────────
def validate_env():
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        log.error("ANTHROPIC_API_KEY is not set")
        sys.exit(1)
    if not key.startswith("sk-ant-"):
        log.warning("ANTHROPIC_API_KEY does not look like a valid Anthropic key")

# ── Signal handling ───────────────────────────────────────────────────────────
_interrupted = False

def _handle_sigint(sig, frame):
    global _interrupted
    if _interrupted:
        log.error("Force quit")
        sys.exit(130)
    _interrupted = True
    log.warning("Interrupt received — finishing current iteration then stopping...")

signal.signal(signal.SIGINT, _handle_sigint)

# ── Import engine ─────────────────────────────────────────────────────────────
try:
    from react_loop import run_react, Thought, Action, Observation, Answer
except ImportError as e:
    log.error("Cannot import react_loop.py — make sure it is in the same directory: %s", e)
    sys.exit(1)

# ── Step printer ──────────────────────────────────────────────────────────────
def make_step_printer(verbose: bool):
    def on_step(step):
        if _interrupted:
            raise KeyboardInterrupt("Agent interrupted by user")
        if isinstance(step, Thought):
            sys.stdout.write(f"\n\033[94m💭 THOUGHT\033[0m\n{step.content}\n")
        elif isinstance(step, Action):
            inp = json.dumps(step.input, ensure_ascii=False)
            sys.stdout.write(f"\n\033[93m⚡ ACTION\033[0m  {step.tool}\n{inp}\n")
        elif isinstance(step, Observation):
            color = "\033[91m" if step.is_error else "\033[92m"
            label = "❌ ERROR" if step.is_error else "👁 OBSERVE"
            preview = step.content[:600] + ("..." if len(step.content) > 600 else "")
            sys.stdout.write(f"\n{color}{label}\033[0m\n{preview}\n")
        sys.stdout.flush()
    return on_step if verbose else None

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Production ReAct Agent Harness")
    parser.add_argument("task", nargs="?", default="-",
                        help="Task string, or '-' to read from stdin")
    parser.add_argument("--system",    default=os.environ.get("AGENT_SYSTEM", ""),
                        help="System prompt addition")
    parser.add_argument("--max-iter",  type=int,
                        default=int(os.environ.get("AGENT_MAX_ITER", 30)),
                        help="Max iterations (default 30)")
    parser.add_argument("--json-out",  default=None,
                        help="Write full result JSON to this path")
    parser.add_argument("--quiet",     action="store_true",
                        help="Suppress step-by-step output")
    args = parser.parse_args()

    validate_env()

    # Read task
    if args.task == "-":
        task = sys.stdin.read().strip()
    else:
        task = args.task.strip()

    if not task:
        log.error("No task provided")
        sys.exit(1)

    log.info("Task: %s", task[:200])
    log.info("Max iterations: %d", args.max_iter)

    start = time.time()
    exit_code = 0

    try:
        answer, trace = run_react(
            user_message   = task,
            system_extra   = args.system,
            max_iterations = args.max_iter,
            on_tool_call   = make_step_printer(not args.quiet),
        )

        elapsed = round(time.time() - start, 2)

        sys.stdout.write(f"\n{'='*64}\n")
        sys.stdout.write(f"FINAL ANSWER\n{'='*64}\n")
        sys.stdout.write(answer + "\n")
        sys.stdout.write(f"{'='*64}\n")
        sys.stdout.write(f"Iterations: {trace.iterations} | Tokens: {trace.total_tokens} | Time: {elapsed}s\n")
        sys.stdout.flush()

        if args.json_out:
            out = {
                "task":         task,
                "answer":       answer,
                "iterations":   trace.iterations,
                "total_tokens": trace.total_tokens,
                "elapsed_s":    elapsed,
                "trace":        trace.to_dict(),
            }
            Path(args.json_out).write_text(json.dumps(out, indent=2, ensure_ascii=False))
            log.info("Result written to %s", args.json_out)

    except KeyboardInterrupt:
        log.warning("Agent stopped by user")
        exit_code = 130
    except RuntimeError as e:
        log.error("Agent failed: %s", e)
        exit_code = 1
    except Exception:
        log.error("Unexpected error:\n%s", traceback.format_exc())
        exit_code = 1

    sys.exit(exit_code)

if __name__ == "__main__":
    main()
