use anyhow::Result;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub fn init_json_logging(service_name: &str, log_level: &str) -> Result<()> {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(log_level));

    let json_layer = fmt::layer()
        .json()
        .with_current_span(true)
        .with_span_list(true)
        .with_target(true)
        .with_file(true)
        .with_line_number(true);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(json_layer)
        .try_init()
        .map_err(|e| anyhow::anyhow!("Failed to init tracing subscriber: {}", e))?;

    tracing::info!(service = service_name, "Structured JSON logging initialized");
    Ok(())
}

pub fn init_pretty_logging(service_name: &str, log_level: &str) -> Result<()> {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(log_level));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt::layer().pretty())
        .try_init()
        .map_err(|e| anyhow::anyhow!("Failed to init tracing subscriber: {}", e))?;

    tracing::info!(service = service_name, "Pretty logging initialized");
    Ok(())
}

/// Middleware helper: extract or generate a correlation ID from request headers.
pub fn extract_or_generate_correlation_id(
    headers: &std::collections::HashMap<String, String>,
) -> String {
    headers
        .get("x-correlation-id")
        .or_else(|| headers.get("x-request-id"))
        .cloned()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}
