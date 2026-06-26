use crate::middleware::RateLimiter;
use arc_swap::ArcSwap;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use lb_core::{
    algorithm::SelectionAlgorithm,
    backend::Backend,
    config::{LbConfig, RateLimitKey},
    health::{HealthCheckConfig, HealthCheckKind, HealthCheckResult},
    shard::ShardManager,
    types::{BackendStatus, RequestContext},
};
use metrics_core::LbMetrics;
use std::{sync::Arc, time::Instant};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

pub struct AppState {
    pub backends: Arc<ArcSwap<Vec<Arc<Backend>>>>,
    pub algorithm: Arc<ArcSwap<Arc<dyn SelectionAlgorithm>>>,
    pub shard_manager: Option<Arc<ShardManager>>,
    pub metrics: Arc<LbMetrics>,
    pub http_client: Arc<reqwest::Client>,
    pub config: Arc<LbConfig>,
}

pub async fn proxy_handler(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
) -> Response {
    let start = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let method_str = method.as_str().to_owned();

    // Extract or generate correlation ID
    let correlation_id = req
        .headers()
        .get("x-correlation-id")
        .or_else(|| req.headers().get("x-request-id"))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_owned())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // Extract client IP (X-Forwarded-For → fallback to X-Real-IP)
    let client_ip = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_owned())
        .or_else(|| {
            req.headers()
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_owned())
        })
        .unwrap_or_else(|| "unknown".to_owned());

    let mut ctx = RequestContext::new(client_ip.clone(), method_str.clone(), path.clone());
    ctx.correlation_id = Some(correlation_id.clone());

    // Rate limiting
    if let Some(rl_config) = &state.config.rate_limit {
        if rl_config.enabled {
            let rate_key = match &rl_config.key_strategy {
                RateLimitKey::ClientIp => client_ip.clone(),
                RateLimitKey::Header(h) => req
                    .headers()
                    .get(h.as_str())
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("unknown")
                    .to_owned(),
                RateLimitKey::Global => "global".to_owned(),
            };
            // Rate limiting is enforced via the RateLimiter middleware layer;
            // if a request reaches this handler, it has already passed the limit check.
            let _ = rate_key;
        }
    }

    // Sharding: if shard key header is present and sharding is enabled, route by shard
    let backend_result = if let Some(shard_mgr) = &state.shard_manager {
        if let Some(shard_cfg) = &state.config.sharding {
            if shard_cfg.enabled {
                let shard_key = req
                    .headers()
                    .get(shard_cfg.key_header.as_str())
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(&client_ip)
                    .to_owned();

                match shard_mgr.shard_for_key(&shard_key) {
                    Ok(shard_id) => {
                        state.metrics.record_shard_request(shard_id);
                        shard_mgr.backend_for_key(&shard_key).map_err(|e| {
                            warn!(
                                shard_key = %shard_key,
                                error = %e,
                                correlation_id = %correlation_id,
                                "Shard backend selection failed"
                            );
                            e
                        })
                    }
                    Err(e) => {
                        warn!(
                            shard_key = %shard_key,
                            error = %e,
                            correlation_id = %correlation_id,
                            "Shard key mapping failed"
                        );
                        Err(e)
                    }
                }
            } else {
                select_backend_via_algorithm(&state, &ctx, &correlation_id).await
            }
        } else {
            select_backend_via_algorithm(&state, &ctx, &correlation_id).await
        }
    } else {
        select_backend_via_algorithm(&state, &ctx, &correlation_id).await
    };

    let backend = match backend_result {
        Ok(b) => b,
        Err(e) => {
            error!(
                error = %e,
                correlation_id = %correlation_id,
                "No backend available"
            );
            state.metrics.record_backend_error("none", "no_healthy_backend");
            return build_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Service temporarily unavailable",
                &correlation_id,
            );
        }
    };

    let backend_id = backend.id.as_str().to_owned();
    let algorithm_name = state.algorithm.load().name().to_owned();

    backend.increment_connections();
    state
        .metrics
        .set_backend_connections(&backend_id, backend.active_connections() as f64);

    // Forward the request
    let upstream_start = Instant::now();
    let result = forward_request(&state.http_client, &backend, req, &correlation_id).await;
    let upstream_latency = upstream_start.elapsed().as_secs_f64();

    backend.decrement_connections();
    state
        .metrics
        .set_backend_connections(&backend_id, backend.active_connections() as f64);

    match result {
        Ok(response) => {
            let status = response.status().as_u16();
            let total_latency = start.elapsed().as_secs_f64();

            backend.record_success(upstream_latency * 1000.0);
            state.metrics.record_request(
                &method_str,
                &path,
                status,
                &algorithm_name,
                total_latency,
            );
            state
                .metrics
                .record_backend_request(&backend_id, &algorithm_name);
            state
                .metrics
                .record_backend_latency(&backend_id, upstream_latency);

            debug!(
                backend = %backend_id,
                status = status,
                latency_ms = upstream_latency * 1000.0,
                correlation_id = %correlation_id,
                "Request proxied successfully"
            );

            response
        }
        Err(e) => {
            backend.record_failure();
            state.metrics.record_backend_error(&backend_id, "upstream_error");
            error!(
                backend = %backend_id,
                error = %e,
                correlation_id = %correlation_id,
                "Upstream request failed"
            );
            build_error_response(
                StatusCode::BAD_GATEWAY,
                "Upstream server error",
                &correlation_id,
            )
        }
    }
}

async fn select_backend_via_algorithm(
    state: &AppState,
    ctx: &RequestContext,
    correlation_id: &str,
) -> lb_core::error::LbResult<Arc<Backend>> {
    let backends_snapshot = state.backends.load();
    let algorithm = state.algorithm.load();
    algorithm.select(&backends_snapshot, ctx).await.map(|b| {
        debug!(
            backend = %b.id,
            algorithm = algorithm.name(),
            correlation_id = %correlation_id,
            "Backend selected"
        );
        b.clone()
    })
}

async fn forward_request(
    client: &reqwest::Client,
    backend: &Backend,
    req: Request<Body>,
) -> Result<Response, String> {
    forward_request_inner(client, backend, req, "").await
}

async fn forward_request_inner(
    client: &reqwest::Client,
    backend: &Backend,
    req: Request<Body>,
    correlation_id: &str,
) -> Result<Response, String> {
    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let uri = parts.uri.clone();

    let upstream_url = format!(
        "{}{}",
        backend.config.base_url(),
        uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/")
    );

    let body_bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .map_err(|e| format!("Failed to read request body: {}", e))?;

    let mut upstream_req = client
        .request(
            method.clone(),
            &upstream_url,
        )
        .timeout(std::time::Duration::from_millis(
            backend.config.request_timeout_ms,
        ));

    // Forward headers, stripping hop-by-hop headers
    for (name, value) in &parts.headers {
        let name_str = name.as_str().to_lowercase();
        if !is_hop_by_hop_header(&name_str) {
            upstream_req = upstream_req.header(name, value);
        }
    }

    // Add correlation ID and forwarding headers
    upstream_req = upstream_req
        .header("x-correlation-id", correlation_id)
        .header("x-forwarded-by", "rust-lb/1.0");

    if !body_bytes.is_empty() {
        upstream_req = upstream_req.body(body_bytes);
    }

    let upstream_resp = upstream_req
        .send()
        .await
        .map_err(|e| format!("Upstream request error: {}", e))?;

    let status = upstream_resp.status();
    let mut response_builder = axum::response::Response::builder().status(status.as_u16());

    for (name, value) in upstream_resp.headers() {
        let name_str = name.as_str().to_lowercase();
        if !is_hop_by_hop_header(&name_str) {
            if let (Ok(header_name), Ok(header_value)) = (
                HeaderName::from_bytes(name.as_str().as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) {
                response_builder = response_builder.header(header_name, header_value);
            }
        }
    }

    // Security headers on all proxied responses
    response_builder = response_builder
        .header("x-correlation-id", correlation_id)
        .header("x-content-type-options", "nosniff")
        .header("x-frame-options", "DENY")
        .header("referrer-policy", "strict-origin-when-cross-origin");

    let resp_bytes = upstream_resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read upstream response body: {}", e))?;

    response_builder
        .body(Body::from(resp_bytes))
        .map_err(|e| format!("Failed to build response: {}", e))
}

fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn build_error_response(status: StatusCode, message: &str, correlation_id: &str) -> Response {
    let body = serde_json::json!({
        "error": message,
        "correlation_id": correlation_id,
    });
    (
        status,
        [
            (
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (
                HeaderName::from_static("x-correlation-id"),
                HeaderValue::from_str(correlation_id).unwrap_or_else(|_| HeaderValue::from_static("unknown")),
            ),
        ],
        body.to_string(),
    )
        .into_response()
}

/// Background loop that periodically health-checks all backends.
pub async fn health_check_loop(state: Arc<AppState>, config: HealthCheckConfig) {
    let interval = std::time::Duration::from_secs(config.interval_secs);
    let mut ticker = tokio::time::interval(interval);

    loop {
        ticker.tick().await;

        let backends_snapshot = state.backends.load();
        let mut tasks = Vec::new();

        for backend in backends_snapshot.iter() {
            let backend = backend.clone();
            let config = config.clone();
            let client = state.http_client.clone();
            let metrics = state.metrics.clone();

            tasks.push(tokio::spawn(async move {
                let result = run_health_check(&client, &backend, &config).await;

                match &result.status {
                    BackendStatus::Healthy => {
                        if !backend.is_healthy() {
                            info!(
                                backend = %backend.id,
                                "Backend recovered — marking healthy"
                            );
                        }
                        backend.set_status(BackendStatus::Healthy);
                        metrics.set_backend_health(backend.id.as_str(), true);
                    }
                    BackendStatus::Unhealthy => {
                        if backend.is_healthy() {
                            warn!(
                                backend = %backend.id,
                                error = ?result.error,
                                "Backend failed health check — marking unhealthy"
                            );
                        }
                        backend.set_status(BackendStatus::Unhealthy);
                        metrics.set_backend_health(backend.id.as_str(), false);
                    }
                    _ => {}
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

async fn run_health_check(
    client: &reqwest::Client,
    backend: &Backend,
    config: &HealthCheckConfig,
) -> HealthCheckResult {
    let start = Instant::now();
    let backend_id = backend.id.as_str().to_owned();

    let result = match config.kind {
        HealthCheckKind::Http => {
            let url = format!("{}{}", backend.config.base_url(), config.path);
            client
                .get(&url)
                .timeout(std::time::Duration::from_secs(config.timeout_secs))
                .send()
                .await
        }
        HealthCheckKind::Tcp => {
            // TCP health check: attempt to open a TCP connection
            let addr = backend.config.address();
            match tokio::time::timeout(
                std::time::Duration::from_secs(config.timeout_secs),
                tokio::net::TcpStream::connect(&addr),
            )
            .await
            {
                Ok(Ok(_)) => {
                    return HealthCheckResult {
                        backend_id,
                        status: BackendStatus::Healthy,
                        latency_ms: start.elapsed().as_secs_f64() * 1000.0,
                        error: None,
                        checked_at: chrono::Utc::now(),
                    }
                }
                Ok(Err(e)) => {
                    return HealthCheckResult {
                        backend_id,
                        status: BackendStatus::Unhealthy,
                        latency_ms: start.elapsed().as_secs_f64() * 1000.0,
                        error: Some(e.to_string()),
                        checked_at: chrono::Utc::now(),
                    }
                }
                Err(_) => {
                    return HealthCheckResult {
                        backend_id,
                        status: BackendStatus::Unhealthy,
                        latency_ms: start.elapsed().as_secs_f64() * 1000.0,
                        error: Some("TCP connect timeout".to_owned()),
                        checked_at: chrono::Utc::now(),
                    }
                }
            }
        }
    };

    let latency_ms = start.elapsed().as_secs_f64() * 1000.0;

    match result {
        Ok(resp) if resp.status().as_u16() == config.expected_status => HealthCheckResult {
            backend_id,
            status: BackendStatus::Healthy,
            latency_ms,
            error: None,
            checked_at: chrono::Utc::now(),
        },
        Ok(resp) => HealthCheckResult {
            backend_id,
            status: BackendStatus::Unhealthy,
            latency_ms,
            error: Some(format!(
                "Unexpected status: {}",
                resp.status().as_u16()
            )),
            checked_at: chrono::Utc::now(),
        },
        Err(e) => HealthCheckResult {
            backend_id,
            status: BackendStatus::Unhealthy,
            latency_ms,
            error: Some(e.to_string()),
            checked_at: chrono::Utc::now(),
        },
    }
}
