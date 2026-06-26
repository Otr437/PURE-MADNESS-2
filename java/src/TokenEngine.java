/**
 * RBAC Token Engine + Monitor — Java
 * Plugs directly into ReactLoop.java and RunAgent.java
 *
 * Same deps as ReactLoop.java:
 *   com.squareup.okhttp3:okhttp:4.12.0
 *   com.fasterxml.jackson.core:jackson-databind:2.17.0
 *
 * Usage:
 *   TokenEngine engine = new TokenEngine(TokenEngine.DEFAULT_CONFIG, new TokenEngine.Options());
 *   TokenEngine.Session session = engine.startSession("operator", "your task");
 *   engine.recordUsage(session.id, 500, 300, 1);
 *   engine.endSession(session.id, "done");
 *   engine.printMonitor(false);
 */

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.ArrayNode;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BiConsumer;
import java.util.stream.Collectors;

public class TokenEngine {

    static final ObjectMapper JSON = new ObjectMapper();

    // ── Role ──────────────────────────────────────────────────────────────────
    record Role(int maxTokens, int maxIter, double alertPct, double costPer1k) {}

    // ── RBAC Config ───────────────────────────────────────────────────────────
    record RBACConfig(Map<String, Role> roles) {
        Role get(String role) {
            Role r = roles.get(role);
            if (r == null) throw new PermissionException(
                "Unknown role '" + role + "' — valid: " + roles.keySet());
            return r;
        }
    }

    static final RBACConfig DEFAULT_CONFIG = new RBACConfig(Map.of(
        "admin",    new Role(200_000, 50, 0.80, 0.015),
        "operator", new Role( 50_000, 30, 0.75, 0.015),
        "user",     new Role( 10_000, 15, 0.70, 0.015),
        "readonly", new Role(  2_000,  5, 0.60, 0.015)
    ));

    // ── Session ───────────────────────────────────────────────────────────────
    static class Session {
        final String   id;
        final String   role;
        final String   task;
        final Role     budget;
        final Instant  startedAt;
        volatile Instant endedAt;
        final AtomicLong inputTokens  = new AtomicLong();
        final AtomicLong outputTokens = new AtomicLong();
        volatile int   iterations;
        volatile String answer       = "";
        final List<String> alerts    = Collections.synchronizedList(new ArrayList<>());
        volatile boolean aborted     = false;
        volatile String  abortReason = "";

        Session(String id, String role, String task, Role budget) {
            this.id        = id;
            this.role      = role;
            this.task      = task;
            this.budget    = budget;
            this.startedAt = Instant.now();
        }

        long   totalTokens()      { return inputTokens.get() + outputTokens.get(); }
        double budgetUsedPct()    { return budget.maxTokens() == 0 ? 0 : (double) totalTokens() / budget.maxTokens(); }
        double estimatedCostUsd() { return (totalTokens() / 1000.0) * budget.costPer1k(); }
        long   elapsedMs()        { return (endedAt != null ? endedAt : Instant.now()).toEpochMilli() - startedAt.toEpochMilli(); }

        ObjectNode toJson() {
            ObjectNode n = JSON.createObjectNode();
            n.put("id",                id);
            n.put("role",              role);
            n.put("task",              task.length() > 200 ? task.substring(0, 200) : task);
            n.put("started_at",        startedAt.toString());
            n.put("ended_at",          endedAt != null ? endedAt.toString() : "null");
            n.put("elapsed_ms",        elapsedMs());
            n.put("input_tokens",      inputTokens.get());
            n.put("output_tokens",     outputTokens.get());
            n.put("total_tokens",      totalTokens());
            n.put("budget_tokens",     budget.maxTokens());
            n.put("budget_used_pct",   String.format("%.1f", budgetUsedPct() * 100));
            n.put("estimated_cost_usd",String.format("%.6f", estimatedCostUsd()));
            n.put("iterations",        iterations);
            n.put("max_iter",          budget.maxIter());
            ArrayNode alertArr = JSON.createArrayNode();
            alerts.forEach(alertArr::add);
            n.set("alerts", alertArr);
            n.put("aborted",           aborted);
            n.put("abort_reason",      abortReason);
            return n;
        }
    }

    // ── Exceptions ────────────────────────────────────────────────────────────
    static class BudgetExceededException extends RuntimeException {
        BudgetExceededException(String msg) { super(msg); }
    }
    static class PermissionException extends RuntimeException {
        PermissionException(String msg) { super(msg); }
    }

    // ── Options ───────────────────────────────────────────────────────────────
    static class Options {
        String auditPath = Optional.ofNullable(System.getenv("AGENT_AUDIT_LOG"))
                                   .orElse("/tmp/agent_audit.jsonl");
        BiConsumer<Session, String> onAlert;
        BiConsumer<Session, String> onAbort;
    }

    // ── Engine ────────────────────────────────────────────────────────────────
    private final RBACConfig config;
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final String auditPath;
    private final BiConsumer<Session, String> onAlert;
    private final BiConsumer<Session, String> onAbort;

    public TokenEngine(RBACConfig config, Options opts) {
        this.config    = config;
        this.auditPath = opts.auditPath;
        this.onAlert   = opts.onAlert;
        this.onAbort   = opts.onAbort;
    }

    // ── Session lifecycle ─────────────────────────────────────────────────────

    public Session startSession(String role, String task) {
        Role budget = config.get(role);
        Session s = new Session(UUID.randomUUID().toString(), role, task, budget);
        sessions.put(s.id, s);
        audit("session_start", s, Map.of());
        return s;
    }

    public void recordUsage(String sessionId, long inputTokens, long outputTokens, int iteration) {
        Session s = get(sessionId);
        s.inputTokens.addAndGet(inputTokens);
        s.outputTokens.addAndGet(outputTokens);
        s.iterations = iteration;
        audit("usage", s, Map.of("delta_input", inputTokens, "delta_output", outputTokens));
        checkBudget(s);
    }

    public Session endSession(String sessionId, String answer) {
        Session s = get(sessionId);
        s.endedAt = Instant.now();
        s.answer  = answer;
        audit("session_end", s, Map.of());
        return s;
    }

    public void abortSession(String sessionId, String reason) {
        Session s = get(sessionId);
        s.aborted     = true;
        s.abortReason = reason;
        s.endedAt     = Instant.now();
        audit("session_abort", s, Map.of("reason", reason));
        if (onAbort != null) onAbort.accept(s, reason);
        throw new BudgetExceededException(reason);
    }

    // ── Budget enforcement ────────────────────────────────────────────────────

    public void checkIteration(String sessionId, int iteration) {
        Session s = get(sessionId);
        if (iteration > s.budget.maxIter()) {
            abortSession(sessionId, String.format(
                "Role '%s' iteration limit reached: %d max, attempted #%d",
                s.role, s.budget.maxIter(), iteration));
        }
    }

    private void checkBudget(Session s) {
        double pct = s.budgetUsedPct();
        if (pct >= s.budget.alertPct() && s.alerts.isEmpty()) {
            String msg = String.format(
                "[ALERT] Role '%s' session %s at %.1f%% of token budget (%d/%d)",
                s.role, s.id.substring(0, 8), pct * 100, s.totalTokens(), s.budget.maxTokens());
            s.alerts.add(msg);
            emitAlert(s, msg);
        }
        if (s.totalTokens() >= s.budget.maxTokens()) {
            abortSession(s.id, String.format(
                "Role '%s' token budget exhausted: %d/%d",
                s.role, s.totalTokens(), s.budget.maxTokens()));
        }
    }

    private void emitAlert(Session s, String msg) {
        System.out.printf("%n\033[93m⚠  TOKEN ALERT\033[0m  %s%n", msg);
        audit("alert", s, Map.of("message", msg));
        if (onAlert != null) onAlert.accept(s, msg);
    }

    // ── Monitor ───────────────────────────────────────────────────────────────

    public void printMonitor(boolean activeOnly) {
        List<Session> list = sessions.values().stream()
            .filter(s -> !activeOnly || s.endedAt == null)
            .sorted(Comparator.comparing((Session s) -> s.startedAt).reversed())
            .collect(Collectors.toList());

        String sep = "─".repeat(112);
        System.out.printf("%n%s%n", sep);
        System.out.printf("%-10s %-12s %-12s %-10s %-18s %-8s %-10s %-10s %s%n",
            "SESSION","ROLE","TOKENS","BUDGET","USED%","ITER","COST$","ELAPSED","STATUS");
        System.out.printf("%s%n", sep);

        long   totalTokens = 0;
        double totalCost   = 0;

        for (Session s : list) {
            String color, status;
            if      (s.aborted)         { color = "\033[91m"; status = "ABORTED"; }
            else if (s.endedAt != null) { color = "\033[92m"; status = "DONE";    }
            else                        { color = "\033[93m"; status = "RUNNING"; }

            double pct    = s.budgetUsedPct();
            int    filled = (int)(pct * 10);
            String bar    = "█".repeat(filled) + "░".repeat(10 - filled);

            System.out.printf("%-10s %-12s %-12d %-10d %s %4.1f%% %-8s $%-9.4f %-9dms %s%s\033[0m%n",
                s.id.substring(0, 8), s.role,
                s.totalTokens(), s.budget.maxTokens(),
                bar, pct * 100,
                s.iterations + "/" + s.budget.maxIter(),
                s.estimatedCostUsd(),
                s.elapsedMs(),
                color, status);

            totalTokens += s.totalTokens();
            totalCost   += s.estimatedCostUsd();
        }

        System.out.printf("%s%n  Sessions: %d  |  Tokens: %d  |  Cost: $%.4f%n%s%n%n",
            sep, list.size(), totalTokens, totalCost, sep);
    }

    public void writeReport(String path) throws Exception {
        ArrayNode arr = JSON.createArrayNode();
        sessions.values().forEach(s -> arr.add(s.toJson()));
        Files.writeString(Path.of(path), JSON.writerWithDefaultPrettyPrinter().writeValueAsString(arr));
    }

    // ── Audit log ─────────────────────────────────────────────────────────────

    private synchronized void audit(String event, Session s, Map<String, Object> extra) {
        try {
            ObjectNode r = JSON.createObjectNode();
            r.put("ts",         Instant.now().toString());
            r.put("event",      event);
            r.put("session_id", s.id);
            r.put("role",       s.role);
            r.put("tokens",     s.totalTokens());
            r.put("budget",     s.budget.maxTokens());
            r.put("pct",        String.format("%.1f", s.budgetUsedPct() * 100));
            r.put("cost_usd",   String.format("%.6f", s.estimatedCostUsd()));
            extra.forEach((k, v) -> r.put(k, v.toString()));
            try (FileWriter fw = new FileWriter(auditPath, true)) {
                fw.write(JSON.writeValueAsString(r) + "\n");
            }
        } catch (IOException ignored) {}
    }

    private Session get(String id) {
        Session s = sessions.get(id);
        if (s == null) throw new IllegalArgumentException("Unknown session: " + id);
        return s;
    }

    // ── Wired RunReact with RBAC ──────────────────────────────────────────────

    public record RBACResult(String answer, Session session) {}

    public RBACResult runReactRBAC(
        String task,
        String role,
        String systemExtra,
        java.util.function.Consumer<ReactLoop.TraceStep> onStep
    ) throws Exception {
        Session session = startSession(role, task);
        System.out.printf("%n[token] Session %s | Role: %s | Budget: %,d tokens%n%n",
            session.id.substring(0, 8), role, session.budget.maxTokens());

        int[] iterCount = {0};
        java.util.function.Consumer<ReactLoop.TraceStep> wrapped = step -> {
            if ("action".equals(step.type())) {
                iterCount[0]++;
                checkIteration(session.id, iterCount[0]);
            }
            if (onStep != null) onStep.accept(step);
        };

        try {
            ReactLoop.ReactResult result = ReactLoop.runReact(
                task,
                systemExtra,
                session.budget.maxIter(),
                wrapped
            );
            long half = result.trace.totalTokens() / 2;
            recordUsage(session.id, half, result.trace.totalTokens() - half, result.trace.iterations());
            Session ended = endSession(session.id, result.answer);
            return new RBACResult(result.answer, ended);
        } catch (BudgetExceededException e) {
            throw e;
        } catch (Exception e) {
            abortSession(session.id, e.getMessage());
            return null; // unreachable
        }
    }

    // ── CLI demo ──────────────────────────────────────────────────────────────

    public static void main(String[] args) throws Exception {
        String role = args.length > 0 ? args[0] : "user";
        String task = args.length > 1 ? String.join(" ", Arrays.copyOfRange(args, 1, args.length))
                                       : "Calculate the 10th Fibonacci number using bash.";

        TokenEngine engine = new TokenEngine(DEFAULT_CONFIG, new Options());
        try {
            RBACResult result = engine.runReactRBAC(task, role, null, null);
            System.out.println("\nAnswer: " + result.answer());
        } catch (BudgetExceededException e) {
            System.out.println("\n[BUDGET EXCEEDED] " + e.getMessage());
        } catch (PermissionException e) {
            System.out.println("\n[ACCESS DENIED] " + e.getMessage());
        } finally {
            engine.printMonitor(false);
            engine.writeReport("/tmp/token_report.json");
            System.out.println("Audit → /tmp/agent_audit.jsonl\nReport → /tmp/token_report.json");
        }
    }
}
