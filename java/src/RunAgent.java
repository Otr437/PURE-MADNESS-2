/**
 * Production Runtime Harness — Java
 * Wires ReactLoop.java into a fully runnable CLI agent.
 *
 * Same deps as ReactLoop.java:
 *   com.squareup.okhttp3:okhttp:4.12.0
 *   com.fasterxml.jackson.core:jackson-databind:2.17.0
 *
 * Usage:
 *   java -cp .:deps RunAgent "your task here"
 *   java -cp .:deps RunAgent --system "You are a DevOps expert." "audit /tmp"
 *   java -cp .:deps RunAgent --max-iter 50 --json-out /tmp/result.json "task"
 *   echo "task" | java -cp .:deps RunAgent -
 *
 * Environment:
 *   ANTHROPIC_API_KEY   required
 *   AGENT_MAX_ITER      default 30
 *   AGENT_SYSTEM        system prompt override
 */

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.ArrayNode;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

public class RunAgent {

    static final ObjectMapper JSON    = new ObjectMapper();
    static final AtomicBoolean STOPPED = new AtomicBoolean(false);

    // ── Logger ────────────────────────────────────────────────────────────────
    static void log(String level, String msg) {
        String ts = DateTimeFormatter.ISO_INSTANT.format(Instant.now());
        System.err.printf("%s [%s] %s%n", ts, level, msg);
    }

    // ── Validate environment ──────────────────────────────────────────────────
    static void validateEnv() {
        String provider = System.getenv().getOrDefault("MODEL_PROVIDER", "anthropic").trim().toLowerCase();
        Map<String, String> keyMap = Map.of(
            "anthropic",       "ANTHROPIC_API_KEY",
            "deepseek",        "DEEPSEEK_API_KEY",
            "deepseek-openai", "DEEPSEEK_API_KEY",
            "openai",          "OPENAI_API_KEY"
        );
        String envVar = keyMap.get(provider);
        if (envVar == null) {
            log("ERROR", "unknown MODEL_PROVIDER '" + provider + "'");
            System.exit(1);
        }
        String key = System.getenv(envVar);
        if (key == null || key.isBlank()) {
            log("ERROR", envVar + " is not set (required for provider '" + provider + "')");
            System.exit(1);
        }
        log("INFO", "provider=" + provider + " model=" + System.getenv().getOrDefault("MODEL_NAME", "(default)"));
    }

    // ── Step printer ──────────────────────────────────────────────────────────
    static java.util.function.Consumer<ReactLoop.TraceStep> makeStepPrinter(boolean verbose) {
        if (!verbose) return step -> {};
        return step -> {
            if (STOPPED.get()) {
                throw new RuntimeException("Agent interrupted by user");
            }
            switch (step.type()) {
                case "thought" -> System.out.printf("%n\033[94m💭 THOUGHT\033[0m%n%s%n", step.content());
                case "action"  -> {
                    String inp = "";
                    try { inp = JSON.writerWithDefaultPrettyPrinter()
                            .writeValueAsString(step.input()); } catch (Exception ignored) {}
                    System.out.printf("%n\033[93m⚡ ACTION\033[0m  %s%n%s%n", step.tool(), inp);
                }
                case "observation" -> {
                    String color = step.error() ? "\033[91m" : "\033[92m";
                    String label = step.error() ? "❌ ERROR" : "👁 OBSERVE";
                    String preview = step.content().length() > 600
                        ? step.content().substring(0, 600) + "..."
                        : step.content();
                    System.out.printf("%n%s%s\033[0m%n%s%n", color, label, preview);
                }
            }
            System.out.flush();
        };
    }

    // ── Arg parser ────────────────────────────────────────────────────────────
    static class RunOptions {
        String task      = "-";
        String system    = Optional.ofNullable(System.getenv("AGENT_SYSTEM")).orElse("");
        int    maxIter   = Integer.parseInt(Optional.ofNullable(
                               System.getenv("AGENT_MAX_ITER")).orElse("30"));
        String jsonOut   = null;
        boolean quiet    = false;
    }

    static RunOptions parseArgs(String[] args) {
        RunOptions opts = new RunOptions();
        List<String> positional = new ArrayList<>();
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--system"   -> opts.system  = args[++i];
                case "--max-iter" -> opts.maxIter = Integer.parseInt(args[++i]);
                case "--json-out" -> opts.jsonOut = args[++i];
                case "--quiet"    -> opts.quiet   = true;
                default           -> positional.add(args[i]);
            }
        }
        if (!positional.isEmpty()) {
            opts.task = String.join(" ", positional);
        }
        return opts;
    }

    // ── Read stdin ────────────────────────────────────────────────────────────
    static String readStdin() throws IOException {
        BufferedReader reader = new BufferedReader(
            new InputStreamReader(System.in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            sb.append(line).append("\n");
        }
        return sb.toString().trim();
    }

    // ── Signal handling ───────────────────────────────────────────────────────
    static void installShutdownHook() {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            if (STOPPED.getAndSet(true)) {
                System.err.println("[harness] Force quit");
            } else {
                System.err.println("[harness] Interrupt — finishing current iteration...");
            }
        }));
    }

    // ── Main ──────────────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        validateEnv();
        installShutdownHook();

        RunOptions opts = parseArgs(args);

        // Read task
        if ("-".equals(opts.task)) {
            opts.task = readStdin();
        }
        if (opts.task == null || opts.task.isBlank()) {
            log("ERROR", "No task provided");
            System.exit(1);
        }

        log("INFO", "Task: " + opts.task.substring(0, Math.min(200, opts.task.length())));
        log("INFO", "Max iterations: " + opts.maxIter);

        long startMs = System.currentTimeMillis();
        int exitCode = 0;

        try {
            ReactLoop.ReactResult result = ReactLoop.runReact(
                opts.task,
                opts.system.isBlank() ? null : opts.system,
                opts.maxIter,
                makeStepPrinter(!opts.quiet)
            );

            long elapsedMs = System.currentTimeMillis() - startMs;
            String sep = "=".repeat(64);

            System.out.printf("%n%s%nFINAL ANSWER%n%s%n%s%n%s%n",
                sep, sep, result.answer, sep);
            System.out.printf("Iterations: %d | Tokens: %d | Time: %.2fs%n",
                result.trace.iterations(), result.trace.totalTokens(), elapsedMs / 1000.0);

            if (opts.jsonOut != null) {
                ObjectNode doc = JSON.createObjectNode();
                doc.put("task",         opts.task);
                doc.put("answer",       result.answer);
                doc.put("iterations",   result.trace.iterations());
                doc.put("total_tokens", result.trace.totalTokens());
                doc.put("elapsed_ms",   elapsedMs);
                ArrayNode stepsArr = JSON.createArrayNode();
                result.trace.steps().forEach(s -> stepsArr.add(s.toJson()));
                doc.set("steps", stepsArr);
                Files.writeString(Path.of(opts.jsonOut),
                    JSON.writerWithDefaultPrettyPrinter().writeValueAsString(doc));
                log("INFO", "Result written to " + opts.jsonOut);
            }

        } catch (RuntimeException e) {
            if (STOPPED.get() || e.getMessage().contains("interrupted")) {
                log("WARN", "Agent stopped by user");
                exitCode = 130;
            } else {
                log("ERROR", "Agent failed: " + e.getMessage());
                exitCode = 1;
            }
        } catch (Exception e) {
            log("ERROR", "Unexpected error: " + e.getMessage());
            exitCode = 1;
        }

        System.exit(exitCode);
    }
}
