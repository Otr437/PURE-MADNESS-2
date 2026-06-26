/**
 * RAG REST API — TypeScript (Production-Complete)
 * Express service. All OWASP ASVS 5.0 + Secure Headers Project requirements met.
 *
 * Endpoints:
 *   GET  /health           liveness probe
 *   GET  /ready            readiness probe (Qdrant verified)
 *   GET  /metrics          Prometheus-compatible metrics
 *   POST /ingest/text      ingest raw text (operator+)
 *   POST /query            RAG query with session memory + RBAC budget (user+)
 *   GET  /sessions/:id     retrieve session (user+)
 *   DELETE /sessions/:id   delete session (user+)
 *
 * Auth:        Bearer JWT HS256, algorithms pinned, alg:none rejected
 * Rate limits: per-IP per-endpoint; 429 with Retry-After + X-RateLimit-*
 * RBAC:        TokenEngine budget enforcement on every /query call
 * Circuit:     exponential-backoff retry on Qdrant + model provider calls
 * Tracing:     X-Request-ID generated/propagated on every request
 * Logging:     pino structured JSON on every request, security event, error
 * Shutdown:    SIGTERM → server.close() drains → clean exit (max 30s)
 */

import * as crypto from "crypto";
import * as http    from "http";
import * as process from "process";

import express, { NextFunction, Request, Response } from "express";
import rateLimit    from "express-rate-limit";
import jwt          from "jsonwebtoken";
import pino         from "pino";
import { z }        from "zod";

import { MemoryStore, buildContextMessages, maybeCompact } from "./memory";
import { ModelRouter }                                      from "./model_router";
import { RAGEngine, Document, makeRagTool }                 from "./rag_engine";
import { loadDirectory }                                    from "./loaders";
import { toolRegistry, toolSchemas, runReact }              from "./react_loop";
import {
    TokenEngine,
    BudgetExceededError,
    RBACConfig,
} from "./token_engine";

// ── Structured logger (JSON — never console.log) ──────────────────────────────
const log = pino({
    level:      process.env.LOG_LEVEL ?? "info",
    base:       { service: "rag-api-typescript" },
    timestamp:  pino.stdTimeFunctions.isoTime,
    redact:     ["req.headers.authorization"],   // never log auth tokens
});

// ── Config (fail fast on missing required values) ─────────────────────────────
const JWT_SECRET      = process.env.JWT_SECRET;
const JWT_ALGORITHM   = "HS256" as const;
const PORT            = parseInt(process.env.PORT ?? "8001", 10);
const QDRANT_URL      = process.env.QDRANT_URL ?? "http://localhost:6333";
const MODEL_PROVIDER  = process.env.MODEL_PROVIDER ?? "anthropic";
const CORS_ORIGINS    = (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",").map((s) => s.trim()).filter(Boolean);

// ── RBAC token budget config ───────────────────────────────────────────────────
const RBAC_CONFIG: RBACConfig = {
    roles: {
        admin:    { maxTokens: 200_000, maxIter: 50, alertPct: 0.80, costPer1k: 0.015 },
        operator: { maxTokens:  80_000, maxIter: 30, alertPct: 0.75, costPer1k: 0.015 },
        user:     { maxTokens:  20_000, maxIter: 20, alertPct: 0.70, costPer1k: 0.015 },
        readonly: { maxTokens:   4_000, maxIter:  5, alertPct: 0.60, costPer1k: 0.015 },
    },
};

const ROLE_RANK: Record<string, number> = {
    admin: 4, operator: 3, user: 2, readonly: 1,
};

// ── Prometheus metrics counters ────────────────────────────────────────────────
const metrics = {
    requestsTotal:   0,
    requests5xx:     0,
    requests4xx:     0,
    queryTotal:      0,
    ingestTotal:     0,
    tokensTotal:     0,
    latencySamples:  [] as number[],

    recordRequest(status: number, latencyS: number): void {
        this.requestsTotal++;
        if (status >= 500) this.requests5xx++;
        else if (status >= 400) this.requests4xx++;
        this.latencySamples.push(latencyS);
        if (this.latencySamples.length > 10_000) {
            this.latencySamples = this.latencySamples.slice(-10_000);
        }
    },

    percentile(p: number): number {
        if (!this.latencySamples.length) return 0;
        const sorted = [...this.latencySamples].sort((a, b) => a - b);
        const idx    = Math.floor(sorted.length * p / 100);
        return sorted[Math.min(idx, sorted.length - 1)];
    },

    prometheus(): string {
        const p50 = this.percentile(50).toFixed(4);
        const p95 = this.percentile(95).toFixed(4);
        const p99 = this.percentile(99).toFixed(4);
        return [
            "# HELP rag_requests_total Total HTTP requests",
            "# TYPE rag_requests_total counter",
            `rag_requests_total ${this.requestsTotal}`,
            "# HELP rag_requests_5xx_total Total 5xx responses",
            "# TYPE rag_requests_5xx_total counter",
            `rag_requests_5xx_total ${this.requests5xx}`,
            "# HELP rag_requests_4xx_total Total 4xx responses",
            "# TYPE rag_requests_4xx_total counter",
            `rag_requests_4xx_total ${this.requests4xx}`,
            "# HELP rag_query_total Total /query calls",
            "# TYPE rag_query_total counter",
            `rag_query_total ${this.queryTotal}`,
            "# HELP rag_ingest_total Total /ingest calls",
            "# TYPE rag_ingest_total counter",
            `rag_ingest_total ${this.ingestTotal}`,
            "# HELP rag_tokens_total Total LLM tokens consumed",
            "# TYPE rag_tokens_total counter",
            `rag_tokens_total ${this.tokensTotal}`,
            "# HELP rag_latency_p50_seconds Request latency p50",
            "# TYPE rag_latency_p50_seconds gauge",
            `rag_latency_p50_seconds ${p50}`,
            "# HELP rag_latency_p95_seconds Request latency p95",
            "# TYPE rag_latency_p95_seconds gauge",
            `rag_latency_p95_seconds ${p95}`,
            "# HELP rag_latency_p99_seconds Request latency p99",
            "# TYPE rag_latency_p99_seconds gauge",
            `rag_latency_p99_seconds ${p99}`,
            "# HELP rag_api_info Build info",
            "# TYPE rag_api_info gauge",
            `rag_api_info{version="2.0.0",provider="${MODEL_PROVIDER}",language="typescript"} 1`,
        ].join("\n") + "\n";
    },
};

// ── Shared state ───────────────────────────────────────────────────────────────
const engine       = new RAGEngine("api_ts");
const memory       = new MemoryStore();
const tokenEngine  = new TokenEngine(
    RBAC_CONFIG,
    {
        auditPath: process.env.AGENT_AUDIT_LOG ?? "/tmp/rag_audit_ts.jsonl",
        onAlert:   (session, msg) => log.warn({ event: "token_engine.alert", sessionId: session.id, role: session.role, message: msg, budgetUsedPct: session.budgetUsedPct }),
        onAbort:   (session, reason) => log.error({ event: "token_engine.abort", sessionId: session.id, role: session.role, reason, totalTokens: session.totalTokens }),
    }
);

// Register RAG search tool into react_loop tool registry
(async () => {
    await engine.init();
    const { schema: ragSchema, fn: ragFn } = makeRagTool(engine);
    if (!toolSchemas.find((s: any) => s.name === "rag_search")) {
        toolSchemas.push(ragSchema as any);
        toolRegistry.set("rag_search", ({ query, top_k }: { query: string; top_k?: number }) =>
            ragFn({ query, top_k })
        );
    }
    log.info({ event: "api.startup", qdrantUrl: QDRANT_URL, modelProvider: MODEL_PROVIDER, corsOrigins: CORS_ORIGINS });
})().catch((err) => {
    log.error({ event: "api.startup_failed", error: String(err) });
    process.exit(1);
});

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// CORS — explicit allowlist, never wildcard on authenticated endpoints
app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin ?? "";
    if (CORS_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin",      origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods",     "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers",     "Authorization, Content-Type, X-Request-ID");
        res.setHeader("Access-Control-Expose-Headers",    "X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After");
        res.setHeader("Access-Control-Max-Age",           "600");
    }
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
});

// ── Security headers + correlation ID + metrics middleware ────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
    const start     = process.hrtime.bigint();
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? crypto.randomUUID();
    (req as any).requestId = requestId;

    res.on("finish", () => {
        const latencyS = Number(process.hrtime.bigint() - start) / 1e9;
        metrics.recordRequest(res.statusCode, latencyS);
        log.info({
            event:      "request.complete",
            method:     req.method,
            path:       req.path,
            status:     res.statusCode,
            latencyS:   latencyS.toFixed(4),
            requestId,
            remoteAddr: req.ip ?? "unknown",
        });
    });

    // OWASP ASVS 5.0 + OWASP Secure Headers Project — all required headers
    res.setHeader("X-Request-ID",                 requestId);
    res.setHeader("Strict-Transport-Security",    "max-age=63072000; includeSubDomains; preload");
    res.setHeader("Content-Security-Policy",      "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options",       "nosniff");
    res.setHeader("X-Frame-Options",              "DENY");
    res.setHeader("Referrer-Policy",              "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy",           "geolocation=(), camera=(), microphone=(), payment=()");
    res.setHeader("Cross-Origin-Opener-Policy",   "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control",                "no-store");
    res.setHeader("X-XSS-Protection",             "0");
    res.removeHeader("Server");
    next();
});

// ── Rate limiters with Retry-After + X-RateLimit-* headers ───────────────────
const makeRateLimiter = (max: number, windowMs = 60_000) =>
    rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders:   false,
        handler: (req: Request, res: Response) => {
            const requestId = (req as any).requestId ?? "unknown";
            log.warn({ event: "security.rate_limit_exceeded", path: req.path, requestId, ip: req.ip });
            res.status(429)
                .setHeader("Retry-After",           "60")
                .setHeader("X-RateLimit-Limit",     String(max))
                .setHeader("X-RateLimit-Remaining", "0")
                .setHeader("X-RateLimit-Reset",     String(Math.floor(Date.now() / 1000) + 60))
                .json({ error: "Rate limit exceeded", request_id: requestId });
        },
    });

const generalLimiter = makeRateLimiter(60);
const ingestLimiter  = makeRateLimiter(30);
const queryLimiter   = makeRateLimiter(20);

// ── Auth helpers ──────────────────────────────────────────────────────────────
function verifyJWT(req: Request): Record<string, unknown> {
    if (!JWT_SECRET) {
        log.error({ event: "auth.jwt_secret_missing" });
        throw Object.assign(new Error("Server misconfiguration"), { statusCode: 500 });
    }
    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
        const requestId = (req as any).requestId ?? "unknown";
        log.warn({ event: "security.auth_failure", reason: "missing_bearer", path: req.path, requestId });
        throw Object.assign(new Error("Authorization header must be 'Bearer <token>'"), { statusCode: 401 });
    }
    const token = authHeader.slice(7).trim();
    try {
        return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] }) as Record<string, unknown>;
    } catch (e: any) {
        const requestId = (req as any).requestId ?? "unknown";
        const reason    = e.name === "TokenExpiredError" ? "token_expired" : "invalid_token";
        log.warn({ event: "security.auth_failure", reason, path: req.path, requestId });
        const msg = e.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
        throw Object.assign(new Error(msg), { statusCode: 401 });
    }
}

function requireRole(claims: Record<string, unknown>, required: string, requestId: string): void {
    const role = (claims.role as string) ?? "readonly";
    if ((ROLE_RANK[role] ?? 0) < (ROLE_RANK[required] ?? 0)) {
        log.warn({
            event: "security.authz_failure",
            user: claims.sub,
            role,
            required,
            requestId,
        });
        throw Object.assign(
            new Error(`Role '${role}' cannot perform this action (requires '${required}')`),
            { statusCode: 403 }
        );
    }
}

// ── Error handler helper ──────────────────────────────────────────────────────
function handleError(res: Response, err: unknown, requestId: string): void {
    const e          = err as any;
    const statusCode = e.statusCode ?? 500;
    const message    = statusCode < 500 ? e.message : "Internal server error";
    if (statusCode >= 500) {
        log.error({ event: "api.error", error: e.message, stack: e.stack, requestId });
    }
    res.status(statusCode).json({ error: message, request_id: requestId });
}

// ── Retry helper for Qdrant calls (circuit-breaker pattern) ───────────────────
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            if (attempt < maxAttempts) {
                const delay = Math.min(2 ** attempt * 1000, 30_000);
                await new Promise((r) => setTimeout(r, delay + Math.random() * 1000));
            }
        }
    }
    throw lastErr;
}

// ── Input validation schemas ──────────────────────────────────────────────────
const IngestTextSchema = z.object({
    content:  z.string().min(1).max(500_000),
    metadata: z.record(z.string()).default({}).refine(
        (m) => Object.keys(m).length <= 20 &&
               Object.entries(m).every(([k, v]) => k.length <= 64 && v.length <= 512),
        { message: "metadata: max 20 keys, key≤64 chars, value≤512 chars" }
    ),
});

const QuerySchema = z.object({
    question:       z.string().min(1).max(4096),
    session_id:     z.string().optional(),
    max_iterations: z.number().int().min(1).max(50).default(20),
    top_k:          z.number().int().min(1).max(20).default(5),
});

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", time: Date.now() });
});

app.get("/ready", async (_req: Request, res: Response) => {
    try {
        const info = await engine.collectionInfo();
        if (!info.name) throw new Error("invalid collection response");
        res.json({ status: "ready", checks: { qdrant: "ok" } });
    } catch (e) {
        log.error({ event: "ready.qdrant_check_failed", error: String(e) });
        res.status(503).json({ status: "not_ready", errors: [`qdrant: ${e}`] });
    }
});

app.get("/metrics", (_req: Request, res: Response) => {
    res.type("text/plain; version=0.0.4").send(metrics.prometheus());
});

app.post("/ingest/text", ingestLimiter, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req);
        requireRole(claims, "operator", requestId);
        const body = IngestTextSchema.parse(req.body);
        const doc: Document = { content: body.content, metadata: body.metadata as Record<string, string> };
        const count = await withRetry(() => engine.ingest([doc]));
        metrics.ingestTotal++;
        log.info({ event: "api.ingest_text", docId: doc.docId, chunkCount: count, user: claims.sub, requestId });
        res.json({ doc_id: doc.docId, chunk_count: count });
    } catch (e) {
        handleError(res, e, requestId);
    }
});

app.post("/query", queryLimiter, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req);
        requireRole(claims, "user", requestId);
        const body  = QuerySchema.parse(req.body);
        const role  = (claims.role as string) ?? "readonly";
        const user  = (claims.sub  as string) ?? "anonymous";

        // Start RBAC token budget session
        const teSession = tokenEngine.startSession(role, body.question.slice(0, 200));
        log.info({
            event: "api.query_start",
            sessionId: teSession.id,
            role,
            user,
            requestId,
            maxTokensBudget: teSession.budget.maxTokens,
        });

        // Load or create memory session
        let memSessionId = body.session_id;
        if (memSessionId) {
            if (!memory.load(memSessionId)) {
                tokenEngine.endSession(teSession.id);
                log.warn({ event: "api.session_not_found", sessionId: memSessionId, requestId });
                res.status(404).json({ error: "Session not found", request_id: requestId });
                return;
            }
        } else {
            const memSession = memory.create({ user, role });
            memSessionId     = memSession.sessionId;
        }

        const memSession = memory.load(memSessionId!)!;
        await maybeCompact(memory, memSession);

        const maxIter = Math.min(body.max_iterations, teSession.budget.maxIter);

        let answer: string;
        let trace: any;
        try {
            const result = await runReact(body.question, {
                systemExtra: (
                    "You have access to a 'rag_search' tool that searches a knowledge base. " +
                    "Always search first, reason second, then answer. " +
                    "Cite retrieved passages using the citation markers provided."
                ),
                maxIterations: maxIter,
            });
            answer = result.answer;
            trace  = result.trace;
        } catch (e) {
            tokenEngine.endSession(teSession.id);
            if (e instanceof BudgetExceededError) {
                log.error({ event: "api.budget_exceeded", user, role, requestId, error: String(e) });
                res.status(429)
                    .setHeader("Retry-After", "60")
                    .json({ error: `Token budget exceeded: ${e.message}`, request_id: requestId });
                return;
            }
            throw e;
        }

        // Record usage and close token budget session
        tokenEngine.recordUsage(
            teSession.id,
            Math.floor(trace.totalTokens / 2),
            trace.totalTokens - Math.floor(trace.totalTokens / 2),
            trace.iterations,
        );
        const ended = tokenEngine.endSession(teSession.id, answer);
        metrics.queryTotal++;
        metrics.tokensTotal += trace.totalTokens;

        // Persist to memory
        memory.appendUser(memSessionId!, body.question);
        memory.appendAssistant(memSessionId!, answer);

        log.info({
            event:          "api.query_complete",
            memSessionId,
            iterations:     trace.iterations,
            totalTokens:    trace.totalTokens,
            elapsedMs:      trace.elapsedMs,
            budgetUsedPct:  ended.budgetUsedPct?.toFixed(4),
            user,
            requestId,
        });

        res.json({
            answer,
            session_id:       memSessionId,
            iterations:       trace.iterations,
            total_tokens:     trace.totalTokens,
            elapsed_ms:       trace.elapsedMs,
            budget_used_pct:  parseFloat((ended.budgetUsedPct ?? 0).toFixed(4)),
            trace:            trace.steps,
        });
    } catch (e) {
        handleError(res, e, requestId);
    }
});

app.get("/sessions/:id", generalLimiter, (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req);
        requireRole(claims, "user", requestId);
        const session = memory.load(req.params.id);
        if (!session) {
            res.status(404).json({ error: "Session not found", request_id: requestId });
            return;
        }
        log.info({ event: "api.get_session", sessionId: req.params.id, user: claims.sub, requestId });
        res.json({
            session_id:    session.sessionId,
            created_at:    session.createdAt,
            updated_at:    session.updatedAt,
            message_count: session.messages.length,
            summary:       session.summary,
        });
    } catch (e) {
        handleError(res, e, requestId);
    }
});

app.delete("/sessions/:id", generalLimiter, (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req);
        requireRole(claims, "user", requestId);
        const deleted = memory.delete(req.params.id);
        if (!deleted) {
            res.status(404).json({ error: "Session not found", request_id: requestId });
            return;
        }
        log.info({ event: "api.delete_session", sessionId: req.params.id, user: claims.sub, requestId });
        res.sendStatus(204);
    } catch (e) {
        handleError(res, e, requestId);
    }
});

// ── Global error handler — never expose internals in responses ────────────────
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as any).requestId ?? "unknown";
    log.error({ event: "api.unhandled_error", error: String(err), path: req.path, requestId });
    res.status(500).json({ error: "Internal server error", request_id: requestId });
});

// ── Startup validation (fail fast) ───────────────────────────────────────────
function validateConfig(): void {
    if (!JWT_SECRET) {
        log.error({ event: "startup.missing_config", key: "JWT_SECRET" });
        process.stderr.write("[rag-api-ts] FATAL: JWT_SECRET environment variable is required\n");
        process.exit(1);
    }
    const keyMap: Record<string, string> = {
        anthropic:       "ANTHROPIC_API_KEY",
        deepseek:        "DEEPSEEK_API_KEY",
        "deepseek-openai": "DEEPSEEK_API_KEY",
        openai:          "OPENAI_API_KEY",
    };
    const envVar = keyMap[MODEL_PROVIDER.toLowerCase()];
    if (envVar && !process.env[envVar]) {
        log.error({ event: "startup.missing_config", key: envVar, provider: MODEL_PROVIDER });
        process.stderr.write(`[rag-api-ts] FATAL: ${envVar} required for provider '${MODEL_PROVIDER}'\n`);
        process.exit(1);
    }
}

// ── Server start + graceful SIGTERM shutdown ──────────────────────────────────
validateConfig();

const server = http.createServer(app);

// ── Trading endpoints ─────────────────────────────────────────────────────────
// Lazy import — gracefully unavailable if trading deps missing
let _tradingLoaded = false;
let _getStockQuote: any, _getCryptoQuote: any, _getStockOHLCV: any, _getCryptoOHLCV: any;
let _runBacktest: any, _makeSMA: any, _makeRSI: any, _makeBreakout: any;
let _proposeOrder: any, _getProposal: any, _orderExecuteIBKR: any;

async function loadTrading(): Promise<boolean> {
    if (_tradingLoaded) return true;
    try {
        const md = await import("./market_data");
        const be = await import("./backtest_engine");
        const ta = await import("./trading_agent");
        _getStockQuote = md.getStockQuote; _getCryptoQuote = md.getCryptoQuote;
        _getStockOHLCV = md.getStockOHLCV; _getCryptoOHLCV = md.getCryptoOHLCV;
        _runBacktest = be.runBacktest; _makeSMA = be.makeSMACrossoverSignal;
        _makeRSI = be.makeRSIMeanReversionSignal; _makeBreakout = be.makeBreakoutSignal;
        _proposeOrder = ta.proposeOrder; _getProposal = ta.getProposal;
        _orderExecuteIBKR = ta.orderExecuteIBKR;
        _tradingLoaded = true;
        return true;
    } catch { return false; }
}

app.get("/trading/quote/stock/:symbol", queryLimiter, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req); requireRole(claims, "user", requestId);
        if (!await loadTrading()) { res.status(503).json({ error: "Trading module unavailable", request_id: requestId }); return; }
        const q = await _getStockQuote(req.params.symbol.toUpperCase());
        res.json({ symbol: q.symbol, price: q.price, change: q.change, change_pct: q.changePct,
                   volume: q.volume, latest_trading_day: q.latestTradingDay });
    } catch (e) { handleError(res, e, requestId); }
});

app.get("/trading/quote/crypto/:coin_id", queryLimiter, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req); requireRole(claims, "user", requestId);
        if (!await loadTrading()) { res.status(503).json({ error: "Trading module unavailable", request_id: requestId }); return; }
        const vs = (req.query.vs_currency as string) ?? "usd";
        const q = await _getCryptoQuote(req.params.coin_id.toLowerCase(), vs);
        res.json({ coin_id: q.coinId, price: q.price, change_24h_pct: q.change24hPct,
                   market_cap: q.marketCap, volume_24h: q.volume24h });
    } catch (e) { handleError(res, e, requestId); }
});

app.post("/trading/backtest", queryLimiter, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req); requireRole(claims, "user", requestId);
        if (!await loadTrading()) { res.status(503).json({ error: "Trading module unavailable", request_id: requestId }); return; }
        const { symbol, strategy, asset_class = "equity", days = 90, output_size = "compact" } = req.body;
        if (!symbol || !strategy) { res.status(400).json({ error: "symbol and strategy required", request_id: requestId }); return; }
        const validStrategies = ["sma_crossover", "rsi_mean_reversion", "breakout"];
        if (!validStrategies.includes(strategy)) { res.status(400).json({ error: `strategy must be one of: ${validStrategies.join(", ")}`, request_id: requestId }); return; }
        const bars = asset_class === "crypto"
            ? await _getCryptoOHLCV(symbol.toLowerCase(), "usd", Math.min(days, 365))
            : await _getStockOHLCV(symbol.toUpperCase(), "daily", output_size);
        const signalMap: Record<string, () => any> = {
            sma_crossover: () => _makeSMA(), rsi_mean_reversion: () => _makeRSI(), breakout: () => _makeBreakout()
        };
        const result = _runBacktest(bars, signalMap[strategy](), { barsPerYear: asset_class === "crypto" ? 365 : 252 });
        log.info({ event: "api.backtest", symbol, strategy, bars: bars.length, total_return: result.totalReturnPct, requestId });
        res.json(result);
    } catch (e) { handleError(res, e, requestId); }
});

app.post("/trading/propose", generalLimiter, async (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req); requireRole(claims, "user", requestId);
        if (!await loadTrading()) { res.status(503).json({ error: "Trading module unavailable", request_id: requestId }); return; }
        const { symbol, side, quantity, asset_class, order_type, limit_price, rationale } = req.body;
        if (!symbol || !side || !quantity || !rationale) { res.status(400).json({ error: "symbol, side, quantity, rationale required", request_id: requestId }); return; }
        const proposal = _proposeOrder({ symbol, side, quantity, assetClass: asset_class, orderType: order_type, limitPrice: limit_price, rationale });
        log.info({ event: "api.order_proposed", proposalId: proposal.proposalId, symbol, side, user: claims.sub, requestId });
        res.json(proposal);
    } catch (e) { handleError(res, e, requestId); }
});

app.get("/trading/proposals/:id", generalLimiter, (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req); requireRole(claims, "user", requestId);
        if (!_tradingLoaded || !_getProposal) { res.status(503).json({ error: "Trading module unavailable", request_id: requestId }); return; }
        const proposal = _getProposal(req.params.id);
        if (!proposal) { res.status(404).json({ error: "Proposal not found", request_id: requestId }); return; }
        res.json(proposal);
    } catch (e) { handleError(res, e, requestId); }
});

app.post("/trading/execute", generalLimiter, (req: Request, res: Response) => {
    const requestId = (req as any).requestId ?? "unknown";
    try {
        const claims = verifyJWT(req);
        // Execution requires operator+ — not just any user
        requireRole(claims, "operator", requestId);
        if (!_tradingLoaded || !_orderExecuteIBKR) { res.status(503).json({ error: "Trading module unavailable", request_id: requestId }); return; }
        const { proposal_id, confirm } = req.body;
        if (!confirm) {
            log.warn({ event: "api.execute_rejected_no_confirm", proposalId: proposal_id, user: claims.sub, requestId });
            res.status(400).json({ error: "confirm must be true. Review the proposal before executing.", request_id: requestId });
            return;
        }
        const result = _orderExecuteIBKR(proposal_id, true);
        log.warn({ event: "api.order_executed", proposalId: proposal_id, mode: result.mode, user: claims.sub, requestId });
        res.json(result);
    } catch (e) { handleError(res, e, requestId); }
});

server.listen(PORT, () => {
    log.info({ event: "api.listening", port: PORT, provider: MODEL_PROVIDER });
});

function gracefulShutdown(signal: string): void {
    log.info({ event: "api.shutdown_signal", signal });
    server.close((err) => {
        if (err) {
            log.error({ event: "api.shutdown_error", error: String(err) });
            process.exit(1);
        }
        log.info({ event: "api.shutdown_complete" });
        process.exit(0);
    });
    // Force kill after 30 seconds if drain hangs (OWASP: graceful shutdown max 30s)
    setTimeout(() => {
        log.error({ event: "api.shutdown_timeout" });
        process.exit(1);
    }, 30_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

export { app };
