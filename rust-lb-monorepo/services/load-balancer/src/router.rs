use crate::{middleware, proxy};
use axum::{
    routing::any,
    Router,
};
use std::sync::Arc;
use tower::ServiceBuilder;
use tower_http::{
    cors::{Any, CorsLayer},
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

pub fn build_router(state: Arc<proxy::AppState>) -> Router {
    let request_timeout = std::time::Duration::from_millis(
        state.config.server.request_timeout_ms,
    );

    let cors = CorsLayer::new()
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::PATCH,
            axum::http::Method::HEAD,
            axum::http::Method::OPTIONS,
        ])
        // In production, replace Any with specific origins from config
        .allow_origin(Any)
        .allow_headers(Any);

    Router::new()
        // All paths are proxied — the handler does the backend selection
        .route("/{*path}", any(proxy::proxy_handler))
        .route("/", any(proxy::proxy_handler))
        .with_state(state)
        .layer(
            ServiceBuilder::new()
                .layer(TraceLayer::new_for_http())
                .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
                .layer(PropagateRequestIdLayer::x_request_id())
                .layer(TimeoutLayer::new(request_timeout))
                .layer(cors),
        )
}
