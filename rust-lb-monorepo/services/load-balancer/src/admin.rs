use crate::proxy::AppState;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use lb_core::types::BackendStatus;
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
use tracing::{error, info};

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
    uptime_secs: u64,
}

#[derive(Debug, Serialize)]
struct BackendStatusResponse {
    id: String,
    address: String,
    status: String,
    active_connections: u64,
    total_requests: u64,
    total_errors: u64,
    avg_latency_ms: f64,
    circuit_breaker_open: bool,
}

#[derive(Debug, Serialize)]
struct StatsResponse {
    total_backends: usize,
    healthy_backends: usize,
    unhealthy_backends: usize,
    shard_count: usize,
    algorithm: String,
}

static START_TIME: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

pub async fn run_admin_server(addr: SocketAddr, state: Arc<AppState>) -> anyhow::Result<()> {
    START_TIME.get_or_init(std::time::Instant::now);

    let app = build_admin_router(state);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| anyhow::anyhow!("Admin bind error: {}", e))?;

    info!(addr = %addr, "Admin server listening");
    axum::serve(listener, app)
        .await
        .map_err(|e| anyhow::anyhow!("Admin server error: {}", e))
}

fn build_admin_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/ready", get(readiness_handler))
        .route("/metrics", get(metrics_handler))
        .route("/admin/backends", get(backends_handler))
        .route("/admin/stats", get(stats_handler))
        .with_state(state)
}

async fn health_handler() -> impl IntoResponse {
    let uptime_secs = START_TIME
        .get()
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0);

    (
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok",
            version: env!("CARGO_PKG_VERSION"),
            uptime_secs,
        }),
    )
}

async fn readiness_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let backends = state.backends.load();
    let has_healthy = backends.iter().any(|b| b.is_healthy());

    if has_healthy {
        (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "ready" })),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "status": "not_ready", "reason": "no healthy backends" })),
        )
    }
}

async fn metrics_handler(State(state): State<Arc<AppState>>) -> Response {
    match state.metrics.render() {
        Ok(text) => (
            StatusCode::OK,
            [(
                axum::http::header::CONTENT_TYPE,
                "text/plain; version=0.0.4; charset=utf-8",
            )],
            text,
        )
            .into_response(),
        Err(e) => {
            error!(error = %e, "Failed to render metrics");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to render metrics",
            )
                .into_response()
        }
    }
}

async fn backends_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let backends = state.backends.load();
    let response: Vec<BackendStatusResponse> = backends
        .iter()
        .map(|b| {
            let stats = b.stats();
            BackendStatusResponse {
                id: b.id.as_str().to_owned(),
                address: b.config.address(),
                status: b.status().to_string(),
                active_connections: stats.active_connections,
                total_requests: stats.total_requests,
                total_errors: stats.total_errors,
                avg_latency_ms: stats.avg_latency_ms,
                circuit_breaker_open: b.is_circuit_open(),
            }
        })
        .collect();

    (StatusCode::OK, Json(response))
}

async fn stats_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let backends = state.backends.load();
    let healthy = backends.iter().filter(|b| b.is_healthy()).count();
    let unhealthy = backends.len() - healthy;
    let shard_count = state
        .shard_manager
        .as_ref()
        .map(|sm| sm.shard_count())
        .unwrap_or(0);
    let algorithm = state.algorithm.load().name().to_owned();

    (
        StatusCode::OK,
        Json(StatsResponse {
            total_backends: backends.len(),
            healthy_backends: healthy,
            unhealthy_backends: unhealthy,
            shard_count,
            algorithm,
        }),
    )
}
