use crate::{
    algorithm::AlgorithmKind,
    backend::BackendConfig,
    health::HealthCheckConfig,
    shard::ShardStrategy,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LbConfig {
    pub server: ServerConfig,
    pub backends: Vec<BackendConfig>,
    pub algorithm: AlgorithmKind,
    pub health_check: HealthCheckConfig,
    pub sharding: Option<ShardingConfig>,
    pub rate_limit: Option<RateLimitConfig>,
    pub tls: Option<TlsConfig>,
    pub observability: ObservabilityConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub bind_addr: String,
    pub port: u16,
    pub admin_port: u16,
    pub max_connections: usize,
    pub request_timeout_ms: u64,
    pub keepalive_secs: u64,
    pub graceful_shutdown_timeout_secs: u64,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_addr: "0.0.0.0".to_string(),
            port: 8080,
            admin_port: 9090,
            max_connections: 10_000,
            request_timeout_ms: 30_000,
            keepalive_secs: 75,
            graceful_shutdown_timeout_secs: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardingConfig {
    pub enabled: bool,
    pub key_header: String,
    pub strategy: ShardStrategy,
    pub shards: Vec<ShardDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardDef {
    pub id: u32,
    pub backend_ids: Vec<String>,
    pub replica_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitConfig {
    pub enabled: bool,
    pub requests_per_second: u32,
    pub burst_size: u32,
    pub key_strategy: RateLimitKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RateLimitKey {
    ClientIp,
    Header(String),
    Global,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlsConfig {
    pub enabled: bool,
    pub cert_path: String,
    pub key_path: String,
    pub ca_path: Option<String>,
    pub min_version: TlsVersion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TlsVersion {
    Tls12,
    Tls13,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservabilityConfig {
    pub metrics_enabled: bool,
    pub metrics_path: String,
    pub tracing_enabled: bool,
    pub tracing_endpoint: Option<String>,
    pub log_level: String,
    pub log_format: LogFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogFormat {
    Json,
    Pretty,
}

impl Default for ObservabilityConfig {
    fn default() -> Self {
        Self {
            metrics_enabled: true,
            metrics_path: "/metrics".to_string(),
            tracing_enabled: false,
            tracing_endpoint: None,
            log_level: "info".to_string(),
            log_format: LogFormat::Json,
        }
    }
}
