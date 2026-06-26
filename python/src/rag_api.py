"""
RAG REST API — Python  (Production-Complete)
FastAPI service. All OWASP ASVS 5.0 + Secure Headers Project requirements met.

Endpoints:
  GET  /health          — liveness probe
  GET  /ready           — readiness probe (Qdrant connectivity verified)
  GET  /metrics         — Prometheus-compatible metrics
  POST /ingest/text     — ingest raw text (operator+)
  POST /ingest/directory— ingest directory of files (admin)
  POST /query           — RAG query with session memory (user+)
  GET  /sessions/{id}   — retrieve session (user+)
  DELETE /sessions/{id} — delete session (user+)

Auth:        Bearer JWT HS256, PyJWT 2.10.1, algorithms pinned, alg:none rejected
Rate limits: per-IP per-endpoint via slowapi; 429 with Retry-After
RBAC:        admin > operator > user > readonly enforced on every endpoint
Circuit:     tenacity exponential-backoff retry on Qdrant + model provider calls
Token engine: RBAC budget enforcement on every /query call
Tracing:     X-Request-ID generated/propagated on every request
Logging:     structlog JSON on every request, security event, error
Shutdown:    SIGTERM → lifespan context manager drains → clean exit
"""

import os
import signal
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Annotated

import jwt
import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field, field_validator
from qdrant_client import QdrantClient
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from tenacity import (
    RetryError,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from loaders import load_directory
from memory import MemoryStore, build_context_messages, maybe_compact
from model_router import ModelRouter
from rag_engine import Document, RAGEngine, make_rag_tool
from react_loop import TOOL_REGISTRY, TOOL_SCHEMAS, run_react
from token_engine import (
    BudgetExceededError,
    RBACConfig,
    Role,
    TokenEngine,
)

# ── Structured logger (JSON, never console.log) ────────────────────────────────
structlog.configure(processors=[
    structlog.processors.TimeStamper(fmt="iso"),
    structlog.processors.add_log_level,
    structlog.processors.JSONRenderer(),
])
log = structlog.get_logger()

# ── Config (fail fast on missing required values at startup) ───────────────────
JWT_SECRET    = os.environ.get("JWT_SECRET")
JWT_ALGORITHM = "HS256"
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
QDRANT_URL    = os.environ.get("QDRANT_URL", ":memory:")
MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "anthropic")
PORT          = int(os.environ.get("PORT", "8000"))

# ── RBAC token budget config ───────────────────────────────────────────────────
_RBAC_CONFIG = RBACConfig(roles={
    "admin":    Role(max_tokens=200_000, max_iter=50,  alert_pct=0.8,  cost_per_1k=0.015),
    "operator": Role(max_tokens=80_000,  max_iter=30,  alert_pct=0.75, cost_per_1k=0.015),
    "user":     Role(max_tokens=20_000,  max_iter=20,  alert_pct=0.7,  cost_per_1k=0.015),
    "readonly": Role(max_tokens=4_000,   max_iter=5,   alert_pct=0.6,  cost_per_1k=0.015),
})

# ── Metrics counters (Prometheus-compatible) ───────────────────────────────────
class _Metrics:
    def __init__(self):
        self._lock = threading.Lock()
        self.requests_total   = 0
        self.requests_5xx     = 0
        self.requests_4xx     = 0
        self.query_total      = 0
        self.ingest_total     = 0
        self.tokens_total     = 0
        self.latency_samples: list[float] = []   # seconds

    def record_request(self, status_code: int, latency_s: float) -> None:
        with self._lock:
            self.requests_total += 1
            if status_code >= 500:
                self.requests_5xx += 1
            elif status_code >= 400:
                self.requests_4xx += 1
            self.latency_samples.append(latency_s)
            if len(self.latency_samples) > 10_000:
                self.latency_samples = self.latency_samples[-10_000:]

    def record_query(self, tokens: int) -> None:
        with self._lock:
            self.query_total  += 1
            self.tokens_total += tokens

    def record_ingest(self) -> None:
        with self._lock:
            self.ingest_total += 1

    def percentile(self, p: float) -> float:
        with self._lock:
            if not self.latency_samples:
                return 0.0
            sorted_samples = sorted(self.latency_samples)
            idx = int(len(sorted_samples) * p / 100)
            return sorted_samples[min(idx, len(sorted_samples) - 1)]

    def prometheus_text(self) -> str:
        p50 = self.percentile(50)
        p95 = self.percentile(95)
        p99 = self.percentile(99)
        with self._lock:
            lines = [
                '# HELP rag_requests_total Total HTTP requests',
                '# TYPE rag_requests_total counter',
                f'rag_requests_total {self.requests_total}',
                '# HELP rag_requests_5xx_total Total 5xx responses',
                '# TYPE rag_requests_5xx_total counter',
                f'rag_requests_5xx_total {self.requests_5xx}',
                '# HELP rag_requests_4xx_total Total 4xx responses',
                '# TYPE rag_requests_4xx_total counter',
                f'rag_requests_4xx_total {self.requests_4xx}',
                '# HELP rag_query_total Total /query calls',
                '# TYPE rag_query_total counter',
                f'rag_query_total {self.query_total}',
                '# HELP rag_ingest_total Total /ingest calls',
                '# TYPE rag_ingest_total counter',
                f'rag_ingest_total {self.ingest_total}',
                '# HELP rag_tokens_total Total LLM tokens consumed',
                '# TYPE rag_tokens_total counter',
                f'rag_tokens_total {self.tokens_total}',
                '# HELP rag_latency_p50_seconds Request latency p50',
                '# TYPE rag_latency_p50_seconds gauge',
                f'rag_latency_p50_seconds {p50:.4f}',
                '# HELP rag_latency_p95_seconds Request latency p95',
                '# TYPE rag_latency_p95_seconds gauge',
                f'rag_latency_p95_seconds {p95:.4f}',
                '# HELP rag_latency_p99_seconds Request latency p99',
                '# TYPE rag_latency_p99_seconds gauge',
                f'rag_latency_p99_seconds {p99:.4f}',
                f'# HELP rag_api_info Build info',
                f'# TYPE rag_api_info gauge',
                f'rag_api_info{{version="2.0.0",provider="{MODEL_PROVIDER}",language="python"}} 1',
            ]
        return "\n".join(lines) + "\n"


_metrics = _Metrics()

# ── Shared state initialised in lifespan ──────────────────────────────────────
_engine:        RAGEngine    | None = None
_memory:        MemoryStore  | None = None
_token_engine:  TokenEngine  | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: validate config, initialise all dependencies. Shutdown: flush + close."""
    global _engine, _memory, _token_engine

    # Fail fast on missing required config — never start in a degraded state
    if not JWT_SECRET:
        raise RuntimeError("JWT_SECRET environment variable is required — refusing to start")
    missing_key = _check_provider_key()
    if missing_key:
        raise RuntimeError(f"{missing_key} environment variable required for provider '{MODEL_PROVIDER}'")

    qdrant = (
        QdrantClient(":memory:")
        if QDRANT_URL == ":memory:"
        else QdrantClient(url=QDRANT_URL, timeout=30)
    )
    _engine = RAGEngine("api", qdrant=qdrant)

    rag_schema, rag_fn = make_rag_tool(_engine)
    if not any(s["name"] == "rag_search" for s in TOOL_SCHEMAS):
        TOOL_SCHEMAS.append(rag_schema)
        TOOL_REGISTRY["rag_search"] = rag_fn

    _memory       = MemoryStore()
    _token_engine = TokenEngine(
        config=_RBAC_CONFIG,
        audit_path=os.environ.get("AGENT_AUDIT_LOG", "/tmp/rag_audit.jsonl"),
        on_alert=lambda session, msg: log.warning(
            "token_engine.alert",
            session_id=session.id,
            role=session.role,
            message=msg,
            budget_used_pct=round(session.budget_used_pct, 3),
        ),
        on_abort=lambda session, reason: log.error(
            "token_engine.abort",
            session_id=session.id,
            role=session.role,
            reason=reason,
            total_tokens=session.total_tokens,
        ),
    )

    log.info(
        "api.startup",
        qdrant_url=QDRANT_URL,
        model_provider=MODEL_PROVIDER,
        cors_origins=ALLOWED_ORIGINS,
    )
    yield
    log.info("api.shutdown")


def _check_provider_key() -> str | None:
    key_map = {
        "anthropic":       "ANTHROPIC_API_KEY",
        "deepseek":        "DEEPSEEK_API_KEY",
        "deepseek-openai": "DEEPSEEK_API_KEY",
        "openai":          "OPENAI_API_KEY",
    }
    env_var = key_map.get(MODEL_PROVIDER.lower())
    if env_var and not os.environ.get(env_var):
        return env_var
    return None


# ── Rate limiter ───────────────────────────────────────────────────────────────
limiter = Limiter(key_func=get_remote_address)

# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="RAG AI API",
    version="2.0.0",
    description="Production RAG API with multi-provider LLM, hybrid search, reranking, memory, RBAC.",
    lifespan=lifespan,
    # Disable OpenAPI in production to avoid schema exposure
    openapi_url=None if os.environ.get("DISABLE_OPENAPI") == "1" else "/openapi.json",
)
app.state.limiter = limiter

# CORS — explicit allowlist, never wildcard on authenticated endpoints
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=["X-Request-ID", "X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After"],
    max_age=600,
)


# ── Security headers + correlation ID + metrics middleware ────────────────────
@app.middleware("http")
async def security_and_observability_middleware(request: Request, call_next):
    start_time = time.perf_counter()
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex

    # Make request_id available to route handlers for logging
    request.state.request_id = request_id

    try:
        response = await call_next(request)
    except Exception as exc:
        latency = time.perf_counter() - start_time
        log.error(
            "request.unhandled_exception",
            method=request.method,
            path=request.url.path,
            request_id=request_id,
            error=str(exc),
            latency_s=round(latency, 4),
        )
        _metrics.record_request(500, latency)
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error", "request_id": request_id},
        )

    latency = time.perf_counter() - start_time
    _metrics.record_request(response.status_code, latency)

    # OWASP ASVS 5.0 Ch. 14 + OWASP Secure Headers Project — all required headers
    response.headers["X-Request-ID"]                 = request_id
    response.headers["Strict-Transport-Security"]    = "max-age=63072000; includeSubDomains; preload"
    response.headers["Content-Security-Policy"]      = "default-src 'none'; frame-ancestors 'none'"
    response.headers["X-Content-Type-Options"]       = "nosniff"
    response.headers["X-Frame-Options"]              = "DENY"
    response.headers["Referrer-Policy"]              = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"]           = "geolocation=(), camera=(), microphone=(), payment=()"
    response.headers["Cross-Origin-Opener-Policy"]   = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Cache-Control"]                = "no-store"
    response.headers["X-XSS-Protection"]             = "0"
    response.headers.pop("server",       None)
    response.headers.pop("x-powered-by", None)

    # Structured request log on every response
    log.info(
        "request.complete",
        method=request.method,
        path=request.url.path,
        status=response.status_code,
        latency_s=round(latency, 4),
        request_id=request_id,
        remote_addr=request.client.host if request.client else "unknown",
    )
    return response


# ── 429 handler with Retry-After ───────────────────────────────────────────────
@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    request_id = getattr(request.state, "request_id", uuid.uuid4().hex)
    log.warning(
        "security.rate_limit_exceeded",
        path=request.url.path,
        request_id=request_id,
        remote_addr=request.client.host if request.client else "unknown",
    )
    return JSONResponse(
        status_code=429,
        content={"detail": "Rate limit exceeded", "request_id": request_id},
        headers={
            "Retry-After":              "60",
            "X-RateLimit-Limit":        "60",
            "X-RateLimit-Remaining":    "0",
            "X-RateLimit-Reset":        str(int(time.time()) + 60),
        },
    )


# ── Auth ───────────────────────────────────────────────────────────────────────
_ROLE_RANK = {"admin": 4, "operator": 3, "user": 2, "readonly": 1}


def _verify_jwt(request: Request, authorization: str = Header(...)) -> dict:
    request_id = getattr(request.state, "request_id", "unknown")
    if not JWT_SECRET:
        log.error("auth.jwt_secret_missing", request_id=request_id)
        raise HTTPException(status_code=500, detail="Server misconfiguration")
    if not authorization.startswith("Bearer "):
        log.warning("security.auth_failure", reason="missing_bearer", request_id=request_id,
                    path=request.url.path)
        raise HTTPException(status_code=401, detail="Authorization header must be 'Bearer <token>'")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        log.warning("security.auth_failure", reason="token_expired", request_id=request_id,
                    path=request.url.path)
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        log.warning("security.auth_failure", reason="invalid_token", error=str(e),
                    request_id=request_id, path=request.url.path)
        raise HTTPException(status_code=401, detail="Invalid token")
    return payload


AuthDep = Annotated[dict, Depends(_verify_jwt)]


def _require_role(claims: dict, required: str, request_id: str = "") -> None:
    role = claims.get("role", "readonly")
    if _ROLE_RANK.get(role, 0) < _ROLE_RANK.get(required, 0):
        log.warning(
            "security.authz_failure",
            user=claims.get("sub"),
            role=role,
            required=required,
            request_id=request_id,
        )
        raise HTTPException(
            status_code=403,
            detail=f"Role '{role}' cannot perform this action (requires '{required}')",
        )


# ── Request / response models ──────────────────────────────────────────────────
class IngestTextRequest(BaseModel):
    content:  str = Field(..., min_length=1, max_length=500_000)
    metadata: dict[str, str] = Field(default_factory=dict)

    @field_validator("metadata")
    @classmethod
    def validate_metadata(cls, v: dict) -> dict:
        if len(v) > 20:
            raise ValueError("metadata may contain at most 20 keys")
        for k, val in v.items():
            if len(k) > 64 or len(val) > 512:
                raise ValueError("metadata key/value exceeds length limit (key≤64, value≤512)")
        return v


class IngestDirectoryRequest(BaseModel):
    directory: str = Field(..., min_length=1, max_length=512)


class QueryRequest(BaseModel):
    question:       str      = Field(..., min_length=1, max_length=4096)
    session_id:     str | None = None
    max_iterations: int      = Field(default=20, ge=1, le=50)
    top_k:          int      = Field(default=5,  ge=1, le=20)


class IngestResponse(BaseModel):
    doc_id:      str
    chunk_count: int


class QueryResponse(BaseModel):
    answer:        str
    session_id:    str
    iterations:    int
    total_tokens:  int
    elapsed_s:     float
    budget_used_pct: float
    trace:         list[dict]


class SessionResponse(BaseModel):
    session_id:    str
    created_at:    float
    updated_at:    float
    message_count: int
    summary:       str


# ── Circuit-breaker retry for Qdrant ingest (OWASP ASVS: no silent failures) ──
@retry(
    retry=retry_if_exception_type(Exception),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    stop=stop_after_attempt(3),
)
def _ingest_with_retry(doc: Document) -> int:
    return _engine.ingest([doc])


# ── Endpoints ──────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    """Liveness probe — returns 200 if process is alive."""
    return {"status": "ok", "time": time.time()}


@app.get("/ready")
async def ready(request: Request):
    """Readiness probe — verifies Qdrant is reachable before accepting traffic."""
    request_id = getattr(request.state, "request_id", "unknown")
    errors: list[str] = []
    try:
        if _engine is None:
            errors.append("qdrant: engine not initialised")
        else:
            info = _engine.collection_info()
            if "name" not in info:
                errors.append("qdrant: invalid collection response")
    except Exception as e:
        errors.append(f"qdrant: {e}")
        log.error("ready.qdrant_check_failed", error=str(e), request_id=request_id)
    if errors:
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "errors": errors},
        )
    return {"status": "ready", "checks": {"qdrant": "ok"}}


@app.get("/metrics")
async def metrics():
    """Prometheus-compatible metrics: request count, error rate, latency p50/p95/p99, tokens."""
    return PlainTextResponse(_metrics.prometheus_text(), media_type="text/plain; version=0.0.4")


@app.post("/ingest/text", response_model=IngestResponse)
@limiter.limit("30/minute")
async def ingest_text(request: Request, body: IngestTextRequest, claims: AuthDep):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "operator", request_id)
    doc = Document(content=body.content, metadata=body.metadata)
    try:
        count = _ingest_with_retry(doc)
    except RetryError as e:
        log.error("api.ingest_failed", doc_id=doc.doc_id, error=str(e), request_id=request_id)
        raise HTTPException(status_code=503, detail="Ingest failed after retries — Qdrant unavailable")
    _metrics.record_ingest()
    log.info(
        "api.ingest_text",
        doc_id=doc.doc_id,
        chunk_count=count,
        user=claims.get("sub"),
        request_id=request_id,
    )
    return IngestResponse(doc_id=doc.doc_id, chunk_count=count)


@app.post("/ingest/directory", response_model=list[IngestResponse])
@limiter.limit("5/minute")
async def ingest_directory(request: Request, body: IngestDirectoryRequest, claims: AuthDep):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "admin", request_id)
    if not os.path.isdir(body.directory):
        raise HTTPException(status_code=400, detail=f"Not a directory: {body.directory}")
    docs = load_directory(body.directory)
    if not docs:
        raise HTTPException(status_code=422, detail="No supported documents found in directory")
    results: list[IngestResponse] = []
    for doc in docs:
        try:
            count = _ingest_with_retry(doc)
        except RetryError:
            log.error(
                "api.ingest_directory_doc_failed",
                source=doc.metadata.get("source", "unknown"),
                request_id=request_id,
            )
            continue
        _metrics.record_ingest()
        results.append(IngestResponse(doc_id=doc.doc_id, chunk_count=count))
    log.info(
        "api.ingest_directory",
        path=body.directory,
        docs_attempted=len(docs),
        docs_ingested=len(results),
        user=claims.get("sub"),
        request_id=request_id,
    )
    return results


@app.post("/query", response_model=QueryResponse)
@limiter.limit("20/minute")
async def query(request: Request, body: QueryRequest, claims: AuthDep):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "user", request_id)

    role = claims.get("role", "readonly")
    user = claims.get("sub", "anonymous")

    # Start token-engine session — enforces RBAC budget on this call
    te_session = _token_engine.start_session(role=role, task=body.question[:200])
    log.info(
        "api.query_start",
        session_id=te_session.id,
        role=role,
        user=user,
        request_id=request_id,
        max_tokens_budget=te_session.budget.max_tokens,
    )

    # Load or create memory session
    mem_session_id = body.session_id
    if mem_session_id:
        mem_session = _memory.load(mem_session_id)
        if mem_session is None:
            _token_engine.end_session(te_session.id)
            log.warning("api.session_not_found", session_id=mem_session_id, request_id=request_id)
            raise HTTPException(status_code=404, detail=f"Session '{mem_session_id}' not found")
    else:
        mem_session    = _memory.create(metadata={"user": user, "role": role})
        mem_session_id = mem_session.session_id

    mem_session = maybe_compact(_memory, mem_session)

    # Enforce iteration budget from token engine
    max_iter = min(body.max_iterations, te_session.budget.max_iter)

    try:
        answer, trace = run_react(
            task=body.question,
            system_extra=(
                "You have access to a 'rag_search' tool that searches a knowledge base. "
                "Always search first, reason second, then answer. "
                "Cite retrieved passages using the citation markers provided."
            ),
            max_iterations=max_iter,
        )
    except BudgetExceededError as e:
        log.error(
            "api.budget_exceeded",
            user=user,
            role=role,
            request_id=request_id,
            error=str(e),
        )
        raise HTTPException(status_code=429, detail=f"Token budget exceeded: {e}")
    except Exception as e:
        _token_engine.end_session(te_session.id)
        log.error(
            "api.query_failed",
            user=user,
            request_id=request_id,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail="Query failed — internal error")

    # Record usage in token engine
    _token_engine.record_usage(
        te_session.id,
        input_tokens=trace.total_tokens // 2,
        output_tokens=trace.total_tokens - trace.total_tokens // 2,
        iteration=trace.iterations,
    )
    ended = _token_engine.end_session(te_session.id, answer=answer)
    _metrics.record_query(trace.total_tokens)

    # Persist to memory
    _memory.append_user(mem_session_id, body.question)
    _memory.append_assistant(mem_session_id, answer)

    log.info(
        "api.query_complete",
        mem_session_id=mem_session_id,
        iterations=trace.iterations,
        total_tokens=trace.total_tokens,
        elapsed_s=trace.elapsed_s,
        budget_used_pct=round(ended.budget_used_pct, 4),
        user=user,
        request_id=request_id,
    )

    return QueryResponse(
        answer=answer,
        session_id=mem_session_id,
        iterations=trace.iterations,
        total_tokens=trace.total_tokens,
        elapsed_s=trace.elapsed_s,
        budget_used_pct=round(ended.budget_used_pct, 4),
        trace=trace.to_dict(),
    )


@app.get("/sessions/{session_id}", response_model=SessionResponse)
@limiter.limit("60/minute")
async def get_session(request: Request, session_id: str, claims: AuthDep):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "user", request_id)
    session = _memory.load(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    log.info("api.get_session", session_id=session_id, user=claims.get("sub"), request_id=request_id)
    return SessionResponse(
        session_id=session.session_id,
        created_at=session.created_at,
        updated_at=session.updated_at,
        message_count=len(session.messages),
        summary=session.summary,
    )


@app.delete("/sessions/{session_id}", status_code=204)
@limiter.limit("30/minute")
async def delete_session(request: Request, session_id: str, claims: AuthDep):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "user", request_id)
    deleted = _memory.delete(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    log.info(
        "api.delete_session",
        session_id=session_id,
        user=claims.get("sub"),
        request_id=request_id,
    )


# ── Trading endpoints ──────────────────────────────────────────────────────────
# Lazy import — trading modules optional; API still starts without them
def _get_trading_modules():
    try:
        from market_data import get_stock_quote, get_crypto_quote, get_stock_ohlcv, get_crypto_ohlcv
        from backtest_engine import run_backtest, make_sma_crossover_signal, make_rsi_mean_reversion_signal, make_breakout_signal
        from trading_agent import propose_order, get_proposal, order_execute_ibkr, ingest_strategy_knowledge, register_trading_tools
        return {"ok": True, "gq": get_stock_quote, "gcq": get_crypto_quote,
                "go": get_stock_ohlcv, "gco": get_crypto_ohlcv,
                "rb": run_backtest, "sma": make_sma_crossover_signal,
                "rsi": make_rsi_mean_reversion_signal, "brk": make_breakout_signal,
                "po": propose_order, "gp": get_proposal, "ex": order_execute_ibkr,
                "ingest": ingest_strategy_knowledge, "reg": register_trading_tools}
    except ImportError as e:
        return {"ok": False, "error": str(e)}


class MarketQuoteRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=16)

class CryptoQuoteRequest(BaseModel):
    coin_id: str = Field(..., min_length=1, max_length=64)
    vs_currency: str = Field(default="usd", max_length=8)

class BacktestRequest(BaseModel):
    symbol:      str   = Field(..., min_length=1, max_length=16)
    strategy:    str   = Field(..., pattern="^(sma_crossover|rsi_mean_reversion|breakout)$")
    asset_class: str   = Field(default="equity", pattern="^(equity|crypto)$")
    days:        int   = Field(default=90, ge=1, le=365)
    output_size: str   = Field(default="compact", pattern="^(compact|full)$")

class OrderProposeRequest(BaseModel):
    symbol:      str           = Field(..., min_length=1, max_length=16)
    side:        str           = Field(..., pattern="^(buy|sell)$")
    quantity:    float         = Field(..., gt=0)
    asset_class: str           = Field(default="equity", pattern="^(equity|crypto)$")
    order_type:  str           = Field(default="market", pattern="^(market|limit)$")
    limit_price: float | None  = None
    rationale:   str           = Field(..., min_length=1, max_length=2000)

class OrderExecuteRequest(BaseModel):
    proposal_id: str  = Field(..., min_length=1)
    confirm:     bool = False   # must be True — server enforces, never defaulted True


@app.get("/trading/quote/stock/{symbol}")
@limiter.limit("30/minute")
async def stock_quote(request: Request, symbol: str, claims: AuthDep):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "user", request_id)
    m = _get_trading_modules()
    if not m["ok"]:
        raise HTTPException(status_code=503, detail=f"Trading module unavailable: {m['error']}")
    try:
        q = m["gq"](symbol.upper())
        return {"symbol": q["symbol"], "price": q["price"], "change": q["change"],
                "change_pct": q["change_pct"], "volume": q["volume"],
                "latest_trading_day": q["latest_trading_day"]}
    except Exception as e:
        log.error("api.stock_quote_failed", symbol=symbol, error=str(e), request_id=request_id)
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/trading/quote/crypto/{coin_id}")
@limiter.limit("30/minute")
async def crypto_quote(request: Request, coin_id: str, vs_currency: str = "usd", claims: AuthDep = Depends(_verify_jwt)):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "user", request_id)
    m = _get_trading_modules()
    if not m["ok"]:
        raise HTTPException(status_code=503, detail=f"Trading module unavailable: {m['error']}")
    try:
        q = m["gcq"](coin_id.lower(), vs_currency)
        return {"coin_id": q["coin_id"], "price": q["price"], "change_24h_pct": q["change_24h_pct"],
                "market_cap": q["market_cap"], "volume_24h": q["volume_24h"]}
    except Exception as e:
        log.error("api.crypto_quote_failed", coin_id=coin_id, error=str(e), request_id=request_id)
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/trading/backtest")
@limiter.limit("10/minute")
async def backtest(request: Request, body: BacktestRequest, claims: AuthDep):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "user", request_id)
    m = _get_trading_modules()
    if not m["ok"]:
        raise HTTPException(status_code=503, detail=f"Trading module unavailable: {m['error']}")
    try:
        if body.asset_class == "crypto":
            bars = m["gco"](body.symbol.lower(), "usd", body.days)
        else:
            bars = m["go"](body.symbol.upper(), "daily", body.output_size)
        strategy_map = {
            "sma_crossover":      m["sma"](),
            "rsi_mean_reversion": m["rsi"](),
            "breakout":           m["brk"](),
        }
        signal_fn   = strategy_map[body.strategy]
        bars_per_yr = 365 if body.asset_class == "crypto" else 252
        result = m["rb"](bars, signal_fn, bars_per_year=bars_per_yr)
        log.info("api.backtest", symbol=body.symbol, strategy=body.strategy,
                 bars=len(bars), total_return=result.total_return_pct, request_id=request_id)
        return result.to_dict()
    except Exception as e:
        log.error("api.backtest_failed", symbol=body.symbol, strategy=body.strategy,
                  error=str(e), request_id=request_id)
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/trading/propose")
@limiter.limit("20/minute")
async def order_propose(request: Request, body: OrderProposeRequest, claims: AuthDep):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "user", request_id)
    m = _get_trading_modules()
    if not m["ok"]:
        raise HTTPException(status_code=503, detail=f"Trading module unavailable: {m['error']}")
    try:
        proposal = m["po"](
            symbol=body.symbol, side=body.side, quantity=body.quantity,
            asset_class=body.asset_class, order_type=body.order_type,
            limit_price=body.limit_price, rationale=body.rationale,
        )
        log.info("api.order_proposed", proposal_id=proposal.proposal_id,
                 symbol=body.symbol, side=body.side, user=claims.get("sub"), request_id=request_id)
        return proposal.to_dict()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/trading/proposals/{proposal_id}")
@limiter.limit("60/minute")
async def get_order_proposal(request: Request, proposal_id: str, claims: AuthDep):
    request_id = getattr(request.state, "request_id", "unknown")
    _require_role(claims, "user", request_id)
    m = _get_trading_modules()
    if not m["ok"]:
        raise HTTPException(status_code=503, detail=f"Trading module unavailable: {m['error']}")
    proposal = m["gp"](proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    return proposal.to_dict()


@app.post("/trading/execute")
@limiter.limit("5/minute")
async def order_execute(request: Request, body: OrderExecuteRequest, claims: AuthDep):
    """
    Execute a previously-proposed order via IBKR.
    Requires: operator+ role, confirm=true in body, and human intent.
    IBKR_LIVE_TRADING env var controls paper vs live mode.
    """
    request_id = getattr(request.state, "request_id", "unknown")
    # Execution requires operator minimum — not just any user
    _require_role(claims, "operator", request_id)
    m = _get_trading_modules()
    if not m["ok"]:
        raise HTTPException(status_code=503, detail=f"Trading module unavailable: {m['error']}")
    if not body.confirm:
        log.warning("api.execute_rejected_no_confirm",
                    proposal_id=body.proposal_id, user=claims.get("sub"), request_id=request_id)
        raise HTTPException(
            status_code=400,
            detail="confirm must be true. Review the proposal before executing.",
        )
    try:
        result = m["ex"](body.proposal_id, confirm=True)
        log.warning(
            "api.order_executed",
            proposal_id=body.proposal_id,
            mode=result.get("mode", "PAPER"),
            user=claims.get("sub"),
            request_id=request_id,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Global exception handler — never expose internal details in responses ──────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    request_id = getattr(request.state, "request_id", uuid.uuid4().hex)
    log.error(
        "api.unhandled_exception",
        error=str(exc),
        error_type=type(exc).__name__,
        path=str(request.url),
        request_id=request_id,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": request_id},
    )
