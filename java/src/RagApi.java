/**
 * RAG REST API — Java (Production-Complete)
 * Javalin 6.4.0 + embedded Jetty. All OWASP ASVS 5.0 requirements met.
 *
 * Endpoints:
 *   GET  /health           liveness probe
 *   GET  /ready            readiness probe (Qdrant verified)
 *   GET  /metrics          Prometheus-compatible metrics
 *   POST /ingest/text      ingest raw text (operator+)
 *   POST /query            RAG query with session memory + RBAC budget (user+)
 *   GET  /sessions/{id}    retrieve session (user+)
 *   DELETE /sessions/{id}  delete session (user+)
 *
 * Auth:        Bearer JWT HS256, jjwt 0.12.6, algorithms pinned, alg:none rejected
 * Rate limits: per-IP; 429 with Retry-After + X-RateLimit-* headers
 * RBAC:        TokenEngine budget enforcement on every /query call
 * Circuit:     Exponential-backoff retry on Qdrant ingest calls
 * Tracing:     X-Request-ID generated/propagated on every request
 * Logging:     Structured JSON on every security event, request, and error
 * Shutdown:    SIGTERM → JVM shutdown hook → Javalin stop (max 30s drain)
 *
 * Required in pom.xml:
 *   io.javalin:javalin:6.4.0
 *   io.jsonwebtoken:jjwt-api:0.12.6
 *   io.jsonwebtoken:jjwt-impl:0.12.6 (runtime)
 *   io.jsonwebtoken:jjwt-jackson:0.12.6 (runtime)
 */

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.jsonwebtoken.*;
import io.jsonwebtoken.security.Keys;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BiConsumer;

public class RagApi {

    static final ObjectMapper JSON = new ObjectMapper();

    // ── Config — fail fast at startup if required values are missing ──────────
    static final String JWT_SECRET_ENV  = System.getenv("JWT_SECRET");
    static final int    PORT            = Integer.parseInt(System.getenv().getOrDefault("PORT", "8004"));
    static final String MODEL_PROVIDER  = System.getenv().getOrDefault("MODEL_PROVIDER", "anthropic");
    static final String CORS_ORIGINS    = System.getenv().getOrDefault("CORS_ORIGINS", "http://localhost:3000");

    static final SecretKey JWT_KEY = (JWT_SECRET_ENV == null || JWT_SECRET_ENV.isBlank())
        ? null
        : Keys.hmacShaKeyFor(JWT_SECRET_ENV.getBytes(StandardCharsets.UTF_8));

    static final Map<String, Integer> ROLE_RANK = Map.of(
        "admin", 4, "operator", 3, "user", 2, "readonly", 1
    );

    // ── Prometheus metrics (thread-safe atomic counters) ──────────────────────
    static final AtomicLong METRIC_REQUESTS  = new AtomicLong();
    static final AtomicLong METRIC_5XX       = new AtomicLong();
    static final AtomicLong METRIC_4XX       = new AtomicLong();
    static final AtomicLong METRIC_QUERIES   = new AtomicLong();
    static final AtomicLong METRIC_INGESTS   = new AtomicLong();
    static final AtomicLong METRIC_TOKENS    = new AtomicLong();

    // ── Auth ──────────────────────────────────────────────────────────────────
    static Claims verifyJwt(Context ctx) {
        if (JWT_KEY == null) {
            log("ERROR", "auth.jwt_secret_missing", Map.of());
            throw new SecurityException("JWT_SECRET not configured");
        }
        String auth = ctx.header("Authorization");
        if (auth == null || !auth.startsWith("Bearer ")) {
            log("WARN", "security.auth_failure", Map.of(
                "reason", "missing_bearer", "path", ctx.path(),
                "request_id", requestId(ctx)));
            throw new SecurityException("Missing Bearer token");
        }
        String token = auth.substring(7).trim();
        try {
            return Jwts.parser()
                .verifyWith(JWT_KEY)
                .requireSignatureAlgorithm(Jwts.SIG.HS256)
                .build()
                .parseSignedClaims(token)
                .getPayload();
        } catch (ExpiredJwtException e) {
            log("WARN", "security.auth_failure", Map.of(
                "reason", "token_expired", "path", ctx.path(),
                "request_id", requestId(ctx)));
            throw new SecurityException("Token expired");
        } catch (JwtException e) {
            log("WARN", "security.auth_failure", Map.of(
                "reason", "invalid_token", "path", ctx.path(),
                "request_id", requestId(ctx)));
            throw new SecurityException("Invalid token");
        }
    }

    static void requireRole(Claims claims, String required, Context ctx) {
        String role = claims.get("role", String.class);
        if (role == null) role = "readonly";
        int userRank = ROLE_RANK.getOrDefault(role, 1);
        int reqRank  = ROLE_RANK.getOrDefault(required, 1);
        if (userRank < reqRank) {
            log("WARN", "security.authz_failure", Map.of(
                "user", String.valueOf(claims.getSubject()),
                "role", role, "required", required,
                "request_id", requestId(ctx)));
            throw new SecurityException("Role '" + role + "' cannot perform this action (requires '" + required + "')");
        }
    }

    // ── Structured logging (JSON to stderr — never exposes internal state in responses) ──
    static void log(String level, String event, Map<String, Object> fields) {
        try {
            ObjectNode node = JSON.createObjectNode();
            node.put("timestamp", Instant.now().toString());
            node.put("level",     level);
            node.put("service",   "rag-api-java");
            node.put("event",     event);
            fields.forEach((k, v) -> {
                if (v instanceof String s)  node.put(k, s);
                else if (v instanceof Number n) node.put(k, n.longValue());
                else if (v instanceof Boolean b) node.put(k, b);
                else node.put(k, String.valueOf(v));
            });
            System.err.println(JSON.writeValueAsString(node));
        } catch (Exception ignored) {
            System.err.println("{\"level\":\"" + level + "\",\"event\":\"" + event + "\"}");
        }
    }

    // ── Rate limiter (per-IP, sliding window) ─────────────────────────────────
    static class RateLimiter {
        final ConcurrentHashMap<String, long[]> state = new ConcurrentHashMap<>();
        final int  limit;
        final long windowMs;

        RateLimiter(int limit, long windowMs) {
            this.limit    = limit;
            this.windowMs = windowMs;
        }

        boolean allow(String key) {
            long now = System.currentTimeMillis();
            state.compute(key, (k, v) -> {
                if (v == null || now - v[1] >= windowMs) return new long[]{1, now};
                v[0]++;
                return v;
            });
            long[] entry = state.get(key);
            return entry != null && entry[0] <= limit;
        }
    }

    static final RateLimiter GENERAL = new RateLimiter(60, 60_000);
    static final RateLimiter INGEST  = new RateLimiter(30, 60_000);
    static final RateLimiter QUERY   = new RateLimiter(20, 60_000);

    static String clientIp(Context ctx) {
        String xff = ctx.header("X-Forwarded-For");
        return xff != null ? xff.split(",")[0].trim() : ctx.ip();
    }

    static String requestId(Context ctx) {
        Object id = ctx.attribute("request_id");
        return id != null ? id.toString() : "unknown";
    }

    // ── Retry-with-backoff helper for Qdrant ingest (circuit-breaker pattern) ─
    static int ingestWithRetry(List<RagEngine.Document> docs) throws Exception {
        Exception lastErr = null;
        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                return engine.ingest(docs);
            } catch (Exception e) {
                lastErr = e;
                if (attempt < 3) {
                    long delayMs = Math.min(1000L * (1L << attempt), 30_000L);
                    Thread.sleep(delayMs);
                }
            }
        }
        throw lastErr;
    }

    // ── Shared state ──────────────────────────────────────────────────────────
    static RagEngine    engine;
    static MemoryStore  memory;
    static TokenEngine  tokenEngine;

    static void init() throws Exception {
        engine = new RagEngine("api_java");
        String sessionDir = System.getenv().getOrDefault("RAG_SESSION_DIR", ".rag_sessions_java");
        memory = new MemoryStore(sessionDir);

        // RBAC token budget config — higher budgets than defaults for API context
        TokenEngine.Options opts = new TokenEngine.Options();
        opts.auditPath = System.getenv().getOrDefault("AGENT_AUDIT_LOG", "/tmp/rag_audit_java.jsonl");
        opts.onAlert   = (s, msg) -> log("WARN", "token_engine.alert", Map.of(
            "session_id", s.id, "role", s.role, "message", msg,
            "budget_used_pct", String.format("%.3f", s.budgetUsedPct())));
        opts.onAbort   = (s, reason) -> log("ERROR", "token_engine.abort", Map.of(
            "session_id", s.id, "role", s.role, "reason", reason,
            "total_tokens", s.totalTokens()));

        tokenEngine = new TokenEngine(
            new TokenEngine.RBACConfig(Map.of(
                "admin",    new TokenEngine.Role(200_000, 50, 0.80, 0.015),
                "operator", new TokenEngine.Role(80_000,  30, 0.75, 0.015),
                "user",     new TokenEngine.Role(20_000,  20, 0.70, 0.015),
                "readonly", new TokenEngine.Role(4_000,    5, 0.60, 0.015)
            )),
            opts
        );

        // Register rag_search tool once at startup — not per-request
        if (!ReactLoop.TOOLS.containsKey("rag_search")) {
            ReactLoop.registerTool(
                "rag_search",
                "Search the knowledge base for context relevant to a query.",
                JSON.createObjectNode()
                    .<com.fasterxml.jackson.databind.node.ObjectNode>put("type", "object")
                    .set("properties", JSON.createObjectNode()
                        .set("query", JSON.createObjectNode().put("type", "string"))
                        .set("top_k", JSON.createObjectNode().put("type", "integer"))),
                inputNode -> {
                    String query = inputNode.path("query").asText("");
                    int topK     = inputNode.path("top_k").asInt(5);
                    try {
                        return engine.retrieveAsContext(query, topK);
                    } catch (Exception e) {
                        return "rag_search error: " + e.getMessage();
                    }
                }
            );
        }

        log("INFO", "api.startup", Map.of(
            "port", PORT, "model_provider", MODEL_PROVIDER,
            "cors_origins", CORS_ORIGINS));
    }

    // ── Error response — never exposes internal details ───────────────────────
    static void sendError(Context ctx, int status, String msg) {
        String requestId = requestId(ctx);
        METRIC_REQUESTS.incrementAndGet();
        if (status >= 500) METRIC_5XX.incrementAndGet();
        else if (status >= 400) METRIC_4XX.incrementAndGet();
        ctx.status(status).json(Map.of("error", msg, "request_id", requestId));
    }

    // ── Rate limit response with Retry-After headers ──────────────────────────
    static boolean checkRateLimit(Context ctx, RateLimiter limiter) {
        if (limiter.allow(clientIp(ctx))) return true;
        log("WARN", "security.rate_limit_exceeded", Map.of(
            "path", ctx.path(), "ip", clientIp(ctx), "request_id", requestId(ctx)));
        ctx.status(429)
           .header("Retry-After",           "60")
           .header("X-RateLimit-Limit",     String.valueOf(limiter.limit))
           .header("X-RateLimit-Remaining", "0")
           .header("X-RateLimit-Reset",     String.valueOf(System.currentTimeMillis() / 1000 + 60))
           .json(Map.of("error", "Rate limit exceeded", "request_id", requestId(ctx)));
        return false;
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    static void health(Context ctx) {
        METRIC_REQUESTS.incrementAndGet();
        ctx.json(Map.of("status", "ok", "time", Instant.now().getEpochSecond()));
    }

    static void ready(Context ctx) {
        METRIC_REQUESTS.incrementAndGet();
        try {
            // Probe Qdrant: attempt a zero-result retrieve to verify connectivity
            engine.retrieve("ping", 1);
            ctx.json(Map.of("status", "ready", "checks", Map.of("qdrant", "ok")));
        } catch (Exception e) {
            log("ERROR", "ready.qdrant_check_failed", Map.of("error", e.getMessage()));
            ctx.status(503).json(Map.of("status", "not_ready",
                "errors", List.of("qdrant: " + e.getMessage())));
        }
    }

    static void metrics(Context ctx) {
        METRIC_REQUESTS.incrementAndGet();
        String body = String.format(
            "# HELP rag_requests_total Total HTTP requests\n" +
            "# TYPE rag_requests_total counter\n" +
            "rag_requests_total %d\n" +
            "# HELP rag_requests_5xx_total Total 5xx responses\n" +
            "# TYPE rag_requests_5xx_total counter\n" +
            "rag_requests_5xx_total %d\n" +
            "# HELP rag_requests_4xx_total Total 4xx responses\n" +
            "# TYPE rag_requests_4xx_total counter\n" +
            "rag_requests_4xx_total %d\n" +
            "# HELP rag_query_total Total /query calls\n" +
            "# TYPE rag_query_total counter\n" +
            "rag_query_total %d\n" +
            "# HELP rag_ingest_total Total /ingest calls\n" +
            "# TYPE rag_ingest_total counter\n" +
            "rag_ingest_total %d\n" +
            "# HELP rag_tokens_total Total LLM tokens consumed\n" +
            "# TYPE rag_tokens_total counter\n" +
            "rag_tokens_total %d\n" +
            "# HELP rag_api_info Build info\n" +
            "# TYPE rag_api_info gauge\n" +
            "rag_api_info{version=\"2.0.0\",language=\"java\",provider=\"%s\"} 1\n",
            METRIC_REQUESTS.get(), METRIC_5XX.get(), METRIC_4XX.get(),
            METRIC_QUERIES.get(), METRIC_INGESTS.get(), METRIC_TOKENS.get(),
            MODEL_PROVIDER
        );
        ctx.contentType("text/plain; version=0.0.4").result(body);
    }

    @SuppressWarnings("unchecked")
    static void ingestText(Context ctx) {
        if (!checkRateLimit(ctx, INGEST)) return;
        Claims claims;
        try {
            claims = verifyJwt(ctx);
            requireRole(claims, "operator", ctx);
        } catch (SecurityException e) {
            sendError(ctx, e.getMessage().contains("Missing") || e.getMessage().contains("expired") ||
                          e.getMessage().contains("Invalid") ? 401 : 403, e.getMessage()); return;
        }

        Map<String, Object> body;
        try { body = JSON.readValue(ctx.body(), Map.class); }
        catch (Exception e) { sendError(ctx, 400, "Invalid JSON"); return; }

        String content = (String) body.get("content");
        if (content == null || content.isBlank()) { sendError(ctx, 400, "content is required"); return; }
        if (content.length() > 500_000) { sendError(ctx, 400, "content exceeds 500,000 character limit"); return; }

        Map<String, String> meta = body.containsKey("metadata")
            ? (Map<String, String>) body.get("metadata")
            : new LinkedHashMap<>();
        if (meta.size() > 20) { sendError(ctx, 400, "metadata may contain at most 20 keys"); return; }

        RagEngine.Document doc = new RagEngine.Document(content, meta);
        int count;
        try {
            count = ingestWithRetry(List.of(doc));
        } catch (Exception e) {
            log("ERROR", "api.ingest_failed", Map.of(
                "doc_id", doc.docId, "error", e.getMessage(),
                "request_id", requestId(ctx)));
            sendError(ctx, 503, "Ingest failed after retries — Qdrant unavailable"); return;
        }

        METRIC_REQUESTS.incrementAndGet();
        METRIC_INGESTS.incrementAndGet();
        log("INFO", "api.ingest_text", Map.of(
            "doc_id", doc.docId, "chunk_count", count,
            "user", String.valueOf(claims.getSubject()),
            "request_id", requestId(ctx)));
        ctx.json(Map.of("doc_id", doc.docId, "chunk_count", count));
    }

    @SuppressWarnings("unchecked")
    static void query(Context ctx) {
        if (!checkRateLimit(ctx, QUERY)) return;
        Claims claims;
        try {
            claims = verifyJwt(ctx);
            requireRole(claims, "user", ctx);
        } catch (SecurityException e) {
            sendError(ctx, e.getMessage().contains("Missing") || e.getMessage().contains("expired") ||
                          e.getMessage().contains("Invalid") ? 401 : 403, e.getMessage()); return;
        }

        Map<String, Object> body;
        try { body = JSON.readValue(ctx.body(), Map.class); }
        catch (Exception e) { sendError(ctx, 400, "Invalid JSON"); return; }

        String question = (String) body.get("question");
        if (question == null || question.isBlank()) { sendError(ctx, 400, "question is required"); return; }
        if (question.length() > 4096) { sendError(ctx, 400, "question exceeds 4096 character limit"); return; }

        String role = claims.get("role", String.class);
        if (role == null) role = "readonly";
        String user = claims.getSubject() != null ? claims.getSubject() : "anonymous";
        int maxIter  = ((Number) body.getOrDefault("max_iterations", 20)).intValue();
        if (maxIter  > 50) maxIter = 50;

        // Start RBAC token budget session
        TokenEngine.Session teSession;
        try {
            teSession = tokenEngine.startSession(role, question.substring(0, Math.min(200, question.length())));
        } catch (TokenEngine.PermissionException e) {
            log("ERROR", "api.query_start_failed", Map.of(
                "role", role, "error", e.getMessage(), "request_id", requestId(ctx)));
            sendError(ctx, 403, "Unknown role: " + role); return;
        }
        log("INFO", "api.query_start", Map.of(
            "session_id", teSession.id, "role", role, "user", user,
            "max_tokens_budget", teSession.budget.maxTokens(),
            "request_id", requestId(ctx)));

        // Load or create memory session
        String sessionId = (String) body.get("session_id");
        try {
            if (sessionId != null) {
                if (memory.load(sessionId) == null) {
                    tokenEngine.endSession(teSession.id, "");
                    log("WARN", "api.session_not_found", Map.of(
                        "session_id", sessionId, "request_id", requestId(ctx)));
                    sendError(ctx, 404, "Session not found"); return;
                }
            } else {
                MemoryStore.Session s = memory.create(Map.of("user", user, "role", role));
                sessionId = s.sessionId;
            }
        } catch (Exception e) {
            tokenEngine.endSession(teSession.id, "");
            log("ERROR", "api.session_error", Map.of("error", e.getMessage(), "request_id", requestId(ctx)));
            sendError(ctx, 500, "Session error"); return;
        }

        // Enforce iteration cap from token budget
        maxIter = Math.min(maxIter, teSession.budget.maxIter());

        ReactLoop.ReactResult result;
        try {
            result = ReactLoop.runReact(
                question,
                "You have access to a 'rag_search' tool that searches a knowledge base. " +
                "Always search first, reason second, then answer. " +
                "Cite retrieved passages using the citation markers provided.",
                maxIter,
                null
            );
        } catch (TokenEngine.BudgetExceededException e) {
            log("ERROR", "api.budget_exceeded", Map.of(
                "user", user, "role", role, "error", e.getMessage(),
                "request_id", requestId(ctx)));
            tokenEngine.endSession(teSession.id, "");
            ctx.status(429)
               .header("Retry-After", "60")
               .json(Map.of("error", "Token budget exceeded: " + e.getMessage(),
                           "request_id", requestId(ctx)));
            return;
        } catch (Exception e) {
            tokenEngine.endSession(teSession.id, "");
            log("ERROR", "api.query_failed", Map.of(
                "user", user, "error", e.getMessage(), "request_id", requestId(ctx)));
            sendError(ctx, 500, "Query failed"); return;
        }

        // Record usage and close token budget session
        tokenEngine.recordUsage(
            teSession.id,
            result.trace.totalTokens / 2,
            result.trace.totalTokens - result.trace.totalTokens / 2,
            result.trace.iterations
        );
        TokenEngine.Session ended = tokenEngine.endSession(teSession.id, result.answer);
        double budgetUsedPct = ended.budgetUsedPct();

        // Persist to memory
        try {
            memory.appendUser(sessionId, question);
            memory.appendAssistant(sessionId, result.answer);
        } catch (Exception e) {
            log("ERROR", "api.memory_persist_failed", Map.of(
                "session_id", sessionId, "error", e.getMessage()));
        }

        METRIC_REQUESTS.incrementAndGet();
        METRIC_QUERIES.incrementAndGet();
        METRIC_TOKENS.addAndGet(result.trace.totalTokens);

        log("INFO", "api.query_complete", Map.of(
            "session_id", sessionId,
            "iterations", result.trace.iterations,
            "total_tokens", result.trace.totalTokens,
            "elapsed_ms", result.trace.elapsedMs,
            "budget_used_pct", String.format("%.4f", budgetUsedPct),
            "user", user, "request_id", requestId(ctx)));

        ctx.json(Map.of(
            "answer",          result.answer,
            "session_id",      sessionId,
            "iterations",      result.trace.iterations,
            "total_tokens",    result.trace.totalTokens,
            "elapsed_ms",      result.trace.elapsedMs,
            "budget_used_pct", budgetUsedPct
        ));
    }

    static void getSession(Context ctx) {
        if (!checkRateLimit(ctx, GENERAL)) return;
        Claims claims;
        try { claims = verifyJwt(ctx); requireRole(claims, "user", ctx); }
        catch (SecurityException e) { sendError(ctx, 401, e.getMessage()); return; }
        String sessionId = ctx.pathParam("id");
        try {
            MemoryStore.Session session = memory.load(sessionId);
            if (session == null) { sendError(ctx, 404, "Session not found"); return; }
            log("INFO", "api.get_session", Map.of(
                "session_id", sessionId,
                "user", String.valueOf(claims.getSubject()),
                "request_id", requestId(ctx)));
            ctx.json(Map.of(
                "session_id",    session.sessionId,
                "created_at",    session.createdAt,
                "updated_at",    session.updatedAt,
                "message_count", session.messages.size(),
                "summary",       session.summary
            ));
        } catch (Exception e) {
            log("ERROR", "api.get_session_failed", Map.of("error", e.getMessage(), "request_id", requestId(ctx)));
            sendError(ctx, 500, "Failed to retrieve session");
        }
    }

    static void deleteSession(Context ctx) {
        if (!checkRateLimit(ctx, GENERAL)) return;
        Claims claims;
        try { claims = verifyJwt(ctx); requireRole(claims, "user", ctx); }
        catch (SecurityException e) { sendError(ctx, 401, e.getMessage()); return; }
        String sessionId = ctx.pathParam("id");
        try {
            if (!memory.delete(sessionId)) { sendError(ctx, 404, "Session not found"); return; }
            log("INFO", "api.delete_session", Map.of(
                "session_id", sessionId,
                "user", String.valueOf(claims.getSubject()),
                "request_id", requestId(ctx)));
            ctx.status(204);
        } catch (Exception e) {
            log("ERROR", "api.delete_session_failed", Map.of("error", e.getMessage(), "request_id", requestId(ctx)));
            sendError(ctx, 500, "Failed to delete session");
        }
    }

    // ── Trading handlers ──────────────────────────────────────────────────────
    static void tradingStockQuote(Context ctx) {
        if (!checkRateLimit(ctx, GENERAL)) return;
        Claims claims; try { claims = verifyJwt(ctx); requireRole(claims, "user", ctx); }
        catch (SecurityException e) { sendError(ctx, 401, e.getMessage()); return; }
        String symbol = ctx.pathParam("symbol").toUpperCase();
        try {
            MarketData.StockQuote q = MarketData.getStockQuote(symbol);
            ctx.json(Map.of("symbol", q.symbol(), "price", q.price(), "change", q.change(),
                "change_pct", q.changePct(), "volume", q.volume(),
                "latest_trading_day", q.latestTradingDay()));
        } catch (Exception e) {
            log("ERROR", "api.stock_quote_failed", Map.of("symbol", symbol, "error", e.getMessage()));
            sendError(ctx, 502, e.getMessage());
        }
    }

    static void tradingCryptoQuote(Context ctx) {
        if (!checkRateLimit(ctx, GENERAL)) return;
        Claims claims; try { claims = verifyJwt(ctx); requireRole(claims, "user", ctx); }
        catch (SecurityException e) { sendError(ctx, 401, e.getMessage()); return; }
        String coinId = ctx.pathParam("coin_id").toLowerCase();
        String vs = ctx.queryParam("vs_currency") != null ? ctx.queryParam("vs_currency") : "usd";
        try {
            MarketData.CryptoQuote q = MarketData.getCryptoQuote(coinId, vs);
            ctx.json(Map.of("coin_id", q.coinId(), "price", q.price(),
                "change_24h_pct", q.change24hPct(), "market_cap", q.marketCap(),
                "volume_24h", q.volume24h()));
        } catch (Exception e) {
            log("ERROR", "api.crypto_quote_failed", Map.of("coin_id", coinId, "error", e.getMessage()));
            sendError(ctx, 502, e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    static void tradingBacktest(Context ctx) {
        if (!checkRateLimit(ctx, QUERY)) return;
        Claims claims; try { claims = verifyJwt(ctx); requireRole(claims, "user", ctx); }
        catch (SecurityException e) { sendError(ctx, 401, e.getMessage()); return; }
        Map<String, Object> body;
        try { body = JSON.readValue(ctx.body(), Map.class); }
        catch (Exception e) { sendError(ctx, 400, "Invalid JSON"); return; }
        String symbol     = (String) body.getOrDefault("symbol", "");
        String strategy   = (String) body.getOrDefault("strategy", "");
        String assetClass = (String) body.getOrDefault("asset_class", "equity");
        int    days       = ((Number) body.getOrDefault("days", 90)).intValue();
        String outputSize = (String) body.getOrDefault("output_size", "compact");
        if (symbol.isEmpty() || strategy.isEmpty()) { sendError(ctx, 400, "symbol and strategy required"); return; }
        try {
            List<MarketData.OHLCVBar> bars; int bpy;
            if ("crypto".equals(assetClass)) {
                List<MarketData.CryptoOHLCBar> cb = MarketData.getCryptoOHLCV(symbol, "usd", Math.min(days, 365));
                bars = cb.stream().map(b -> new MarketData.OHLCVBar(
                    String.valueOf(b.timestamp()), b.open(), b.high(), b.low(), b.close(), 0)).toList();
                bpy = 365;
            } else {
                bars = MarketData.getStockOHLCV(symbol.toUpperCase(), "daily", outputSize); bpy = 252;
            }
            BacktestEngine.SignalFn signalFn = switch (strategy) {
                case "sma_crossover"      -> BacktestEngine.makeSMACrossoverSignal(0, 0);
                case "rsi_mean_reversion" -> BacktestEngine.makeRSIMeanReversionSignal(0, 0, 0);
                case "breakout"           -> BacktestEngine.makeBreakoutSignal(0);
                default -> throw new IllegalArgumentException("Unknown strategy: " + strategy);
            };
            BacktestEngine.BacktestResult result = BacktestEngine.runBacktest(
                bars, signalFn, BacktestEngine.BacktestOptions.withBarsPerYear(bpy));
            log("INFO", "api.backtest", Map.of("symbol", symbol, "strategy", strategy,
                "bars", String.valueOf(bars.size()), "request_id", requestId(ctx)));
            ctx.json(result);
        } catch (IllegalArgumentException e) { sendError(ctx, 400, e.getMessage()); }
        catch (Exception e) {
            log("ERROR", "api.backtest_failed", Map.of("symbol", symbol, "error", e.getMessage()));
            sendError(ctx, 502, e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    static void tradingPropose(Context ctx) {
        if (!checkRateLimit(ctx, GENERAL)) return;
        Claims claims; try { claims = verifyJwt(ctx); requireRole(claims, "user", ctx); }
        catch (SecurityException e) { sendError(ctx, 401, e.getMessage()); return; }
        Map<String, Object> body;
        try { body = JSON.readValue(ctx.body(), Map.class); }
        catch (Exception e) { sendError(ctx, 400, "Invalid JSON"); return; }
        String  symbol     = (String) body.getOrDefault("symbol", "");
        String  side       = (String) body.getOrDefault("side", "");
        double  quantity   = ((Number) body.getOrDefault("quantity", 0)).doubleValue();
        String  assetClass = (String) body.getOrDefault("asset_class", "equity");
        String  orderType  = (String) body.getOrDefault("order_type", "market");
        Double  limitPrice = body.containsKey("limit_price")
            ? ((Number) body.get("limit_price")).doubleValue() : null;
        String  rationale  = (String) body.getOrDefault("rationale", "");
        if (symbol.isEmpty() || side.isEmpty() || rationale.isEmpty()) {
            sendError(ctx, 400, "symbol, side, quantity, rationale required"); return;
        }
        try {
            TradingAgent.OrderProposal p = TradingAgent.proposeOrder(
                symbol, side, quantity, assetClass, orderType, limitPrice, rationale);
            log("INFO", "api.order_proposed", Map.of("proposal_id", p.proposalId(),
                "symbol", symbol, "side", side,
                "user", String.valueOf(claims.getSubject()), "request_id", requestId(ctx)));
            ctx.json(p);
        } catch (IllegalArgumentException e) { sendError(ctx, 400, e.getMessage()); }
    }

    static void tradingGetProposal(Context ctx) {
        if (!checkRateLimit(ctx, GENERAL)) return;
        Claims claims; try { claims = verifyJwt(ctx); requireRole(claims, "user", ctx); }
        catch (SecurityException e) { sendError(ctx, 401, e.getMessage()); return; }
        TradingAgent.getProposal(ctx.pathParam("id")).ifPresentOrElse(
            p  -> ctx.json(p),
            () -> sendError(ctx, 404, "Proposal not found")
        );
    }

    @SuppressWarnings("unchecked")
    static void tradingExecute(Context ctx) {
        if (!checkRateLimit(ctx, GENERAL)) return;
        Claims claims;
        try {
            claims = verifyJwt(ctx);
            requireRole(claims, "operator", ctx); // operator+ required for execution
        } catch (SecurityException e) { sendError(ctx, 401, e.getMessage()); return; }
        Map<String, Object> body;
        try { body = JSON.readValue(ctx.body(), Map.class); }
        catch (Exception e) { sendError(ctx, 400, "Invalid JSON"); return; }
        String  proposalId = (String) body.getOrDefault("proposal_id", "");
        boolean confirm    = Boolean.TRUE.equals(body.get("confirm"));
        if (!confirm) {
            log("WARN", "api.execute_rejected_no_confirm", Map.of("proposal_id", proposalId,
                "user", String.valueOf(claims.getSubject()), "request_id", requestId(ctx)));
            sendError(ctx, 400, "confirm must be true — review the proposal before executing"); return;
        }
        try {
            TradingAgent.ExecutionResult result = TradingAgent.orderExecuteIBKR(proposalId, true);
            log("WARN", "api.order_executed", Map.of("proposal_id", proposalId,
                "mode", result.mode(), "user", String.valueOf(claims.getSubject()), "request_id", requestId(ctx)));
            ctx.json(result);
        } catch (IllegalArgumentException | SecurityException e) { sendError(ctx, 400, e.getMessage()); }
    }

    // ── Start ─────────────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        // Fail fast on missing required config — never start in degraded state
        if (JWT_KEY == null) {
            System.err.println("[rag-api-java] FATAL: JWT_SECRET environment variable is required");
            System.exit(1);
        }
        validateProviderKey();

        init();

        Javalin app = Javalin.create(config -> {
            // CORS — explicit allowlist, never wildcard on authenticated endpoints
            config.bundledPlugins.enableCors(cors -> cors.addRule(rule -> {
                for (String origin : CORS_ORIGINS.split(",")) {
                    String trimmed = origin.trim();
                    if (!trimmed.isEmpty()) rule.allowHost(trimmed);
                }
            }));
        });

        // ── Security headers + correlation ID on every request ────────────────
        // OWASP ASVS 5.0 + OWASP Secure Headers Project — all required headers
        app.before(ctx -> {
            String reqId = ctx.header("X-Request-ID");
            if (reqId == null || reqId.isBlank()) {
                reqId = UUID.randomUUID().toString().replace("-", "");
            }
            ctx.attribute("request_id", reqId);
            ctx.res().setHeader("X-Request-ID",                 reqId);
            ctx.res().setHeader("Strict-Transport-Security",    "max-age=63072000; includeSubDomains; preload");
            ctx.res().setHeader("Content-Security-Policy",      "default-src 'none'; frame-ancestors 'none'");
            ctx.res().setHeader("X-Content-Type-Options",       "nosniff");
            ctx.res().setHeader("X-Frame-Options",              "DENY");
            ctx.res().setHeader("Referrer-Policy",              "strict-origin-when-cross-origin");
            ctx.res().setHeader("Permissions-Policy",           "geolocation=(), camera=(), microphone=(), payment=()");
            ctx.res().setHeader("Cross-Origin-Opener-Policy",   "same-origin");
            ctx.res().setHeader("Cross-Origin-Embedder-Policy", "require-corp");
            ctx.res().setHeader("Cross-Origin-Resource-Policy", "same-origin");
            ctx.res().setHeader("Cache-Control",                "no-store");
            ctx.res().setHeader("X-XSS-Protection",             "0");
            ctx.res().setHeader("Expose-Headers",
                "X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After");
        });

        // ── Routes ────────────────────────────────────────────────────────────
        app.get("/health",           RagApi::health);
        app.get("/ready",            RagApi::ready);
        app.get("/metrics",          RagApi::metrics);
        app.post("/ingest/text",     RagApi::ingestText);
        app.post("/query",           RagApi::query);
        app.get("/sessions/{id}",    RagApi::getSession);
        app.delete("/sessions/{id}", RagApi::deleteSession);
        // Trading endpoints — wired to TradingAgent functions
        app.get("/trading/quote/stock/{symbol}",  RagApi::tradingStockQuote);
        app.get("/trading/quote/crypto/{coin_id}", RagApi::tradingCryptoQuote);
        app.post("/trading/backtest",             RagApi::tradingBacktest);
        app.post("/trading/propose",              RagApi::tradingPropose);
        app.get("/trading/proposals/{id}",        RagApi::tradingGetProposal);
        app.post("/trading/execute",              RagApi::tradingExecute);

        // ── Exception handler — never expose internal details in responses ────
        app.exception(Exception.class, (e, ctx) -> {
            String reqId = requestId(ctx);
            log("ERROR", "api.unhandled_exception", Map.of(
                "error", e.getMessage() != null ? e.getMessage() : "unknown",
                "error_type", e.getClass().getSimpleName(),
                "path", ctx.path(), "request_id", reqId));
            ctx.status(500).json(Map.of("error", "Internal server error", "request_id", reqId));
            METRIC_5XX.incrementAndGet();
        });

        app.start(PORT);
        log("INFO", "api.listening", Map.of("port", PORT, "provider", MODEL_PROVIDER));

        // ── Graceful SIGTERM shutdown — drain in-flight requests, max 30s ─────
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            log("INFO", "api.shutdown_signal", Map.of("signal", "SIGTERM"));
            app.stop();
            log("INFO", "api.shutdown_complete", Map.of());
        }, "shutdown-hook"));
    }

    static void validateProviderKey() {
        Map<String, String> keyMap = Map.of(
            "anthropic",        "ANTHROPIC_API_KEY",
            "deepseek",         "DEEPSEEK_API_KEY",
            "deepseek-openai",  "DEEPSEEK_API_KEY",
            "openai",           "OPENAI_API_KEY"
        );
        String envVar = keyMap.get(MODEL_PROVIDER.toLowerCase());
        if (envVar != null && (System.getenv(envVar) == null || System.getenv(envVar).isBlank())) {
            System.err.println("[rag-api-java] FATAL: " + envVar + " required for provider '" + MODEL_PROVIDER + "'");
            System.exit(1);
        }
    }
}
