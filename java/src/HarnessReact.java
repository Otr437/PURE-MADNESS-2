/**
 * Test Harness — Java ReAct Loop
 * Runs a battery of tasks, captures full traces, reports pass/fail/tokens/time.
 *
 * Same deps as ReactLoop.java:
 *   com.squareup.okhttp3:okhttp:4.12.0
 *   com.fasterxml.jackson.core:jackson-databind:2.17.0
 *
 * export ANTHROPIC_API_KEY=sk-ant-...
 * javac -cp okhttp*.jar:jackson*.jar HarnessReact.java ReactLoop.java
 * java  -cp .:okhttp*.jar:jackson*.jar HarnessReact
 */

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.function.BiFunction;
import java.util.stream.Collectors;

public class HarnessReact {

    static final ObjectMapper JSON = new ObjectMapper();

    // ── Types ─────────────────────────────────────────────────────────────────
    record ValidationResult(boolean passed, String reason) {}

    @FunctionalInterface
    interface Validator extends BiFunction<String, ReactLoop.Trace, ValidationResult> {}

    record TestCase(
        String    name,
        String    task,
        Validator validate,
        int       maxIterations,
        String    systemExtra
    ) {
        TestCase(String name, String task, Validator validate) {
            this(name, task, validate, 30, null);
        }
    }

    record TestResult(
        String  name,
        boolean passed,
        String  reason,
        String  answer,
        int     iterations,
        long    totalTokens,
        long    elapsedMs,
        String  error
    ) {}

    // ── Validators ────────────────────────────────────────────────────────────
    static Validator contains(String... keywords) {
        return (answer, trace) -> {
            String lower = answer.toLowerCase();
            for (String k : keywords) {
                if (!lower.contains(k.toLowerCase())) {
                    return new ValidationResult(false, "missing keyword: " + k);
                }
            }
            return new ValidationResult(true, "OK");
        };
    }

    static Validator answerNotEmpty() {
        return (answer, trace) -> answer.isBlank()
            ? new ValidationResult(false, "answer is empty")
            : new ValidationResult(true, "OK");
    }

    static Validator usedTool(String... toolNames) {
        return (answer, trace) -> {
            Set<String> used = trace.steps.stream()
                .filter(s -> "action".equals(s.type()))
                .map(ReactLoop.TraceStep::tool)
                .collect(Collectors.toSet());
            for (String t : toolNames) {
                if (!used.contains(t)) {
                    return new ValidationResult(false, "tool not called: " + t);
                }
            }
            return new ValidationResult(true, "OK");
        };
    }

    static Validator thoughtBeforeAction() {
        return (answer, trace) -> {
            boolean lastWasThought = false;
            for (ReactLoop.TraceStep step : trace.steps) {
                switch (step.type()) {
                    case "thought" -> lastWasThought = true;
                    case "action"  -> {
                        if (!"think".equals(step.tool()) && !"finish".equals(step.tool())) {
                            if (!lastWasThought) {
                                return new ValidationResult(false,
                                    "action '" + step.tool() + "' not preceded by thought");
                            }
                            lastWasThought = false;
                        }
                    }
                }
            }
            return new ValidationResult(true, "OK");
        };
    }

    static Validator minIterations(int n) {
        return (answer, trace) -> trace.iterations >= n
            ? new ValidationResult(true, "OK")
            : new ValidationResult(false, "expected >= " + n + " iterations, got " + trace.iterations);
    }

    static Validator all(Validator... validators) {
        return (answer, trace) -> {
            for (Validator v : validators) {
                ValidationResult r = v.apply(answer, trace);
                if (!r.passed()) return r;
            }
            return new ValidationResult(true, "OK");
        };
    }

    // ── Test suite ────────────────────────────────────────────────────────────
    static List<TestCase> buildSuite() {
        return List.of(
            new TestCase("basic_answer",
                "What is 2 + 2? Use the think tool to reason, then finish.",
                all(contains("4"), thoughtBeforeAction())),

            new TestCase("code_execution",
                "Write and run a bash command to compute the sum of squares from 1 to 10. Report the result.",
                all(contains("385"), usedTool("run_bash"), thoughtBeforeAction())),

            new TestCase("file_write_and_read",
                "Write 'ReAct harness test' to /tmp/harness_test_java.txt, then read it back and confirm the content.",
                all(contains("ReAct harness test"), usedTool("write_file", "read_file"), thoughtBeforeAction())),

            new TestCase("multi_step_reasoning",
                "Calculate the 10th Fibonacci number using bash. Then the 20th. Report the ratio of 20th to 10th.",
                all(contains("55", "6765"), usedTool("run_bash"), minIterations(3), thoughtBeforeAction()),
                20, null),

            new TestCase("error_recovery",
                "Try to read /tmp/no_such_file_java_99.txt. If it fails, create it with 'created by agent', then read it back.",
                all(contains("created by agent"), usedTool("read_file", "write_file"), thoughtBeforeAction())),

            new TestCase("system_prompt_respected",
                "Tell me your name.",
                contains("ARIA"),
                10, "Your name is ARIA. Always introduce yourself as ARIA."),

            new TestCase("finish_called",
                "Say hello and finish.",
                all(answerNotEmpty(), thoughtBeforeAction()),
                10, null)
        );
    }

    // ── Runner ────────────────────────────────────────────────────────────────
    static List<TestResult> runHarness(List<TestCase> suite) throws Exception {
        List<TestResult> results = new ArrayList<>();
        String sep = "=".repeat(64);

        System.out.printf("%n%s%n  ReAct Harness — Java — %d tests%n%s%n%n", sep, suite.size(), sep);

        for (TestCase tc : suite) {
            System.out.printf("▶  %-40s ... ", tc.name());
            long startMs = System.currentTimeMillis();

            TestResult result;
            try {
                ReactLoop.ReactResult rr = ReactLoop.runReact(
                    tc.task(),
                    tc.systemExtra(),
                    tc.maxIterations(),
                    null
                );

                ValidationResult vr = tc.validate().apply(rr.answer, rr.trace);
                result = new TestResult(
                    tc.name(), vr.passed(), vr.reason(),
                    rr.answer,
                    rr.trace.iterations,
                    rr.trace.totalTokens,
                    rr.trace.elapsedMs,
                    ""
                );
            } catch (Exception e) {
                result = new TestResult(
                    tc.name(), false, "Exception", "",
                    0, 0, System.currentTimeMillis() - startMs,
                    e.getMessage()
                );
            }

            String status = result.passed() ? "✅ PASS" : "❌ FAIL";
            System.out.printf("%s  (%dms, %d tok, %d iter)%n",
                status, result.elapsedMs(), result.totalTokens(), result.iterations());

            if (!result.passed()) {
                System.out.printf("   Reason : %s%n", result.reason());
                if (!result.error().isEmpty())
                    System.out.printf("   Error  : %s%n", truncate(result.error(), 300));
                if (!result.answer().isEmpty())
                    System.out.printf("   Answer : %s%n", truncate(result.answer(), 200));
            }

            results.add(result);
        }

        long passed      = results.stream().filter(TestResult::passed).count();
        long totalTokens = results.stream().mapToLong(TestResult::totalTokens).sum();
        long totalMs     = results.stream().mapToLong(TestResult::elapsedMs).sum();

        System.out.printf("%n%s%n  Results : %d/%d passed%n  Tokens  : %d%n  Time    : %.2fs%n%s%n%n",
            sep, passed, results.size(), totalTokens, totalMs / 1000.0, sep);

        // Write JSON report
        String reportPath = "/tmp/react_harness_report_java.json";
        ArrayNode arr = JSON.createArrayNode();
        for (TestResult r : results) {
            var n = JSON.createObjectNode();
            n.put("name",          r.name());
            n.put("passed",        r.passed());
            n.put("reason",        r.reason());
            n.put("answer",        truncate(r.answer(), 500));
            n.put("iterations",    r.iterations());
            n.put("total_tokens",  r.totalTokens());
            n.put("elapsed_ms",    r.elapsedMs());
            n.put("error",         truncate(r.error(), 500));
            arr.add(n);
        }
        Files.writeString(Path.of(reportPath), JSON.writerWithDefaultPrettyPrinter().writeValueAsString(arr));
        System.out.printf("  Report  → %s%n", reportPath);

        return results;
    }

    static String truncate(String s, int n) {
        return s == null ? "" : s.length() <= n ? s : s.substring(0, n) + "...";
    }

    // ── Entry point ───────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        List<TestResult> results = runHarness(buildSuite());
        boolean anyFailed = results.stream().anyMatch(r -> !r.passed());
        System.exit(anyFailed ? 1 : 0);
    }
}
