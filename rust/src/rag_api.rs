// RAG REST API — Rust
// Axum service with JWT HS256 auth (algorithms pinned), rate limiting, RBAC.
// Endpoints: GET /health, POST /ingest/text, POST /query,
//            GET /sessions/{id}, DELETE /sessions/{id}
//
// Add to Cargo.toml: axum="0.8", tower="0.5", tower-http="0.6", jsonwebtoken="9.3"
// export JWT_SECRET=... PORT=8003

use std::collections::HashMap;
use std::env;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
    routing::{delete, get, post},
};
use jsonwebtoken::{DecodingKey, Validation, Algorithm, decode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{RAGEngine, MemoryStore, Document, ToolRegistry, ReactOptions, run_react,
           TokenEngine, TokenEngineOptions, RBACConfig, Role, BudgetExceededError};
use crate::market_data::{get_stock_quote, get_crypto_quote, get_stock_ohlcv, get_crypto_ohlcv, OHLCVBar};
use crate::backtest_engine::{run_backtest, make_sma_crossover_signal, make_rsi_mean_reversion_signal, make_breakout_signal, BacktestOptions};
use crate::trading_agent::{propose_order, get_proposal, order_execute_ibkr};

// ── Auth types ─────────────────────────────────────────────────────────────────
#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub:  String,
    role: Option<String>,
    exp:  usize,
}

fn role_rank(role: &str) -> u8 {
    match role { "admin" => 4, "operator" => 3, "user" => 2, _ => 1 }
}

fn verify_jwt(headers: &HeaderMap, secret: &[u8]) -> Result<Claims, StatusCode> {
    let auth = headers.get("Authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !auth.starts_with("Bearer ") { return Err(StatusCode::UNAUTHORIZED); }
    let token = auth.trim_start_matches("Bearer ").trim();
    let mut val = Validation::new(Algorithm::HS256);
    val.set_algorithms(vec![Algorithm::HS256]);
    decode::<Claims>(token, &DecodingKey::from_secret(secret), &val)
        .map(|t| t.claims)
        .map_err(|_| StatusCode::UNAUTHORIZED)
}

fn require_role(claims: &Claims, required: &str) -> Result<(), StatusCode> {
    let role = claims.role.as_deref().unwrap_or("readonly");
    if role_rank(role) < role_rank(required) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(())
}

// ── Rate limiter ───────────────────────────────────────────────────────────────
#[derive(Clone)]
struct RateLimiter {
    state:  Arc<Mutex<HashMap<String, (u32, Instant)>>>,
    limit:  u32,
    window: Duration,
}

impl RateLimiter {
    fn new(limit: u32, window: Duration) -> Self {
        Self { state: Arc::new(Mutex::new(HashMap::new())), limit, window }
    }

    fn allow(&self, key: &str) -> bool {
        let mut map = self.state.lock().unwrap();
        let now = Instant::now();
        let entry = map.entry(key.to_string()).or_insert((0, now));
        if now.duration_since(entry.1) >= self.window {
            *entry = (1, now);
            return true;
        }
        if entry.0 >= self.limit {
            return false;
        }
        entry.0 += 1;
        true
    }

    fn retry_after_secs(&self) -> u64 {
        self.window.as_secs()
    }
}

// ── App state ──────────────────────────────────────────────────────────────────
#[derive(Clone)]
struct AppState {
    engine:          Arc<RAGEngine>,
    memory:          Arc<MemoryStore>,
    token_engine:    Arc<TokenEngine>,
    jwt_secret:      Vec<u8>,
    general_limiter: RateLimiter,
    ingest_limiter:  RateLimiter,
    query_limiter:   RateLimiter,
}

// ── Request/response types ─────────────────────────────────────────────────────
#[derive(Deserialize)]
struct IngestTextBody { content: String, metadata: Option<HashMap<String, String>> }

#[derive(Deserialize)]
struct QueryBody {
    question:       String,
    session_id:     Option<String>,
    max_iterations: Option<usize>,
}

fn client_ip(headers: &HeaderMap) -> String {
    headers.get("X-Forwarded-For")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .unwrap_or("unknown")
        .to_string()
}

// ── Handlers ───────────────────────────────────────────────────────────────────
async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "time": std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }))
}

async fn ready_handler(State(state): State<AppState>) -> Result<Json<Value>, StatusCode> {
    // Probe Qdrant by attempting collection info
    state.engine.retrieve("ping", 1).await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(Json(json!({ "status": "ready" })))
}

// ── Global atomic metrics counters ────────────────────────────────────────────
use std::sync::atomic::{AtomicU64, Ordering};

static METRIC_REQUESTS:  AtomicU64 = AtomicU64::new(0);
static METRIC_5XX:       AtomicU64 = AtomicU64::new(0);
static METRIC_4XX:       AtomicU64 = AtomicU64::new(0);
static METRIC_QUERIES:   AtomicU64 = AtomicU64::new(0);
static METRIC_INGESTS:   AtomicU64 = AtomicU64::new(0);
static METRIC_TOKENS:    AtomicU64 = AtomicU64::new(0);

async fn metrics_handler() -> impl axum::response::IntoResponse {
    let provider = std::env::var("MODEL_PROVIDER").unwrap_or_else(|_| "anthropic".to_string());
    let body = format!(
        "# HELP rag_requests_total Total HTTP requests\n\
         # TYPE rag_requests_total counter\n\
         rag_requests_total {}\n\
         # HELP rag_requests_5xx_total Total 5xx responses\n\
         # TYPE rag_requests_5xx_total counter\n\
         rag_requests_5xx_total {}\n\
         # HELP rag_requests_4xx_total Total 4xx responses\n\
         # TYPE rag_requests_4xx_total counter\n\
         rag_requests_4xx_total {}\n\
         # HELP rag_query_total Total /query calls\n\
         # TYPE rag_query_total counter\n\
         rag_query_total {}\n\
         # HELP rag_ingest_total Total /ingest calls\n\
         # TYPE rag_ingest_total counter\n\
         rag_ingest_total {}\n\
         # HELP rag_tokens_total Total LLM tokens consumed\n\
         # TYPE rag_tokens_total counter\n\
         rag_tokens_total {}\n\
         # HELP rag_api_info Build info\n\
         # TYPE rag_api_info gauge\n\
         rag_api_info{{version=\"2.0.0\",language=\"rust\",provider=\"{}\"}} 1\n",
        METRIC_REQUESTS.load(Ordering::Relaxed),
        METRIC_5XX.load(Ordering::Relaxed),
        METRIC_4XX.load(Ordering::Relaxed),
        METRIC_QUERIES.load(Ordering::Relaxed),
        METRIC_INGESTS.load(Ordering::Relaxed),
        METRIC_TOKENS.load(Ordering::Relaxed),
        provider,
    );
    ([(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4")], body)
}

// ── Security headers middleware (OWASP ASVS 5.0 + Secure Headers) ─────────────
async fn security_headers_middleware(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> impl axum::response::IntoResponse {
    use axum::http::HeaderValue;
    let request_id = req.headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let mut b = [0u8; 16];
            let _ = (|| -> Result<(), ()> {
                use std::time::{SystemTime, UNIX_EPOCH};
                let n = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| ())?.subsec_nanos();
                let bytes = n.to_le_bytes();
                b[..4].copy_from_slice(&bytes);
                Ok(())
            })();
            hex::encode(b)
        });
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    let set = |h: &mut axum::http::HeaderMap, k: &'static str, v: &'static str| {
        if let (Ok(name), Ok(val)) = (axum::http::HeaderName::from_static(k), HeaderValue::from_static(v)) {
            h.insert(name, val);
        }
    };
    h.insert("x-request-id", HeaderValue::from_str(&request_id).unwrap_or(HeaderValue::from_static("unknown")));
    set(h, "strict-transport-security",    "max-age=63072000; includeSubDomains; preload");
    set(h, "content-security-policy",      "default-src 'none'; frame-ancestors 'none'");
    set(h, "x-content-type-options",       "nosniff");
    set(h, "x-frame-options",              "DENY");
    set(h, "referrer-policy",              "strict-origin-when-cross-origin");
    set(h, "permissions-policy",           "geolocation=(), camera=(), microphone=(), payment=()");
    set(h, "cross-origin-opener-policy",   "same-origin");
    set(h, "cross-origin-embedder-policy", "require-corp");
    set(h, "cross-origin-resource-policy", "same-origin");
    set(h, "cache-control",                "no-store");
    set(h, "x-xss-protection",             "0");
    h.remove("server");
    // Add Retry-After on rate limit responses
    if resp.status() == axum::http::StatusCode::TOO_MANY_REQUESTS {
        if let Ok(v) = HeaderValue::from_static("60") {
            h.insert(axum::http::HeaderName::from_static("retry-after"), v);
        }
    }
    resp
}

async fn ingest_text(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<IngestTextBody>,
) -> Result<Json<Value>, StatusCode> {
    if !state.ingest_limiter.allow(&client_ip(&headers)) { return Err(StatusCode::TOO_MANY_REQUESTS); }
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    require_role(&claims, "operator")?;
    if body.content.is_empty() || body.content.len() > 500_000 { return Err(StatusCode::BAD_REQUEST); }

    let meta = body.metadata.unwrap_or_default();
    let doc  = Document { content: body.content, metadata: meta, doc_id: None };

    // Retry with exponential backoff — circuit-breaker pattern for Qdrant
    let mut last_err = String::new();
    let mut count    = 0usize;
    for attempt in 1usize..=3 {
        match state.engine.ingest(vec![doc.clone()]).await {
            Ok(n) => { count = n; last_err = String::new(); break; }
            Err(e) => {
                last_err = e.to_string();
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_secs(2u64.pow(attempt as u32))).await;
                }
            }
        }
    }
    if !last_err.is_empty() {
        eprintln!("[api.ingest_failed] doc_id={:?} error={}", doc.doc_id, last_err);
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    eprintln!("[api.ingest_text] doc_id={:?} chunks={} user={}", doc.doc_id, count, claims.sub);
    METRIC_REQUESTS.fetch_add(1, Ordering::Relaxed);
    METRIC_INGESTS.fetch_add(1, Ordering::Relaxed);
    Ok(Json(json!({ "doc_id": doc.doc_id, "chunk_count": count })))
}

async fn query(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<QueryBody>,
) -> Result<Json<Value>, StatusCode> {
    if !state.query_limiter.allow(&client_ip(&headers)) { return Err(StatusCode::TOO_MANY_REQUESTS); }
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    require_role(&claims, "user")?;
    if body.question.is_empty() { return Err(StatusCode::BAD_REQUEST); }

    let role = claims.role.clone().unwrap_or_else(|| "readonly".to_string());
    let user = claims.sub.clone();

    // Start RBAC token budget session
    let te_session = state.token_engine.start_session(&role, &body.question[..body.question.len().min(200)])
        .map_err(|e| {
            eprintln!("[api.query_start_failed] role={} error={}", role, e);
            StatusCode::FORBIDDEN
        })?;
    eprintln!("[api.query_start] session_id={} role={} user={} max_tokens={}",
        te_session.id, role, user, te_session.budget.max_tokens);

    // Load or create memory session
    let session_id = if let Some(sid) = &body.session_id {
        if state.memory.load(sid).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.is_none() {
            let _ = state.token_engine.end_session(&te_session.id, "");
            return Err(StatusCode::NOT_FOUND);
        }
        sid.clone()
    } else {
        state.memory.create(Default::default())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .session_id
    };

    let max_iter = body.max_iterations.unwrap_or(20).min(50).min(te_session.budget.max_iter);

    let engine = Arc::clone(&state.engine);
    let mut registry = ToolRegistry::new();
    registry.register(
        "rag_search",
        "Search the knowledge base for context relevant to a query.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "top_k": { "type": "integer" }
            },
            "required": ["query"]
        }),
        std::sync::Arc::new(move |input: serde_json::Value| {
            let engine = Arc::clone(&engine);
            let query  = input["query"].as_str().unwrap_or("").to_string();
            let top_k  = input["top_k"].as_u64().unwrap_or(5);
            let rt     = tokio::runtime::Handle::current();
            std::thread::spawn(move || {
                rt.block_on(async move { engine.retrieve_as_context(&query, top_k).await })
            }).join().map_err(|e| anyhow::anyhow!("{:?}", e))?
        }),
    );

    let react_result = run_react(&body.question, &registry, ReactOptions {
        system_extra:   "You have access to rag_search. Always search first, reason second, then answer. Cite retrieved passages.".to_string(),
        max_iterations: max_iter,
        on_step:        None,
    }).await;

    match react_result {
        Err(e) => {
            let _ = state.token_engine.end_session(&te_session.id, "");
            let msg = e.to_string();
            // Check if this is a BudgetExceededError
            if msg.contains("budget") || msg.contains("limit") {
                eprintln!("[api.budget_exceeded] user={} role={} error={}", user, role, msg);
                return Err(StatusCode::TOO_MANY_REQUESTS);
            }
            eprintln!("[api.query_failed] user={} error={}", user, msg);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        Ok((answer, trace)) => {
            // Record usage and close token budget session
            let _ = state.token_engine.record_usage(
                &te_session.id,
                (trace.total_tokens / 2) as u64,
                (trace.total_tokens - trace.total_tokens / 2) as u64,
                trace.iterations,
            );
            let budget_used_pct = state.token_engine.end_session(&te_session.id, &answer)
                .map(|s| s.budget_used_pct())
                .unwrap_or(0.0);

            state.memory.append_user(&session_id, &body.question)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            state.memory.append_assistant(&session_id, &answer)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

            eprintln!("[api.query_complete] session_id={} iterations={} total_tokens={} elapsed_ms={} budget_used_pct={:.4} user={}",
                session_id, trace.iterations, trace.total_tokens, trace.elapsed_ms, budget_used_pct, user);
            METRIC_REQUESTS.fetch_add(1, Ordering::Relaxed);
            METRIC_QUERIES.fetch_add(1, Ordering::Relaxed);
            METRIC_TOKENS.fetch_add(trace.total_tokens as u64, Ordering::Relaxed);

            Ok(Json(json!({
                "answer":          answer,
                "session_id":      session_id,
                "iterations":      trace.iterations,
                "total_tokens":    trace.total_tokens,
                "elapsed_ms":      trace.elapsed_ms,
                "budget_used_pct": budget_used_pct,
            })))
        }
    }
}

async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    if !state.general_limiter.allow(&client_ip(&headers)) { return Err(StatusCode::TOO_MANY_REQUESTS); }
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    require_role(&claims, "user")?;
    let session = state.memory.load(&session_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(json!({
        "session_id": session.session_id,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "message_count": session.messages.len(),
        "summary": session.summary,
    })))
}

async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    if !state.general_limiter.allow(&client_ip(&headers)) { return Err(StatusCode::TOO_MANY_REQUESTS); }
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    require_role(&claims, "user")?;
    let deleted = state.memory.delete(&session_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !deleted { return Err(StatusCode::NOT_FOUND); }
    Ok(StatusCode::NO_CONTENT)
}

// ── Start server ───────────────────────────────────────────────────────────────
// ── Trading handlers ───────────────────────────────────────────────────────────
#[derive(serde::Deserialize)]
struct BacktestBody {
    symbol:      String,
    strategy:    String,
    #[serde(default = "default_equity")] asset_class: String,
    #[serde(default = "default_days")]   days: u32,
    #[serde(default = "default_compact")] output_size: String,
}
fn default_equity()  -> String { "equity".to_string() }
fn default_days()    -> u32    { 90 }
fn default_compact() -> String { "compact".to_string() }

#[derive(serde::Deserialize)]
struct ProposeBody {
    symbol: String, side: String, quantity: f64,
    #[serde(default = "default_equity")] asset_class: String,
    #[serde(default = "default_market")] order_type: String,
    limit_price: Option<f64>,
    rationale: String,
}
fn default_market() -> String { "market".to_string() }

#[derive(serde::Deserialize)]
struct ExecuteBody { proposal_id: String, confirm: bool }

#[derive(serde::Deserialize)]
struct VsCurrencyQuery { #[serde(default = "default_usd")] vs_currency: String }
fn default_usd() -> String { "usd".to_string() }

async fn trading_stock_quote(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(symbol): axum::extract::Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    require_role(&claims, "user")?;
    let rt = tokio::runtime::Handle::current();
    let symbol = symbol.to_uppercase();
    let q = std::thread::spawn(move || rt.block_on(async move { get_stock_quote(&symbol).await }))
        .join().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(json!({ "symbol": q.symbol, "price": q.price, "change": q.change,
        "change_pct": q.change_pct, "volume": q.volume, "latest_trading_day": q.latest_trading_day })))
}

async fn trading_crypto_quote(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(coin_id): axum::extract::Path<String>,
    axum::extract::Query(qs): axum::extract::Query<VsCurrencyQuery>,
) -> Result<Json<Value>, StatusCode> {
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    require_role(&claims, "user")?;
    let rt = tokio::runtime::Handle::current();
    let coin_id = coin_id.to_lowercase();
    let vs = qs.vs_currency.clone();
    let q = std::thread::spawn(move || rt.block_on(async move { get_crypto_quote(&coin_id, &vs).await }))
        .join().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(json!({ "coin_id": q.coin_id, "price": q.price, "change_24h_pct": q.change_24h_pct,
        "market_cap": q.market_cap, "volume_24h": q.volume_24h })))
}

async fn trading_backtest(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BacktestBody>,
) -> Result<Json<Value>, StatusCode> {
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    require_role(&claims, "user")?;
    let rt = tokio::runtime::Handle::current();
    let symbol = body.symbol.clone();
    let strategy = body.strategy.clone();
    let asset_class = body.asset_class.clone();
    let days = body.days;
    let output_size = body.output_size.clone();

    let result = std::thread::spawn(move || rt.block_on(async move {
        let (bars, bpy): (Vec<OHLCVBar>, u32) = if asset_class == "crypto" {
            match get_crypto_ohlcv(&symbol, "usd", days).await {
                Ok(cb) => (cb.iter().map(|b| OHLCVBar { date: b.timestamp.to_string(),
                    open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 }).collect(), 365),
                Err(e) => return Err(e),
            }
        } else {
            match get_stock_ohlcv(&symbol, "daily", &output_size).await {
                Ok(b) => (b, 252),
                Err(e) => return Err(e),
            }
        };
        let signal_fn = match strategy.as_str() {
            "sma_crossover"      => make_sma_crossover_signal(0, 0),
            "rsi_mean_reversion" => make_rsi_mean_reversion_signal(0, 0.0, 0.0),
            "breakout"           => make_breakout_signal(0),
            other => return Err(anyhow::anyhow!("Unknown strategy: {}", other)),
        };
        let opts = BacktestOptions { bars_per_year: bpy, ..Default::default() };
        run_backtest(&bars, signal_fn, opts).map_err(|e| e)
    })).join().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
       .map_err(|_| StatusCode::BAD_GATEWAY)?;

    Ok(Json(serde_json::to_value(&result).unwrap_or_default()))
}

async fn trading_propose(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ProposeBody>,
) -> Result<Json<Value>, StatusCode> {
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    require_role(&claims, "user")?;
    match propose_order(&body.symbol, &body.side, body.quantity, &body.asset_class,
                        &body.order_type, body.limit_price, &body.rationale) {
        Ok(p)  => Ok(Json(serde_json::to_value(&p).unwrap_or_default())),
        Err(_) => Err(StatusCode::BAD_REQUEST),
    }
}

async fn trading_get_proposal(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    require_role(&claims, "user")?;
    match get_proposal(&id) {
        Some(p) => Ok(Json(serde_json::to_value(&p).unwrap_or_default())),
        None    => Err(StatusCode::NOT_FOUND),
    }
}

async fn trading_execute(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ExecuteBody>,
) -> Result<Json<Value>, StatusCode> {
    let claims = verify_jwt(&headers, &state.jwt_secret)?;
    // Execution requires operator minimum
    require_role(&claims, "operator")?;
    if !body.confirm {
        eprintln!("[api.execute_rejected_no_confirm] proposal={}", body.proposal_id);
        return Err(StatusCode::BAD_REQUEST);
    }
    match order_execute_ibkr(&body.proposal_id, true) {
        Ok(r)  => Ok(Json(serde_json::to_value(&r).unwrap_or_default())),
        Err(_) => Err(StatusCode::BAD_REQUEST),
    }
}

pub async fn start_api_server() -> Result<()> {
    let jwt_secret = env::var("JWT_SECRET")
        .expect("JWT_SECRET environment variable is required")
        .into_bytes();
    let port = env::var("PORT").unwrap_or_else(|_| "8003".to_string());
    let addr: SocketAddr = format!("0.0.0.0:{}", port).parse()?;

    let engine = Arc::new(RAGEngine::new("api_rust").await?);
    let session_dir = env::var("RAG_SESSION_DIR").unwrap_or_else(|_| ".rag_sessions_rust".to_string());
    let memory = Arc::new(MemoryStore::new(&session_dir)?);
    let token_engine = TokenEngine::new(
        RBACConfig {
            roles: [
                ("admin".to_string(),    Role { max_tokens: 200_000, max_iter: 50, alert_pct: 0.80, cost_per_1k: 0.015 }),
                ("operator".to_string(), Role { max_tokens:  80_000, max_iter: 30, alert_pct: 0.75, cost_per_1k: 0.015 }),
                ("user".to_string(),     Role { max_tokens:  20_000, max_iter: 20, alert_pct: 0.70, cost_per_1k: 0.015 }),
                ("readonly".to_string(), Role { max_tokens:   4_000, max_iter:  5, alert_pct: 0.60, cost_per_1k: 0.015 }),
            ].into_iter().collect(),
        },
        TokenEngineOptions {
            audit_path: env::var("AGENT_AUDIT_LOG").unwrap_or_else(|_| "/tmp/rag_audit_rust.jsonl".to_string()),
            on_alert: Some(Box::new(|session, msg| {
                eprintln!("[token_engine.alert] session={} role={} msg={} budget_pct={:.3}",
                    session.id, session.role, msg, session.budget_used_pct());
            })),
            on_abort: Some(Box::new(|session, reason| {
                eprintln!("[token_engine.abort] session={} role={} reason={} tokens={}",
                    session.id, session.role, reason, session.total_tokens());
            })),
        },
    );

    let state = AppState {
        engine,
        memory,
        token_engine,
        jwt_secret,
        general_limiter: RateLimiter::new(60, Duration::from_secs(60)),
        ingest_limiter:  RateLimiter::new(30, Duration::from_secs(60)),
        query_limiter:   RateLimiter::new(20, Duration::from_secs(60)),
    };

    let app = Router::new()
        .route("/health",                     get(health))
        .route("/ready",                      get(ready_handler))
        .route("/metrics",                    get(metrics_handler))
        .route("/ingest/text",                post(ingest_text))
        .route("/query",                      post(query))
        .route("/sessions/{id}",              get(get_session))
        .route("/sessions/{id}",              delete(delete_session))
        // Trading endpoints — wired to trading_agent module
        .route("/trading/quote/stock/{symbol}", get(trading_stock_quote))
        .route("/trading/quote/crypto/{coin_id}", get(trading_crypto_quote))
        .route("/trading/backtest",           post(trading_backtest))
        .route("/trading/propose",            post(trading_propose))
        .route("/trading/proposals/{id}",     get(trading_get_proposal))
        .route("/trading/execute",            post(trading_execute))
        .layer(axum::middleware::from_fn(security_headers_middleware))
        .with_state(state);

    eprintln!("[rag-api-rust] Listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("failed to install SIGTERM handler")
                .recv()
                .await;
            eprintln!("[rag-api-rust] SIGTERM received — shutting down gracefully");
        })
        .await?;
    Ok(())
}
