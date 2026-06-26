use crate::types::{BackendId, BackendStats, BackendStatus};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendConfig {
    pub host: String,
    pub port: u16,
    pub weight: u32,
    pub max_connections: Option<u32>,
    pub connect_timeout_ms: u64,
    pub request_timeout_ms: u64,
    pub tls: bool,
    pub tls_verify: bool,
}

impl BackendConfig {
    pub fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    pub fn scheme(&self) -> &'static str {
        if self.tls {
            "https"
        } else {
            "http"
        }
    }

    pub fn base_url(&self) -> String {
        format!("{}://{}:{}", self.scheme(), self.host, self.port)
    }
}

#[derive(Debug)]
pub struct Backend {
    pub id: BackendId,
    pub config: BackendConfig,
    status: Arc<RwLock<BackendStatus>>,
    stats: Arc<RwLock<BackendStats>>,
    circuit_breaker: Arc<RwLock<CircuitBreakerState>>,
}

#[derive(Debug, Clone)]
pub struct CircuitBreakerState {
    pub state: CircuitState,
    pub failure_count: u32,
    pub success_count: u32,
    pub last_state_change: std::time::Instant,
    pub failure_threshold: u32,
    pub success_threshold: u32,
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

impl CircuitBreakerState {
    pub fn new(failure_threshold: u32, success_threshold: u32, timeout_secs: u64) -> Self {
        Self {
            state: CircuitState::Closed,
            failure_count: 0,
            success_count: 0,
            last_state_change: std::time::Instant::now(),
            failure_threshold,
            success_threshold,
            timeout_secs,
        }
    }

    pub fn record_success(&mut self) {
        match self.state {
            CircuitState::HalfOpen => {
                self.success_count += 1;
                if self.success_count >= self.success_threshold {
                    self.state = CircuitState::Closed;
                    self.failure_count = 0;
                    self.success_count = 0;
                    self.last_state_change = std::time::Instant::now();
                }
            }
            CircuitState::Closed => {
                self.failure_count = 0;
            }
            CircuitState::Open => {}
        }
    }

    pub fn record_failure(&mut self) {
        match self.state {
            CircuitState::Closed => {
                self.failure_count += 1;
                if self.failure_count >= self.failure_threshold {
                    self.state = CircuitState::Open;
                    self.last_state_change = std::time::Instant::now();
                }
            }
            CircuitState::HalfOpen => {
                self.state = CircuitState::Open;
                self.success_count = 0;
                self.last_state_change = std::time::Instant::now();
            }
            CircuitState::Open => {}
        }
    }

    pub fn is_request_allowed(&mut self) -> bool {
        match self.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                let elapsed = self.last_state_change.elapsed().as_secs();
                if elapsed >= self.timeout_secs {
                    self.state = CircuitState::HalfOpen;
                    self.success_count = 0;
                    true
                } else {
                    false
                }
            }
            CircuitState::HalfOpen => true,
        }
    }
}

impl Backend {
    pub fn new(config: BackendConfig) -> Self {
        let id = BackendId::new(&config.host, config.port);
        Self {
            id,
            circuit_breaker: Arc::new(RwLock::new(CircuitBreakerState::new(5, 2, 30))),
            config,
            status: Arc::new(RwLock::new(BackendStatus::Unknown)),
            stats: Arc::new(RwLock::new(BackendStats::default())),
        }
    }

    pub fn status(&self) -> BackendStatus {
        self.status.read().clone()
    }

    pub fn set_status(&self, status: BackendStatus) {
        *self.status.write() = status;
    }

    pub fn is_healthy(&self) -> bool {
        *self.status.read() == BackendStatus::Healthy
    }

    pub fn stats(&self) -> BackendStats {
        self.stats.read().clone()
    }

    pub fn is_circuit_open(&self) -> bool {
        !self.circuit_breaker.write().is_request_allowed()
    }

    pub fn record_success(&self, latency_ms: f64) {
        self.circuit_breaker.write().record_success();
        let mut stats = self.stats.write();
        stats.total_requests += 1;
        stats.last_success = Some(chrono::Utc::now());
        // Exponential moving average for latency
        let alpha = 0.1_f64;
        stats.avg_latency_ms = alpha * latency_ms + (1.0 - alpha) * stats.avg_latency_ms;
    }

    pub fn record_failure(&self) {
        self.circuit_breaker.write().record_failure();
        let mut stats = self.stats.write();
        stats.total_errors += 1;
        stats.last_failure = Some(chrono::Utc::now());
    }

    pub fn increment_connections(&self) {
        self.stats.write().active_connections += 1;
    }

    pub fn decrement_connections(&self) {
        let mut stats = self.stats.write();
        if stats.active_connections > 0 {
            stats.active_connections -= 1;
        }
    }

    pub fn active_connections(&self) -> u64 {
        self.stats.read().active_connections
    }
}
