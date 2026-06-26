/**
 * Test Harness — TypeScript ReAct Loop
 * Runs a battery of tasks, captures full traces, reports pass/fail/tokens/time.
 *
 * npm install @anthropic-ai/sdk
 * export ANTHROPIC_API_KEY=sk-ant-...
 * npx ts-node harness_react.ts
 */

import * as fs from "fs";
import { runReact, Trace, Step } from "./react_loop";

// ── Types ─────────────────────────────────────────────────────────────────────
type Validator = (answer: string, trace: Trace) => { passed: boolean; reason: string };

interface TestCase {
  name:          string;
  task:          string;
  validate:      Validator;
  maxIterations?: number;
  system?:       string;
}

interface TestResult {
  name:         string;
  passed:       boolean;
  reason:       string;
  answer:       string;
  iterations:   number;
  totalTokens:  number;
  elapsedMs:    number;
  error:        string;
}

// ── Validators ────────────────────────────────────────────────────────────────
function contains(...keywords: string[]): Validator {
  return (answer) => {
    const missing = keywords.filter(k => !answer.toLowerCase().includes(k.toLowerCase()));
    return missing.length === 0
      ? { passed: true,  reason: "OK" }
      : { passed: false, reason: `Missing keywords: ${missing}` };
  };
}

function answerNotEmpty(): Validator {
  return (answer) => answer.trim()
    ? { passed: true, reason: "OK" }
    : { passed: false, reason: "Answer is empty" };
}

function usedTool(...toolNames: string[]): Validator {
  return (_, trace) => {
    const used = new Set(
      trace.steps.filter(s => s.type === "action").map(s => (s as any).tool)
    );
    const missing = toolNames.filter(t => !used.has(t));
    return missing.length === 0
      ? { passed: true,  reason: "OK" }
      : { passed: false, reason: `Expected tool calls not found: ${missing}` };
  };
}

function thoughtBeforeAction(): Validator {
  return (_, trace) => {
    let lastWasThought = false;
    for (const step of trace.steps) {
      if (step.type === "thought") {
        lastWasThought = true;
      } else if (step.type === "action") {
        const tool = (step as any).tool;
        if (tool !== "think" && tool !== "finish") {
          if (!lastWasThought) {
            return { passed: false, reason: `Action '${tool}' not preceded by a Thought` };
          }
          lastWasThought = false;
        }
      }
    }
    return { passed: true, reason: "OK" };
  };
}

function minIterations(n: number): Validator {
  return (_, trace) => trace.iterations >= n
    ? { passed: true,  reason: "OK" }
    : { passed: false, reason: `Expected >= ${n} iterations, got ${trace.iterations}` };
}

function all(...validators: Validator[]): Validator {
  return (answer, trace) => {
    for (const v of validators) {
      const result = v(answer, trace);
      if (!result.passed) return result;
    }
    return { passed: true, reason: "OK" };
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────
const TEST_SUITE: TestCase[] = [
  {
    name:     "basic_answer",
    task:     "What is 2 + 2? Use the think tool to reason, then finish.",
    validate: all(contains("4"), thoughtBeforeAction()),
  },
  {
    name:     "code_execution",
    task:     "Write and run Node.js code to compute the sum of squares from 1 to 10. Report the result.",
    validate: all(contains("385"), usedTool("run_node"), thoughtBeforeAction()),
  },
  {
    name:     "file_write_and_read",
    task:     "Write the string 'ReAct harness test' to /tmp/harness_test_ts.txt, then read it back and confirm.",
    validate: all(contains("ReAct harness test"), usedTool("write_file", "read_file"), thoughtBeforeAction()),
  },
  {
    name:     "multi_step_reasoning",
    task:     "Calculate the 10th Fibonacci number using code. Then the 20th. Report the ratio of 20th to 10th.",
    validate: all(contains("55"), contains("6765"), usedTool("run_node"), minIterations(3), thoughtBeforeAction()),
  },
  {
    name:     "error_recovery",
    task:     "Try to read /tmp/no_such_file_ts_99.txt. If it fails, create it with 'created by agent', then read it back.",
    validate: all(contains("created by agent"), usedTool("read_file", "write_file"), thoughtBeforeAction()),
  },
  {
    name:     "system_prompt_respected",
    task:     "Tell me your name.",
    system:   "Your name is ARIA. Always introduce yourself as ARIA.",
    validate: contains("ARIA"),
  },
  {
    name:     "finish_called",
    task:     "Say hello and finish.",
    validate: all(answerNotEmpty(), thoughtBeforeAction()),
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────
async function runHarness(suite: TestCase[] = TEST_SUITE): Promise<TestResult[]> {
  const results: TestResult[] = [];

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  ReAct Harness — TypeScript — ${suite.length} tests`);
  console.log(`${"=".repeat(64)}\n`);

  for (const tc of suite) {
    process.stdout.write(`▶  ${tc.name} ... `);
    const t0 = Date.now();
    const result: TestResult = {
      name: tc.name, passed: false, reason: "",
      answer: "", iterations: 0, totalTokens: 0, elapsedMs: 0, error: "",
    };

    try {
      const { answer, trace } = await runReact(tc.task, {
        systemExtra:   tc.system,
        maxIterations: tc.maxIterations ?? 30,
      });

      result.answer      = answer;
      result.iterations  = trace.iterations;
      result.totalTokens = trace.totalTokens;
      result.elapsedMs   = trace.elapsedMs;

      const { passed, reason } = tc.validate(answer, trace);
      result.passed = passed;
      result.reason = reason;

    } catch (e: unknown) {
      result.passed  = false;
      result.reason  = "Exception";
      result.error   = (e as Error).message ?? String(e);
      result.elapsedMs = Date.now() - t0;
    }

    const status = result.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`${status}  (${result.elapsedMs}ms, ${result.totalTokens} tok, ${result.iterations} iter)`);

    if (!result.passed) {
      console.log(`   Reason : ${result.reason}`);
      if (result.error)  console.log(`   Error  : ${result.error.slice(0, 300)}`);
      if (result.answer) console.log(`   Answer : ${result.answer.slice(0, 200)}`);
    }

    results.push(result);
  }

  const passed      = results.filter(r => r.passed).length;
  const totalTokens = results.reduce((s, r) => s + r.totalTokens, 0);
  const totalMs     = results.reduce((s, r) => s + r.elapsedMs, 0);

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  Results : ${passed}/${results.length} passed`);
  console.log(`  Tokens  : ${totalTokens}`);
  console.log(`  Time    : ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`${"=".repeat(64)}\n`);

  const reportPath = "/tmp/react_harness_report_ts.json";
  fs.writeFileSync(reportPath, JSON.stringify(results.map(r => ({
    ...r, answer: r.answer.slice(0, 500), error: r.error.slice(0, 500),
  })), null, 2));
  console.log(`  Report  → ${reportPath}`);

  return results;
}

if (require.main === module) {
  runHarness().then(results => {
    const failed = results.filter(r => !r.passed);
    process.exit(failed.length === 0 ? 0 : 1);
  }).catch(e => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
