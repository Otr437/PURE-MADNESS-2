use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::RwLock;
use tower_http::trace::TraceLayer;
use tracing::{error, info, warn};

mod attacks;
mod config;
mod geo;
mod metrics;
mod rate_limit;
mod rules;
mod storage;

use attacks::*;
use config::WafConfig;
use metrics::*;
use rate_limit::*;
use rules::*;
use storage::*;

// ==================== CORE TYPES ====================

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<WafConfig>,
    pub rate_limiter: Arc<RateLimiter>,
    pub blocked_ips: Arc<RwLock<HashMap<String, BlockInfo>>>,
    pub whitelist: Arc<RwLock<HashMap<String, String>>>,
    pub metrics: Arc<WafMetrics>,
    pub rule_engine: Arc<RuleEngine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockInfo {
    pub reason: String,
    pub blocked_at: u64,
    pub unblock_at: u64,
    pub block_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttackLog {
    pub timestamp: u64,
    pub ip_address: String,
    pub attack_type: AttackType,
    pub severity: Severity,
    pub method: String,
    pub path: String,
    pub user_agent: String,
    pub payload: String,
    pub blocked: bool,
    pub details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttackType {
    SqlInjection,
    Xss,
    PathTraversal,
    CommandInjection,
    Xxe,
    Ssrf,
    RateLimitExceeded,
    BruteForce,
    InvalidInput,
    MaliciousBot,
    SuspiciousHeaders,
    LargePayload,
    MaliciousFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Info,
}

// ==================== MAIN ====================

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter("waf_microservice=debug,tower_http=debug")
        .json()
        .init();

    info!("Starting WAF Microservice v1.0.0");

    // Load configuration
    let config = Arc::new(WafConfig::load()?);
    info!("Configuration loaded");

    // Initialize database
    let db = SqlitePool::connect(&config.database_url).await?;
    storage::init_database(&db).await?;
    info!("Database initialized");

    // Initialize components
    let rate_limiter = Arc::new(RateLimiter::new(config.clone()));
    let blocked_ips = Arc::new(RwLock::new(HashMap::new()));
    let whitelist = Arc::new(RwLock::new(load_whitelist(&db).await?));
    let metrics = Arc::new(WafMetrics::new());
    let rule_engine = Arc::new(RuleEngine::new(config.clone()));

    let state = AppState {
        db,
        config: config.clone(),
        rate_limiter,
        blocked_ips,
        whitelist,
        metrics,
        rule_engine,
    };

    // Build router
    let app = Router::new()
        // Admin endpoints
        .route("/waf/health", get(health_check))
        .route("/waf/metrics", get(get_metrics))
        .route("/waf/stats", get(get_stats))
        .route("/waf/blocked-ips", get(list_blocked_ips))
        .route("/waf/whitelist", get(list_whitelist).post(add_to_whitelist))
        .route("/waf/rules", get(list_rules).post(update_rules))
        .route("/waf/attack-logs", get(get_attack_logs))
        .route("/waf/clear-blocks", post(clear_blocks))
        // Proxy all other traffic through WAF
        .fallback(proxy_handler)
        // Add WAF middleware
        .layer(middleware::from_fn_with_state(
            state.clone(),
            waf_middleware,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    info!("WAF listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

// ==================== WAF MIDDLEWARE ====================

async fn waf_middleware(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let start_time = SystemTime::now();
    let ip = addr.ip().to_string();
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers = request.headers().clone();

    // Skip WAF for admin endpoints
    if uri.path().starts_with("/waf/") {
        return Ok(next.run(request).await);
    }

    // Check whitelist
    {
        let whitelist = state.whitelist.read().await;
        if whitelist.contains_key(&ip) {
            state.metrics.requests_allowed.inc();
            return Ok(next.run(request).await);
        }
    }

    // Check if IP is blocked
    {
        let blocked_ips = state.blocked_ips.read().await;
        if let Some(block_info) = blocked_ips.get(&ip) {
            let now = current_timestamp();
            if now < block_info.unblock_at {
                state.metrics.requests_blocked.inc();
                warn!("Blocked request from {}: {}", ip, block_info.reason);
                
                log_attack(
                    &state.db,
                    AttackLog {
                        timestamp: now,
                        ip_address: ip.clone(),
                        attack_type: AttackType::RateLimitExceeded,
                        severity: Severity::High,
                        method: method.to_string(),
                        path: uri.path().to_string(),
                        user_agent: get_user_agent(&headers),
                        payload: String::new(),
                        blocked: true,
                        details: format!("IP blocked: {}", block_info.reason),
                    },
                )
                .await;

                return Err(StatusCode::FORBIDDEN);
            }
        }
    }

    // Rate limiting
    if !state.rate_limiter.check_rate_limit(&ip).await {
        state.metrics.requests_blocked.inc();
        state.metrics.rate_limits_triggered.inc();
        warn!("Rate limit exceeded for {}", ip);

        // Block IP temporarily
        block_ip(
            &state,
            ip.clone(),
            "Rate limit exceeded",
            state.config.rate_limit_ban_duration,
        )
        .await;

        log_attack(
            &state.db,
            AttackLog {
                timestamp: current_timestamp(),
                ip_address: ip,
                attack_type: AttackType::RateLimitExceeded,
                severity: Severity::High,
                method: method.to_string(),
                path: uri.path().to_string(),
                user_agent: get_user_agent(&headers),
                payload: String::new(),
                blocked: true,
                details: "Rate limit exceeded".to_string(),
            },
        )
        .await;

        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    // Extract body for inspection
    let (parts, body) = request.into_parts();
    let bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(b) => b,
        Err(_) => {
            state.metrics.requests_blocked.inc();
            return Err(StatusCode::BAD_REQUEST);
        }
    };

    let body_str = String::from_utf8_lossy(&bytes).to_string();

    // Check request size limits
    if bytes.len() > state.config.max_request_size {
        state.metrics.requests_blocked.inc();
        warn!("Request too large from {}: {} bytes", ip, bytes.len());

        log_attack(
            &state.db,
            AttackLog {
                timestamp: current_timestamp(),
                ip_address: ip,
                attack_type: AttackType::LargePayload,
                severity: Severity::Medium,
                method: method.to_string(),
                path: uri.path().to_string(),
                user_agent: get_user_agent(&headers),
                payload: format!("Size: {} bytes", bytes.len()),
                blocked: true,
                details: "Request exceeds size limit".to_string(),
            },
        )
        .await;

        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }

    // Check URL length
    if uri.to_string().len() > state.config.max_url_length {
        state.metrics.requests_blocked.inc();
        return Err(StatusCode::URI_TOO_LONG);
    }

    // SQL Injection detection
    if let Some(attack) = detect_sql_injection(&uri.query().unwrap_or(""), &body_str) {
        state.metrics.requests_blocked.inc();
        state.metrics.sql_injection_blocked.inc();
        warn!("SQL injection detected from {}", ip);

        block_ip(
            &state,
            ip.clone(),
            "SQL injection attempt",
            state.config.attack_ban_duration,
        )
        .await;

        log_attack(
            &state.db,
            AttackLog {
                timestamp: current_timestamp(),
                ip_address: ip,
                attack_type: AttackType::SqlInjection,
                severity: Severity::Critical,
                method: method.to_string(),
                path: uri.path().to_string(),
                user_agent: get_user_agent(&headers),
                payload: attack.payload,
                blocked: true,
                details: attack.details,
            },
        )
        .await;

        return Err(StatusCode::FORBIDDEN);
    }

    // XSS detection
    if let Some(attack) = detect_xss(&uri.query().unwrap_or(""), &body_str, &headers) {
        state.metrics.requests_blocked.inc();
        state.metrics.xss_blocked.inc();
        warn!("XSS attack detected from {}", ip);

        block_ip(
            &state,
            ip.clone(),
            "XSS attempt",
            state.config.attack_ban_duration,
        )
        .await;

        log_attack(
            &state.db,
            AttackLog {
                timestamp: current_timestamp(),
                ip_address: ip,
                attack_type: AttackType::Xss,
                severity: Severity::Critical,
                method: method.to_string(),
                path: uri.path().to_string(),
                user_agent: get_user_agent(&headers),
                payload: attack.payload,
                blocked: true,
                details: attack.details,
            },
        )
        .await;

        return Err(StatusCode::FORBIDDEN);
    }

    // Path Traversal detection
    if let Some(attack) = detect_path_traversal(&uri.path(), &uri.query().unwrap_or("")) {
        state.metrics.requests_blocked.inc();
        state.metrics.path_traversal_blocked.inc();
        warn!("Path traversal detected from {}", ip);

        block_ip(
            &state,
            ip.clone(),
            "Path traversal attempt",
            state.config.attack_ban_duration,
        )
        .await;

        log_attack(
            &state.db,
            AttackLog {
                timestamp: current_timestamp(),
                ip_address: ip,
                attack_type: AttackType::PathTraversal,
                severity: Severity::High,
                method: method.to_string(),
                path: uri.path().to_string(),
                user_agent: get_user_agent(&headers),
                payload: attack.payload,
                blocked: true,
                details: attack.details,
            },
        )
        .await;

        return Err(StatusCode::FORBIDDEN);
    }

    // Command Injection detection
    if let Some(attack) = detect_command_injection(&uri.query().unwrap_or(""), &body_str) {
        state.metrics.requests_blocked.inc();
        state.metrics.command_injection_blocked.inc();
        warn!("Command injection detected from {}", ip);

        block_ip(
            &state,
            ip.clone(),
            "Command injection attempt",
            state.config.attack_ban_duration,
        )
        .await;

        log_attack(
            &state.db,
            AttackLog {
                timestamp: current_timestamp(),
                ip_address: ip,
                attack_type: AttackType::CommandInjection,
                severity: Severity::Critical,
                method: method.to_string(),
                path: uri.path().to_string(),
                user_agent: get_user_agent(&headers),
                payload: attack.payload,
                blocked: true,
                details: attack.details,
            },
        )
        .await;

        return Err(StatusCode::FORBIDDEN);
    }

    // Check custom rules
    if let Some(violation) = state
        .rule_engine
        .check_request(&method, &uri, &headers, &body_str)
        .await
    {
        state.metrics.requests_blocked.inc();
        state.metrics.custom_rules_triggered.inc();
        warn!("Custom rule violation from {}: {}", ip, violation.rule_name);

        if violation.action == RuleAction::Block {
            block_ip(&state, ip.clone(), &violation.rule_name, violation.ban_duration).await;

            log_attack(
                &state.db,
                AttackLog {
                    timestamp: current_timestamp(),
                    ip_address: ip,
                    attack_type: AttackType::InvalidInput,
                    severity: Severity::High,
                    method: method.to_string(),
                    path: uri.path().to_string(),
                    user_agent: get_user_agent(&headers),
                    payload: String::new(),
                    blocked: true,
                    details: format!("Rule: {}", violation.rule_name),
                },
            )
            .await;

            return Err(StatusCode::FORBIDDEN);
        }
    }

    // Recreate request
    let request = Request::from_parts(parts, Body::from(bytes));

    // Allow request
    state.metrics.requests_allowed.inc();
    let response = next.run(request).await;

    // Record response time
    if let Ok(elapsed) = start_time.elapsed() {
        state
            .metrics
            .response_time
            .observe(elapsed.as_secs_f64());
    }

    Ok(response)
}

// ==================== HANDLERS ====================

async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "healthy",
        "timestamp": current_timestamp(),
        "version": "1.0.0"
    }))
}

async fn get_metrics(State(state): State<AppState>) -> impl IntoResponse {
    use prometheus::Encoder;
    let encoder = prometheus::TextEncoder::new();
    let metric_families = state.metrics.registry.gather();
    let mut buffer = vec![];
    encoder.encode(&metric_families, &mut buffer).unwrap();
    Response::builder()
        .header("Content-Type", encoder.format_type())
        .body(Body::from(buffer))
        .unwrap()
}

async fn get_stats(State(state): State<AppState>) -> impl IntoResponse {
    let blocked_ips_count = state.blocked_ips.read().await.len();
    let whitelist_count = state.whitelist.read().await.len();

    Json(serde_json::json!({
        "blocked_ips_count": blocked_ips_count,
        "whitelist_count": whitelist_count,
        "timestamp": current_timestamp()
    }))
}

async fn list_blocked_ips(State(state): State<AppState>) -> impl IntoResponse {
    let blocked_ips = state.blocked_ips.read().await;
    let now = current_timestamp();

    let active_blocks: Vec<_> = blocked_ips
        .iter()
        .filter(|(_, info)| now < info.unblock_at)
        .map(|(ip, info)| {
            serde_json::json!({
                "ip": ip,
                "reason": info.reason,
                "blocked_at": info.blocked_at,
                "unblock_at": info.unblock_at,
                "remaining_seconds": info.unblock_at.saturating_sub(now),
                "block_count": info.block_count
            })
        })
        .collect();

    Json(active_blocks)
}

async fn list_whitelist(State(state): State<AppState>) -> impl IntoResponse {
    let whitelist = state.whitelist.read().await;
    let entries: Vec<_> = whitelist
        .iter()
        .map(|(ip, reason)| {
            serde_json::json!({
                "ip": ip,
                "reason": reason
            })
        })
        .collect();

    Json(entries)
}

#[derive(Deserialize)]
struct WhitelistRequest {
    ip: String,
    reason: String,
}

async fn add_to_whitelist(
    State(state): State<AppState>,
    Json(req): Json<WhitelistRequest>,
) -> impl IntoResponse {
    // Validate IP
    if req.ip.parse::<std::net::IpAddr>().is_err() {
        return (StatusCode::BAD_REQUEST, "Invalid IP address").into_response();
    }

    // Add to database
    if let Err(e) = sqlx::query("INSERT OR REPLACE INTO whitelist (ip_address, reason) VALUES (?, ?)")
        .bind(&req.ip)
        .bind(&req.reason)
        .execute(&state.db)
        .await
    {
        error!("Failed to add to whitelist: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response();
    }

    // Add to memory
    state.whitelist.write().await.insert(req.ip.clone(), req.reason.clone());

    Json(serde_json::json!({
        "success": true,
        "ip": req.ip,
        "reason": req.reason
    }))
    .into_response()
}

async fn list_rules(State(state): State<AppState>) -> impl IntoResponse {
    let rules = state.rule_engine.get_rules().await;
    Json(rules)
}

#[derive(Deserialize)]
struct RulesUpdate {
    rules: Vec<Rule>,
}

async fn update_rules(
    State(state): State<AppState>,
    Json(req): Json<RulesUpdate>,
) -> impl IntoResponse {
    state.rule_engine.update_rules(req.rules).await;
    Json(serde_json::json!({"success": true}))
}

async fn get_attack_logs(State(state): State<AppState>) -> impl IntoResponse {
    let logs = sqlx::query_as::<_, (i64, String, String, String, String, String, String, String, bool, String)>(
        "SELECT id, timestamp, ip_address, attack_type, severity, request_method, request_path, user_agent, blocked, details 
         FROM attack_logs 
         ORDER BY id DESC 
         LIMIT 100"
    )
    .fetch_all(&state.db)
    .await;

    match logs {
        Ok(rows) => {
            let logs: Vec<_> = rows
                .iter()
                .map(|row| {
                    serde_json::json!({
                        "id": row.0,
                        "timestamp": row.1,
                        "ip_address": row.2,
                        "attack_type": row.3,
                        "severity": row.4,
                        "method": row.5,
                        "path": row.6,
                        "user_agent": row.7,
                        "blocked": row.8,
                        "details": row.9
                    })
                })
                .collect();

            Json(logs).into_response()
        }
        Err(e) => {
            error!("Failed to fetch attack logs: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response()
        }
    }
}

async fn clear_blocks(State(state): State<AppState>) -> impl IntoResponse {
    state.blocked_ips.write().await.clear();
    Json(serde_json::json!({"success": true, "message": "All temporary blocks cleared"}))
}

async fn proxy_handler(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> impl IntoResponse {
    // This is a placeholder - in production, you'd proxy to your backend services
    Json(serde_json::json!({
        "message": "Request passed WAF validation",
        "method": method.to_string(),
        "path": uri.path(),
        "timestamp": current_timestamp()
    }))
}

// ==================== HELPER FUNCTIONS ====================

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn get_user_agent(headers: &HeaderMap) -> String {
    headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string()
}

async fn block_ip(state: &AppState, ip: String, reason: &str, duration: u64) {
    let now = current_timestamp();
    let unblock_at = now + duration;

    let mut blocked_ips = state.blocked_ips.write().await;
    let block_count = blocked_ips
        .get(&ip)
        .map(|info| info.block_count + 1)
        .unwrap_or(1);

    blocked_ips.insert(
        ip.clone(),
        BlockInfo {
            reason: reason.to_string(),
            blocked_at: now,
            unblock_at,
            block_count,
        },
    );

    // Persist to database
    let _ = sqlx::query(
        "INSERT OR REPLACE INTO blocked_ips (ip_address, unblock_at, reason, block_count) VALUES (?, ?, ?, ?)"
    )
    .bind(&ip)
    .bind(unblock_at as i64)
    .bind(reason)
    .bind(block_count as i64)
    .execute(&state.db)
    .await;

    info!("Blocked IP {} for {} seconds: {}", ip, duration, reason);
}

async fn load_whitelist(db: &SqlitePool) -> anyhow::Result<HashMap<String, String>> {
    let rows = sqlx::query_as::<_, (String, String)>("SELECT ip_address, reason FROM whitelist")
        .fetch_all(db)
        .await?;

    Ok(rows.into_iter().collect())
}

async fn log_attack(db: &SqlitePool, log: AttackLog) {
    let _ = sqlx::query(
        "INSERT INTO attack_logs (timestamp, ip_address, attack_type, severity, request_method, request_path, user_agent, payload, blocked, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(log.timestamp as i64)
    .bind(&log.ip_address)
    .bind(format!("{:?}", log.attack_type))
    .bind(format!("{:?}", log.severity))
    .bind(&log.method)
    .bind(&log.path)
    .bind(&log.user_agent)
    .bind(&log.payload)
    .bind(log.blocked)
    .bind(&log.details)
    .execute(db)
    .await;
}
