use thiserror::Error;

#[derive(Debug, Error)]
pub enum LbError {
    #[error("No healthy backends available")]
    NoHealthyBackends,

    #[error("Backend not found: {0}")]
    BackendNotFound(String),

    #[error("Shard not found for key: {0}")]
    ShardNotFound(String),

    #[error("Health check failed for backend {backend}: {reason}")]
    HealthCheckFailed { backend: String, reason: String },

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Connection error: {0}")]
    Connection(String),

    #[error("Timeout after {ms}ms")]
    Timeout { ms: u64 },

    #[error("Circuit breaker open for backend: {0}")]
    CircuitBreakerOpen(String),

    #[error("Rate limit exceeded for key: {0}")]
    RateLimitExceeded(String),

    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    #[error("Proxy error: {0}")]
    Proxy(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

pub type LbResult<T> = Result<T, LbError>;
