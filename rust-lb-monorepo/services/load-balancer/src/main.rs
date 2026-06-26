mod admin;
mod middleware;
mod proxy;
mod router;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use clap::Parser;
use lb_core::{
    algorithm::AlgorithmKind,
    backend::{Backend, BackendConfig},
    config::{LbConfig, LogFormat},
    shard::{Shard, ShardManager, ShardStrategy},
    types::{BackendStatus, ShardId},
};
use lb_tracing::{init_json_logging, init_pretty_logging};
use metrics_core::LbMetrics;
use std::{net::SocketAddr, sync::Arc};
use tokio::{net::TcpListener, signal};
use tracing::{error, info, warn};

#[derive(Parser, Debug)]
#[command(name = "load-balancer", version, about = "Production Rust load balancer")]
struct Args {
    /// Path to the configuration file
    #[arg(short, long, env = "LB_CONFIG_FILE", default_value = "config/lb.toml")]
    config: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env for local development (no-op in production where env is injected)
    dotenvy::dotenv().ok();

    let args = Args::parse();
    let cfg = load_config(&args.config)?;

    // Initialize logging before anything else
    match cfg.observability.log_format {
        LogFormat::Json => init_json_logging("load-balancer", &cfg.observability.log_level)?,
        LogFormat::Pretty => init_pretty_logging("load-balancer", &cfg.observability.log_level)?,
    }

    info!(
        algorithm = ?cfg.algorithm,
        bind = %cfg.server.bind_addr,
        port = cfg.server.port,
        admin_port = cfg.server.admin_port,
        backend_count = cfg.backends.len(),
        "Load balancer starting"
    );

    // Build metrics registry
    let metrics = Arc::new(LbMetrics::new().context("initializing metrics")?);

    // Build shared backend list
    let backends: Vec<Arc<Backend>> = cfg
        .backends
        .iter()
        .map(|b| Arc::new(Backend::new(b.clone())))
        .collect();

    let backends = Arc::new(ArcSwap::from_pointee(backends));

    // Build algorithm
    let algorithm = Arc::new(ArcSwap::from_pointee(cfg.algorithm.clone().into_algorithm()));

    // Build shard manager if sharding is enabled
    let shard_manager: Option<Arc<ShardManager>> = cfg.sharding.as_ref().map(|sc| {
        let mgr = Arc::new(ShardManager::new(sc.strategy.clone()));
        for shard_def in &sc.shards {
            mgr.register_shard(Shard {
                id: ShardId::new(shard_def.id),
                backend_ids: shard_def.backend_ids.clone(),
                replica_count: shard_def.replica_count,
                is_primary: true,
            });
        }
        // Register all backends into the shard manager as well
        for backend in backends.load().iter() {
            mgr.register_backend(backend.clone());
        }
        info!(shard_count = mgr.shard_count(), "Shard manager initialized");
        mgr
    });

    // Build HTTP client for proxying upstream requests
    let http_client = Arc::new(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(
                cfg.server.request_timeout_ms,
            ))
            .tcp_keepalive(std::time::Duration::from_secs(cfg.server.keepalive_secs))
            .pool_max_idle_per_host(64)
            .build()
            .context("building HTTP client")?,
    );

    // Build shared app state
    let state = Arc::new(proxy::AppState {
        backends: backends.clone(),
        algorithm: algorithm.clone(),
        shard_manager,
        metrics: metrics.clone(),
        http_client,
        config: Arc::new(cfg.clone()),
    });

    // Start health checker background task
    let hc_state = state.clone();
    let hc_config = cfg.health_check.clone();
    tokio::spawn(async move {
        proxy::health_check_loop(hc_state, hc_config).await;
    });

    // Start admin server
    let admin_state = state.clone();
    let admin_addr: SocketAddr = format!(
        "{}:{}",
        cfg.server.bind_addr, cfg.server.admin_port
    )
    .parse()
    .context("parsing admin bind address")?;
    tokio::spawn(async move {
        if let Err(e) = admin::run_admin_server(admin_addr, admin_state).await {
            error!(error = %e, "Admin server failed");
        }
    });

    // Build main proxy router
    let app = router::build_router(state.clone());

    let bind_addr: SocketAddr =
        format!("{}:{}", cfg.server.bind_addr, cfg.server.port)
            .parse()
            .context("parsing main bind address")?;

    let listener = TcpListener::bind(bind_addr)
        .await
        .context("binding main listener")?;

    info!(addr = %bind_addr, "Load balancer listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("axum serve error")?;

    info!("Load balancer shutdown complete");
    Ok(())
}

fn load_config(path: &str) -> Result<LbConfig> {
    let cfg = config::Config::builder()
        .add_source(config::File::with_name(path).required(false))
        .add_source(
            config::Environment::with_prefix("LB")
                .separator("__")
                .try_parsing(true),
        )
        .build()
        .context("loading configuration")?;

    let lb_config: LbConfig = cfg
        .try_deserialize()
        .context("deserializing configuration")?;

    validate_config(&lb_config)?;
    Ok(lb_config)
}

fn validate_config(cfg: &LbConfig) -> Result<()> {
    if cfg.backends.is_empty() {
        anyhow::bail!("Configuration error: at least one backend must be defined");
    }
    for backend in &cfg.backends {
        if backend.host.is_empty() {
            anyhow::bail!("Configuration error: backend host cannot be empty");
        }
        if backend.port == 0 {
            anyhow::bail!("Configuration error: backend port cannot be 0");
        }
        if backend.connect_timeout_ms == 0 {
            anyhow::bail!("Configuration error: connect_timeout_ms must be > 0");
        }
        if backend.request_timeout_ms == 0 {
            anyhow::bail!("Configuration error: request_timeout_ms must be > 0");
        }
    }
    if cfg.server.port == 0 {
        anyhow::bail!("Configuration error: server port cannot be 0");
    }
    if cfg.server.admin_port == 0 {
        anyhow::bail!("Configuration error: admin port cannot be 0");
    }
    if cfg.server.port == cfg.server.admin_port {
        anyhow::bail!(
            "Configuration error: server port and admin port must be different"
        );
    }
    Ok(())
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
        _ = ctrl_c => {
            warn!("Received SIGINT — initiating graceful shutdown");
        }
        _ = terminate => {
            warn!("Received SIGTERM — initiating graceful shutdown");
        }
    }
}
