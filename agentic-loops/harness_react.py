"""
Test Harness — Python ReAct Loop
Runs a battery of tasks, captures full traces, reports pass/fail/tokens/time.

pip install anthropic tenacity structlog
export ANTHROPIC_API_KEY=sk-ant-...
python harness_react.py
"""

import json
import time
import traceback
from dataclasses import dataclass, field
from typing import Callable

from react_loop import run_react, Trace, Thought, Action, Observation, Answer

# ── Test case definition ──────────────────────────────────────────────────────
@dataclass
class TestCase:
    name:        str
    task:        str
    validate:    Callable[[str, Trace], tuple[bool, str]]  # (answer, trace) → (passed, reason)
    timeout_s:   float = 120.0
    max_iter:    int   = 30
    system:      str   = ""

@dataclass
class TestResult:
    name:         str
    passed:       bool
    reason:       str
    answer:       str        = ""
    iterations:   int        = 0
    total_tokens: int        = 0
    elapsed_s:    float      = 0.0
    error:        str        = ""
    trace:        list       = field(default_factory=list)

# ── Validators ────────────────────────────────────────────────────────────────
def contains(*keywords):
    """Answer must contain all keywords (case-insensitive)."""
    def validate(answer: str, trace: Trace) -> tuple[bool, str]:
        missing = [k for k in keywords if k.lower() not in answer.lower()]
        if missing:
            return False, f"Missing keywords: {missing}"
        return True, "OK"
    return validate

def answer_not_empty(answer: str, trace: Trace) -> tuple[bool, str]:
    if not answer.strip():
        return False, "Answer is empty"
    return True, "OK"

def used_tool(*tool_names):
    """Trace must include at least one call to each named tool."""
    def validate(answer: str, trace: Trace) -> tuple[bool, str]:
        used = {s.tool for s in trace.steps if isinstance(s, Action)}
        missing = [t for t in tool_names if t not in used]
        if missing:
            return False, f"Expected tool calls not found: {missing}"
        return True, "OK"
    return validate

def thought_before_action(answer: str, trace: Trace) -> tuple[bool, str]:
    """Every Action must be preceded by a Thought."""
    last_was_thought = False
    for step in trace.steps:
        if isinstance(step, Thought):
            last_was_thought = True
        elif isinstance(step, Action) and step.tool not in ("think", "finish"):
            if not last_was_thought:
                return False, f"Action '{step.tool}' was not preceded by a Thought"
            last_was_thought = False
    return True, "OK"

def min_iterations(n: int):
    def validate(answer: str, trace: Trace) -> tuple[bool, str]:
        if trace.iterations < n:
            return False, f"Expected >= {n} iterations, got {trace.iterations}"
        return True, "OK"
    return validate

def all_validators(*validators):
    def validate(answer: str, trace: Trace) -> tuple[bool, str]:
        for v in validators:
            ok, reason = v(answer, trace)
            if not ok:
                return False, reason
        return True, "OK"
    return validate

# ── Test suite ────────────────────────────────────────────────────────────────
TEST_SUITE: list[TestCase] = [

    TestCase(
        name     = "basic_answer",
        task     = "What is 2 + 2? Use the think tool to reason, then finish.",
        validate = all_validators(
            contains("4"),
            thought_before_action,
        ),
    ),

    TestCase(
        name     = "code_execution",
        task     = "Write and run Python code to compute the sum of squares from 1 to 10. Report the result.",
        validate = all_validators(
            contains("385"),
            used_tool("run_python"),
            thought_before_action,
        ),
    ),

    TestCase(
        name     = "file_write_and_read",
        task     = (
            "Write the string 'ReAct harness test' to /tmp/harness_test.txt, "
            "then read it back and confirm the content."
        ),
        validate = all_validators(
            contains("ReAct harness test"),
            used_tool("write_file", "read_file"),
            thought_before_action,
        ),
    ),

    TestCase(
        name     = "multi_step_reasoning",
        task     = (
            "Calculate the 10th Fibonacci number using code. "
            "Then calculate the 20th. Then report the ratio of the 20th to the 10th."
        ),
        validate = all_validators(
            contains("55"),   # fib(10)
            contains("6765"), # fib(20)
            used_tool("run_python"),
            min_iterations(3),
            thought_before_action,
        ),
    ),

    TestCase(
        name     = "error_recovery",
        task     = (
            "Try to read the file /tmp/does_not_exist_12345.txt. "
            "If it fails, create it with content 'created by agent', then read it back."
        ),
        validate = all_validators(
            contains("created by agent"),
            used_tool("read_file", "write_file"),
            thought_before_action,
        ),
    ),

    TestCase(
        name     = "system_prompt_respected",
        task     = "Tell me your name.",
        system   = "Your name is ARIA. Always introduce yourself as ARIA.",
        validate = contains("ARIA"),
    ),

    TestCase(
        name     = "finish_called",
        task     = "Say hello and finish.",
        validate = all_validators(
            answer_not_empty,
            thought_before_action,
        ),
    ),
]

# ── Runner ────────────────────────────────────────────────────────────────────
def run_harness(
    suite:   list[TestCase] = TEST_SUITE,
    verbose: bool           = True,
) -> list[TestResult]:
    results: list[TestResult] = []

    print(f"\n{'='*64}")
    print(f"  ReAct Harness — Python — {len(suite)} tests")
    print(f"{'='*64}\n")

    for tc in suite:
        print(f"▶  {tc.name} ... ", end="", flush=True)
        t0 = time.time()
        result = TestResult(name=tc.name, passed=False, reason="")

        try:
            answer, trace = run_react(
                task         = tc.task,
                system_extra = tc.system,
                max_iterations = tc.max_iter,
            )
            result.answer       = answer
            result.iterations   = trace.iterations
            result.total_tokens = trace.total_tokens
            result.elapsed_s    = trace.elapsed_s
            result.trace        = trace.to_dict()

            passed, reason = tc.validate(answer, trace)
            result.passed = passed
            result.reason = reason

        except Exception as e:
            result.passed  = False
            result.reason  = "Exception"
            result.error   = traceback.format_exc()
            result.elapsed_s = round(time.time() - t0, 2)

        status = "✅ PASS" if result.passed else "❌ FAIL"
        print(f"{status}  ({result.elapsed_s}s, {result.total_tokens} tok, {result.iterations} iter)")

        if not result.passed:
            print(f"   Reason : {result.reason}")
            if result.error:
                print(f"   Error  : {result.error[:300]}")
            if verbose and result.answer:
                print(f"   Answer : {result.answer[:200]}")

        results.append(result)

    # ── Summary ───────────────────────────────────────────────────────────────
    passed = sum(1 for r in results if r.passed)
    total  = len(results)
    total_tokens = sum(r.total_tokens for r in results)
    total_time   = sum(r.elapsed_s   for r in results)

    print(f"\n{'='*64}")
    print(f"  Results : {passed}/{total} passed")
    print(f"  Tokens  : {total_tokens}")
    print(f"  Time    : {round(total_time, 2)}s")
    print(f"{'='*64}\n")

    # Write JSON report
    report_path = "/tmp/react_harness_report.json"
    with open(report_path, "w") as f:
        json.dump([{
            "name":         r.name,
            "passed":       r.passed,
            "reason":       r.reason,
            "answer":       r.answer[:500],
            "iterations":   r.iterations,
            "total_tokens": r.total_tokens,
            "elapsed_s":    r.elapsed_s,
            "error":        r.error[:500] if r.error else "",
        } for r in results], f, indent=2)
    print(f"  Report  → {report_path}")

    return results


if __name__ == "__main__":
    import sys
    results = run_harness()
    failed = [r for r in results if not r.passed]
    sys.exit(0 if not failed else 1)
