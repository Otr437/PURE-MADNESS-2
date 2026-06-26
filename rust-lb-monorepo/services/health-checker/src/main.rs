use anyhow::{Context, Result};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use chrono::{DateTime, Utc};
use clap::Parser;
use dashmap::DashMap;
use lb_core::{
    health::{HealthCheckConfig, HealthCheckKind},
    types::BackendStatus,
};
use lb_tracing::init_json_logging;
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc, time::Instant};
use tokio::signal;
use tracing::{error, info, warn};

#[derive(Parser, Debug)]
#[command(name = "health-checker", version, about = "Backend health checker daemon")]
struct Args {
    #[arg(short, long, env = "HC_BIND", default_value = "0.0.0.0:6060")]
    bind: String,
    #[arg(long, env = "HC_LOG_LEVEL", default_value = "info")]
    log_level: String,
    #[arg(long, env = "HC_CONFIG_FILE", default_value = "config/health-checker.toml")]
    config: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HealthCheckerConfig {
    backends: Vec<BackendEntry>,
    check: HealthCheckConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackendEntry {
    id: String,
    host: String,
    port: u16,
    tls: bool,
}

impl BackendEntry {
    fn base_url(&self) -> String {
        let scheme = if self.tls { "https" } else { "http" };
        format!("{}://{}:{}", scheme, self.host, self.port)
    }
}

#[derive(Debug, Clone, Serialize)]
struct BackendHealthRecord {
    id: String,
    status: String,
    consecutive_successes: u32,
    consecutive_failures: u32,
    last_check: Option<DateTime<Utc>>,
    last_success: Option<DateTime<Utc>>,
    last_failure: Option<DateTime<Utc>>,
    last_error: Option<String>,
    avg_latency_ms: f64,
}

#[derive(Clone)]
struct AppState {
    health_map: Arc<DashMap<String, BackendHealthRecord>>,
    config: Arc<HealthCheckerConfig>,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    let args = Args::parse();
    init_json_logging("health-checker", &args.log_level)?;

    let cfg: HealthCheckerConfig = load_config(&args.config)?;
    let health_map: Arc<DashMap<String, BackendHealthRecord>> = Arc::new(DashMap::new());

    // Pre-populate health map with unknown state
    for backend in &cfg.backends {
        health_map.insert(
            backend.id.clone(),
            BackendHealthRecord {
                id: backend.id.clone(),
                status: "unknown".to_string(),
                consecutive_successes: 0,
                consecutive_failures: 0,
                last_check: None,
                last_success: None,
                last_failure: None,
                last_error: None,
                avg_latency_ms: 0.0,
            },
        );
    }

    let state = AppState {
        health_map: health_map.clone(),
        config: Arc::new(cfg.clone()),
    };

    let http_client = Arc::new(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(cfg.check.timeout_secs))
            .build()
            .context("building HTTP client")?,
    );

    // Start background health check loop
    let loop_health_map = health_map.clone();
    let loop_cfg = cfg.clone();
    let loop_client = http_client.clone();
    tokio::spawn(async move {
        run_health_loop(loop_client, loop_cfg, loop_health_map).await;
    });

    let app = build_router(state);
    let addr: SocketAddr = args.bind.parse().context("parsing bind address")?;
    info!(addr = %addr, "Health checker listening");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .context("binding listener")?;

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("health checker serve error")?;

    info!("Health checker shutdown complete");
    Ok(())
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(service_health_handler))
        .route("/backends", get(all_backends_handler))
        .route("/backends/healthy", get(healthy_backends_handler))
        .route("/backends/unhealthy", get(unhealthy_backends_handler))
        .with_state(state)
        .layer(tower_http::trace::TraceLayer::new_for_http())
}

async fn service_health_handler() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok", "service": "health-checker" })))
}

async fn all_backends_handler(State(state): State<AppState>) -> impl IntoResponse {
    let records: Vec<BackendHealthRecord> = state
        .health_map
        .iter()
        .map(|e| e.value().clone())
        .collect();
    (StatusCode::OK, Json(records))
}

async fn healthy_backends_handler(State(state): State<AppState>) -> impl IntoResponse {
    let records: Vec<BackendHealthRecord> = state
        .health_map
        .iter()
        .filter(|e| e.value().status == "healthy")
        .map(|e| e.value().clone())
        .collect();
    (StatusCode::OK, Json(records))
}

async fn unhealthy_backends_handler(State(state): State<AppState>) -> impl IntoResponse {
    let records: Vec<BackendHealthRecord> = state
        .health_map
        .iter()
        .filter(|e| e.value().status != "healthy")
        .map(|e| e.value().clone())
        .collect();
    (StatusCode::OK, Json(records))
}

async fn run_health_loop(
    client: Arc<reqwest::Client>,
    cfg: HealthCheckerConfig,
    health_map: Arc<DashMap<String, BackendHealthRecord>>,
) {
    let interval = std::time::Duration::from_secs(cfg.check.interval_secs);
    let mut ticker = tokio::time::interval(interval);

    loop {
        ticker.tick().await;

        let backends = cfg.backends.clone();
        let check_cfg = cfg.check.clone();

        let mut tasks = Vec::new();
        for backend in backends {
            let client = client.clone();
            let check_cfg = check_cfg.clone();
            let health_map = health_map.clone();

            tasks.push(tokio::spawn(async move {
                let start = Instant::now();
                let now = Utc::now();
                let url = format!("{}{}", backend.base_url(), check_cfg.path);

                let result = client
                    .get(&url)
                    .timeout(std::time::Duration::from_secs(check_cfg.timeout_secs))
                    .send()
                    .await;

                let latency_ms = start.elapsed().as_secs_f64() * 1000.0;

                let mut record = health_map
                    .entry(backend.id.clone())
                    .or_insert_with(|| BackendHealthRecord {
                        id: backend.id.clone(),
                        status: "unknown".to_string(),
                        consecutive_successes: 0,
                        consecutive_failures: 0,
                        last_check: None,
                        last_success: None,
                        last_failure: None,
                        last_error: None,
                        avg_latency_ms: 0.0,
                    });

                record.last_check = Some(now);
                // EMA for latency
                let alpha = 0.1_f64;
                record.avg_latency_ms = alpha * latency_ms + (1.0 - alpha) * record.avg_latency_ms;

                match result {
                    Ok(resp) if resp.status().as_u16() == check_cfg.expected_status => {
                        record.consecutive_failures = 0;
                        record.consecutive_successes += 1;
                        record.last_success = Some(now);
                        record.last_error = None;
                        if record.consecutive_successes >= check_cfg.healthy_threshold {
                            if record.status != "healthy" {
                                info!(backend = %backend.id, "Backend is now healthy");
                            }
                            record.status = "healthy".to_string();
                        }
                    }
                    Ok(resp) => {
                        let err = format!("Unexpected status {}", resp.status().as_u16());
                        record.consecutive_successes = 0;
                        record.consecutive_failures += 1;
                        record.last_failure = Some(now);
                        record.last_error = Some(err.clone());
                        if record.consecutive_failures >= check_cfg.unhealthy_threshold {
                            if record.status == "healthy" {
                                warn!(backend = %backend.id, error = %err, "Backend is now unhealthy");
                            }
                            record.status = "unhealthy".to_string();
                        }
                    }
                    Err(e) => {
                        let err = e.to_string();
                        record.consecutive_successes = 0;
                        record.consecutive_failures += 1;
                        record.last_failure = Some(now);
                        record.last_error = Some(err.clone());
                        if record.consecutive_failures >= check_cfg.unhealthy_threshold {
                            if record.status == "healthy" {
                                warn!(backend = %backend.id, error = %err, "Backend is now unhealthy");
                            }
                            record.status = "unhealthy".to_string();
                        }
                    }
                }
            }));
        }

        for task in tasks {
            if let Err(e) = task.await {
                error!(error = %e, "Health check task panicked");
            }
        }
    }
}

fn load_config(path: &str) -> Result<HealthCheckerConfig> {
    let cfg = config::Config::builder()
        .add_source(config::File::with_name(path).required(false))
        .add_source(
            config::Environment::with_prefix("HC")
                .separator("__")
                .try_parsing(true),
        )
        .build()
        .context("loading health checker config")?;

    cfg.try_deserialize().context("deserializing health checker config")
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
        _ = ctrl_c => { warn!("SIGINT — shutting down health checker"); }
        _ = terminate => { warn!("SIGTERM — shutting down health checker"); }
    }
}
