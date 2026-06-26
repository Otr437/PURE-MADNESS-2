use anyhow::{Context, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{delete, get, post, put},
    Router,
};
use clap::Parser;
use dashmap::DashMap;
use lb_core::{
    shard::{Shard, ShardManager, ShardStrategy},
    types::{BackendStatus, ShardId},
};
use lb_tracing::init_json_logging;
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
use tokio::signal;
use tracing::{error, info, warn};

#[derive(Parser, Debug)]
#[command(name = "shard-manager", version, about = "Shard topology management service")]
struct Args {
    #[arg(short, long, env = "SHARD_MANAGER_BIND", default_value = "0.0.0.0:7070")]
    bind: String,
    #[arg(long, env = "SHARD_MANAGER_LOG_LEVEL", default_value = "info")]
    log_level: String,
    #[arg(long, env = "SHARD_MANAGER_VIRTUAL_NODES", default_value = "150")]
    virtual_nodes: u32,
}

#[derive(Clone)]
struct AppState {
    shard_manager: Arc<ShardManager>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RegisterShardRequest {
    id: u32,
    backend_ids: Vec<String>,
    replica_count: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct RemoveShardRequest {
    id: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct LookupKeyRequest {
    key: String,
}

#[derive(Debug, Serialize)]
struct ShardInfoResponse {
    id: u32,
    backend_ids: Vec<String>,
    replica_count: u32,
}

#[derive(Debug, Serialize)]
struct KeyLookupResponse {
    key: String,
    shard_id: u32,
}

#[derive(Debug, Serialize)]
struct TopologyResponse {
    shard_count: usize,
    backend_count: usize,
    shards: Vec<ShardInfoResponse>,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    let args = Args::parse();

    init_json_logging("shard-manager", &args.log_level)?;

    let strategy = ShardStrategy::ConsistentHash {
        virtual_nodes: args.virtual_nodes,
    };
    let shard_manager = Arc::new(ShardManager::new(strategy));

    let state = AppState { shard_manager };

    let app = build_router(Arc::new(state));
    let addr: SocketAddr = args.bind.parse().context("parsing bind address")?;

    info!(addr = %addr, virtual_nodes = args.virtual_nodes, "Shard manager starting");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .context("binding listener")?;

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("shard manager serve error")?;

    info!("Shard manager shutdown complete");
    Ok(())
}

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/shards", get(list_shards_handler))
        .route("/shards", post(register_shard_handler))
        .route("/shards/{id}", get(get_shard_handler))
        .route("/shards/{id}", delete(remove_shard_handler))
        .route("/lookup", post(lookup_key_handler))
        .route("/topology", get(topology_handler))
        .with_state(state)
        .layer(
            tower_http::trace::TraceLayer::new_for_http()
        )
}

async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok", "service": "shard-manager" })))
}

async fn list_shards_handler(State(state): State<AppState>) -> impl IntoResponse {
    // DashMap doesn't expose a direct list; we collect all shard IDs by iterating
    let mgr = &state.shard_manager;
    // Use topology response to enumerate
    let count = mgr.shard_count();
    (
        StatusCode::OK,
        Json(serde_json::json!({ "shard_count": count })),
    )
}

async fn register_shard_handler(
    State(state): State<AppState>,
    Json(req): Json<RegisterShardRequest>,
) -> impl IntoResponse {
    if req.backend_ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "backend_ids must not be empty" })),
        );
    }
    if req.replica_count == 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "replica_count must be > 0" })),
        );
    }

    let shard = Shard {
        id: ShardId::new(req.id),
        backend_ids: req.backend_ids.clone(),
        replica_count: req.replica_count,
        is_primary: true,
    };

    state.shard_manager.register_shard(shard);
    info!(shard_id = req.id, backends = ?req.backend_ids, "Shard registered");

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": req.id,
            "backend_ids": req.backend_ids,
            "replica_count": req.replica_count,
        })),
    )
}

async fn get_shard_handler(
    State(state): State<AppState>,
    Path(id): Path<u32>,
) -> impl IntoResponse {
    match state.shard_manager.backends_for_shard(id) {
        Ok(backends) => {
            let ids: Vec<String> = backends.iter().map(|b| b.id.as_str().to_owned()).collect();
            (
                StatusCode::OK,
                Json(serde_json::json!({ "id": id, "backend_ids": ids })),
            )
        }
        Err(e) => {
            warn!(shard_id = id, error = %e, "Shard not found");
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": format!("Shard {} not found", id) })),
            )
        }
    }
}

async fn remove_shard_handler(
    State(state): State<AppState>,
    Path(id): Path<u32>,
) -> impl IntoResponse {
    state.shard_manager.remove_shard(id);
    info!(shard_id = id, "Shard removed");
    (StatusCode::NO_CONTENT, Json(serde_json::json!({})))
}

async fn lookup_key_handler(
    State(state): State<AppState>,
    Json(req): Json<LookupKeyRequest>,
) -> impl IntoResponse {
    if req.key.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "key must not be empty" })),
        );
    }

    match state.shard_manager.shard_for_key(&req.key) {
        Ok(shard_id) => (
            StatusCode::OK,
            Json(serde_json::json!({ "key": req.key, "shard_id": shard_id })),
        ),
        Err(e) => {
            warn!(key = %req.key, error = %e, "Key lookup failed");
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
        }
    }
}

async fn topology_handler(State(state): State<AppState>) -> impl IntoResponse {
    let shard_count = state.shard_manager.shard_count();
    let backend_count = state.shard_manager.backend_count();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "shard_count": shard_count,
            "backend_count": backend_count,
        })),
    )
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => { warn!("SIGINT received — shutting down shard manager"); }
        _ = terminate => { warn!("SIGTERM received — shutting down shard manager"); }
    }
}
