use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct BackendId(pub String);

impl BackendId {
    pub fn new(host: &str, port: u16) -> Self {
        Self(format!("{}:{}", host, port))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for BackendId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum BackendStatus {
    Healthy,
    Unhealthy,
    Draining,
    Unknown,
}

impl std::fmt::Display for BackendStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackendStatus::Healthy => write!(f, "healthy"),
            BackendStatus::Unhealthy => write!(f, "unhealthy"),
            BackendStatus::Draining => write!(f, "draining"),
            BackendStatus::Unknown => write!(f, "unknown"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendStats {
    pub active_connections: u64,
    pub total_requests: u64,
    pub total_errors: u64,
    pub total_bytes_sent: u64,
    pub total_bytes_received: u64,
    pub avg_latency_ms: f64,
    pub p99_latency_ms: f64,
    pub last_success: Option<DateTime<Utc>>,
    pub last_failure: Option<DateTime<Utc>>,
}

impl Default for BackendStats {
    fn default() -> Self {
        Self {
            active_connections: 0,
            total_requests: 0,
            total_errors: 0,
            total_bytes_sent: 0,
            total_bytes_received: 0,
            avg_latency_ms: 0.0,
            p99_latency_ms: 0.0,
            last_success: None,
            last_failure: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestContext {
    pub request_id: Uuid,
    pub correlation_id: Option<String>,
    pub client_ip: String,
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body_size: Option<usize>,
    pub timestamp: DateTime<Utc>,
}

impl RequestContext {
    pub fn new(client_ip: String, method: String, path: String) -> Self {
        Self {
            request_id: Uuid::new_v4(),
            correlation_id: None,
            client_ip,
            method,
            path,
            headers: Vec::new(),
            body_size: None,
            timestamp: Utc::now(),
        }
    }

    pub fn with_correlation_id(mut self, id: String) -> Self {
        self.correlation_id = Some(id);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardId(pub u32);

impl ShardId {
    pub fn new(id: u32) -> Self {
        Self(id)
    }

    pub fn value(&self) -> u32 {
        self.0
    }
}

impl std::fmt::Display for ShardId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "shard-{}", self.0)
    }
}
