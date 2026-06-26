use crate::{error::LbResult, types::BackendStatus};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthCheckConfig {
    pub interval_secs: u64,
    pub timeout_secs: u64,
    pub healthy_threshold: u32,
    pub unhealthy_threshold: u32,
    pub path: String,
    pub expected_status: u16,
    pub kind: HealthCheckKind,
}

impl Default for HealthCheckConfig {
    fn default() -> Self {
        Self {
            interval_secs: 10,
            timeout_secs: 5,
            healthy_threshold: 2,
            unhealthy_threshold: 3,
            path: "/health".to_string(),
            expected_status: 200,
            kind: HealthCheckKind::Http,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthCheckKind {
    Http,
    Tcp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthCheckResult {
    pub backend_id: String,
    pub status: BackendStatus,
    pub latency_ms: f64,
    pub error: Option<String>,
    pub checked_at: chrono::DateTime<chrono::Utc>,
}

#[async_trait]
pub trait HealthChecker: Send + Sync {
    async fn check(&self, base_url: &str, config: &HealthCheckConfig) -> LbResult<HealthCheckResult>;
}
