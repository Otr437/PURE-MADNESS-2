use crate::{
    backend::Backend,
    error::{LbError, LbResult},
    types::RequestContext,
};
use async_trait::async_trait;
use rand::Rng;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

/// Core selection trait — every load-balancing algorithm implements this.
#[async_trait]
pub trait SelectionAlgorithm: Send + Sync + std::fmt::Debug {
    /// Select one backend from the provided list for the given request.
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>>;

    /// Algorithm name for logging and metrics.
    fn name(&self) -> &'static str;
}

/// Round-robin: distributes requests evenly in sequence.
#[derive(Debug)]
pub struct RoundRobin {
    counter: AtomicUsize,
}

impl RoundRobin {
    pub fn new() -> Self {
        Self {
            counter: AtomicUsize::new(0),
        }
    }
}

impl Default for RoundRobin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SelectionAlgorithm for RoundRobin {
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        _ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>> {
        let healthy: Vec<&Arc<Backend>> = backends.iter().filter(|b| b.is_healthy()).collect();
        if healthy.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }
        let idx = self.counter.fetch_add(1, Ordering::Relaxed) % healthy.len();
        Ok(healthy[idx])
    }

    fn name(&self) -> &'static str {
        "round_robin"
    }
}

/// Weighted round-robin: higher-weight backends receive proportionally more requests.
#[derive(Debug)]
pub struct WeightedRoundRobin {
    counter: AtomicUsize,
}

impl WeightedRoundRobin {
    pub fn new() -> Self {
        Self {
            counter: AtomicUsize::new(0),
        }
    }
}

impl Default for WeightedRoundRobin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SelectionAlgorithm for WeightedRoundRobin {
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        _ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>> {
        let healthy: Vec<&Arc<Backend>> = backends.iter().filter(|b| b.is_healthy()).collect();
        if healthy.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }
        // Build expanded weighted list indices
        let total_weight: u32 = healthy.iter().map(|b| b.config.weight).sum();
        if total_weight == 0 {
            return Err(LbError::Config("All backend weights are zero".into()));
        }
        let pos = self.counter.fetch_add(1, Ordering::Relaxed) % total_weight as usize;
        let mut cumulative: usize = 0;
        for backend in &healthy {
            cumulative += backend.config.weight as usize;
            if pos < cumulative {
                return Ok(backend);
            }
        }
        // Fallback — should never be reached with correct weight sum
        Ok(healthy[0])
    }

    fn name(&self) -> &'static str {
        "weighted_round_robin"
    }
}

/// Least connections: routes to the backend with the fewest active connections.
#[derive(Debug, Default)]
pub struct LeastConnections;

#[async_trait]
impl SelectionAlgorithm for LeastConnections {
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        _ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>> {
        let healthy: Vec<&Arc<Backend>> = backends.iter().filter(|b| b.is_healthy()).collect();
        if healthy.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }
        healthy
            .into_iter()
            .min_by_key(|b| b.active_connections())
            .ok_or(LbError::NoHealthyBackends)
    }

    fn name(&self) -> &'static str {
        "least_connections"
    }
}

/// Weighted least connections: combines weight and active connection count.
#[derive(Debug, Default)]
pub struct WeightedLeastConnections;

#[async_trait]
impl SelectionAlgorithm for WeightedLeastConnections {
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        _ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>> {
        let healthy: Vec<&Arc<Backend>> = backends.iter().filter(|b| b.is_healthy()).collect();
        if healthy.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }
        // Score = active_connections / weight — lower is better
        healthy
            .into_iter()
            .min_by(|a, b| {
                let score_a = if a.config.weight == 0 {
                    f64::MAX
                } else {
                    a.active_connections() as f64 / a.config.weight as f64
                };
                let score_b = if b.config.weight == 0 {
                    f64::MAX
                } else {
                    b.active_connections() as f64 / b.config.weight as f64
                };
                score_a
                    .partial_cmp(&score_b)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .ok_or(LbError::NoHealthyBackends)
    }

    fn name(&self) -> &'static str {
        "weighted_least_connections"
    }
}

/// Random: selects a random healthy backend uniformly.
#[derive(Debug, Default)]
pub struct Random;

#[async_trait]
impl SelectionAlgorithm for Random {
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        _ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>> {
        let healthy: Vec<&Arc<Backend>> = backends.iter().filter(|b| b.is_healthy()).collect();
        if healthy.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }
        let idx = rand::thread_rng().gen_range(0..healthy.len());
        Ok(healthy[idx])
    }

    fn name(&self) -> &'static str {
        "random"
    }
}

/// IP hash: consistent routing per client IP — same client always hits the same backend.
#[derive(Debug, Default)]
pub struct IpHash;

impl IpHash {
    fn hash_ip(&self, ip: &str) -> u64 {
        let mut hasher = Sha256::new();
        hasher.update(ip.as_bytes());
        let result = hasher.finalize();
        // Use first 8 bytes of SHA-256 as u64
        u64::from_le_bytes(result[..8].try_into().unwrap_or([0u8; 8]))
    }
}

#[async_trait]
impl SelectionAlgorithm for IpHash {
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>> {
        let healthy: Vec<&Arc<Backend>> = backends.iter().filter(|b| b.is_healthy()).collect();
        if healthy.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }
        let hash = self.hash_ip(&ctx.client_ip);
        let idx = (hash % healthy.len() as u64) as usize;
        Ok(healthy[idx])
    }

    fn name(&self) -> &'static str {
        "ip_hash"
    }
}

/// URL hash: routes based on the request path — useful for cache affinity.
#[derive(Debug, Default)]
pub struct UrlHash;

impl UrlHash {
    fn hash_url(&self, url: &str) -> u64 {
        let mut hasher = Sha256::new();
        hasher.update(url.as_bytes());
        let result = hasher.finalize();
        u64::from_le_bytes(result[..8].try_into().unwrap_or([0u8; 8]))
    }
}

#[async_trait]
impl SelectionAlgorithm for UrlHash {
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>> {
        let healthy: Vec<&Arc<Backend>> = backends.iter().filter(|b| b.is_healthy()).collect();
        if healthy.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }
        let hash = self.hash_url(&ctx.path);
        let idx = (hash % healthy.len() as u64) as usize;
        Ok(healthy[idx])
    }

    fn name(&self) -> &'static str {
        "url_hash"
    }
}

/// Least response time: routes to the backend with the lowest average latency.
#[derive(Debug, Default)]
pub struct LeastResponseTime;

#[async_trait]
impl SelectionAlgorithm for LeastResponseTime {
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        _ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>> {
        let healthy: Vec<&Arc<Backend>> = backends.iter().filter(|b| b.is_healthy()).collect();
        if healthy.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }
        healthy
            .into_iter()
            .min_by(|a, b| {
                let lat_a = a.stats().avg_latency_ms;
                let lat_b = b.stats().avg_latency_ms;
                // If no data yet (0.0), treat as equally good
                lat_a
                    .partial_cmp(&lat_b)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .ok_or(LbError::NoHealthyBackends)
    }

    fn name(&self) -> &'static str {
        "least_response_time"
    }
}

/// Consistent hashing ring — distributes keys across virtual nodes for minimal
/// reshuffling when backends are added or removed.
#[derive(Debug)]
pub struct ConsistentHashRing {
    virtual_nodes: u32,
}

impl ConsistentHashRing {
    pub fn new(virtual_nodes: u32) -> Self {
        Self { virtual_nodes }
    }

    fn hash_key(&self, key: &str) -> u64 {
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        let result = hasher.finalize();
        u64::from_le_bytes(result[..8].try_into().unwrap_or([0u8; 8]))
    }

    /// Build a sorted ring of (hash_value, backend_index) for the current healthy set.
    fn build_ring<'a>(&self, backends: &'a [Arc<Backend>]) -> Vec<(u64, usize)> {
        let mut ring: Vec<(u64, usize)> = Vec::new();
        for (idx, backend) in backends.iter().enumerate() {
            for vn in 0..self.virtual_nodes {
                let key = format!("{}#{}", backend.id.as_str(), vn);
                ring.push((self.hash_key(&key), idx));
            }
        }
        ring.sort_unstable_by_key(|(h, _)| *h);
        ring
    }
}

#[async_trait]
impl SelectionAlgorithm for ConsistentHashRing {
    async fn select<'a>(
        &self,
        backends: &'a [Arc<Backend>],
        ctx: &RequestContext,
    ) -> LbResult<&'a Arc<Backend>> {
        let healthy: Vec<(usize, &Arc<Backend>)> = backends
            .iter()
            .enumerate()
            .filter(|(_, b)| b.is_healthy())
            .collect();
        if healthy.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }

        let ring = self.build_ring(backends);
        let request_hash = self.hash_key(&ctx.client_ip);

        // Find the first ring entry >= request_hash (wrap around)
        let entry = ring
            .iter()
            .find(|(h, _)| *h >= request_hash)
            .or_else(|| ring.first());

        match entry {
            Some((_, backend_idx)) => {
                let backend = &backends[*backend_idx];
                if backend.is_healthy() {
                    return Ok(backend);
                }
                // Walk the ring to find next healthy backend
                let start_pos = ring
                    .iter()
                    .position(|(_, idx)| idx == backend_idx)
                    .unwrap_or(0);
                for i in 1..ring.len() {
                    let pos = (start_pos + i) % ring.len();
                    let candidate = &backends[ring[pos].1];
                    if candidate.is_healthy() {
                        return Ok(candidate);
                    }
                }
                Err(LbError::NoHealthyBackends)
            }
            None => Err(LbError::NoHealthyBackends),
        }
    }

    fn name(&self) -> &'static str {
        "consistent_hash"
    }
}

/// Discriminated union of all algorithm variants for config-driven selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlgorithmKind {
    RoundRobin,
    WeightedRoundRobin,
    LeastConnections,
    WeightedLeastConnections,
    Random,
    IpHash,
    UrlHash,
    LeastResponseTime,
    ConsistentHash { virtual_nodes: u32 },
}

use serde::{Deserialize, Serialize};

impl AlgorithmKind {
    pub fn into_algorithm(self) -> Arc<dyn SelectionAlgorithm> {
        match self {
            AlgorithmKind::RoundRobin => Arc::new(RoundRobin::new()),
            AlgorithmKind::WeightedRoundRobin => Arc::new(WeightedRoundRobin::new()),
            AlgorithmKind::LeastConnections => Arc::new(LeastConnections),
            AlgorithmKind::WeightedLeastConnections => Arc::new(WeightedLeastConnections),
            AlgorithmKind::Random => Arc::new(Random),
            AlgorithmKind::IpHash => Arc::new(IpHash),
            AlgorithmKind::UrlHash => Arc::new(UrlHash),
            AlgorithmKind::LeastResponseTime => Arc::new(LeastResponseTime),
            AlgorithmKind::ConsistentHash { virtual_nodes } => {
                Arc::new(ConsistentHashRing::new(virtual_nodes))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::BackendConfig;
    use crate::types::BackendStatus;
    use std::sync::Arc;

    fn make_backend(host: &str, port: u16, weight: u32, healthy: bool) -> Arc<Backend> {
        let b = Arc::new(Backend::new(BackendConfig {
            host: host.to_string(),
            port,
            weight,
            max_connections: None,
            connect_timeout_ms: 1000,
            request_timeout_ms: 5000,
            tls: false,
            tls_verify: false,
        }));
        if healthy {
            b.set_status(BackendStatus::Healthy);
        } else {
            b.set_status(BackendStatus::Unhealthy);
        }
        b
    }

    fn ctx() -> RequestContext {
        RequestContext::new("192.168.1.1".into(), "GET".into(), "/api/v1/test".into())
    }

    #[tokio::test]
    async fn round_robin_distributes_evenly() {
        let backends = vec![
            make_backend("10.0.0.1", 8080, 1, true),
            make_backend("10.0.0.2", 8080, 1, true),
            make_backend("10.0.0.3", 8080, 1, true),
        ];
        let rr = RoundRobin::new();
        let mut counts = [0u32; 3];
        for _ in 0..30 {
            let selected = rr.select(&backends, &ctx()).await.unwrap();
            let idx = backends
                .iter()
                .position(|b| Arc::ptr_eq(b, selected))
                .unwrap();
            counts[idx] += 1;
        }
        assert!(counts.iter().all(|&c| c == 10));
    }

    #[tokio::test]
    async fn round_robin_skips_unhealthy() {
        let backends = vec![
            make_backend("10.0.0.1", 8080, 1, false),
            make_backend("10.0.0.2", 8080, 1, true),
            make_backend("10.0.0.3", 8080, 1, false),
        ];
        let rr = RoundRobin::new();
        for _ in 0..10 {
            let selected = rr.select(&backends, &ctx()).await.unwrap();
            assert_eq!(selected.config.host, "10.0.0.2");
        }
    }

    #[tokio::test]
    async fn round_robin_returns_error_when_no_healthy() {
        let backends = vec![make_backend("10.0.0.1", 8080, 1, false)];
        let rr = RoundRobin::new();
        let result = rr.select(&backends, &ctx()).await;
        assert!(matches!(result, Err(LbError::NoHealthyBackends)));
    }

    #[tokio::test]
    async fn least_connections_picks_lowest() {
        let backends = vec![
            make_backend("10.0.0.1", 8080, 1, true),
            make_backend("10.0.0.2", 8080, 1, true),
            make_backend("10.0.0.3", 8080, 1, true),
        ];
        backends[0].increment_connections();
        backends[0].increment_connections();
        backends[1].increment_connections();
        // backends[2] has 0 — should be selected
        let lc = LeastConnections;
        let selected = lc.select(&backends, &ctx()).await.unwrap();
        assert_eq!(selected.config.host, "10.0.0.3");
    }

    #[tokio::test]
    async fn ip_hash_is_deterministic() {
        let backends = vec![
            make_backend("10.0.0.1", 8080, 1, true),
            make_backend("10.0.0.2", 8080, 1, true),
            make_backend("10.0.0.3", 8080, 1, true),
        ];
        let algo = IpHash;
        let first = algo.select(&backends, &ctx()).await.unwrap();
        let first_id = first.id.clone();
        for _ in 0..20 {
            let selected = algo.select(&backends, &ctx()).await.unwrap();
            assert_eq!(selected.id, first_id);
        }
    }

    #[tokio::test]
    async fn weighted_rr_respects_weights() {
        let backends = vec![
            make_backend("10.0.0.1", 8080, 3, true),
            make_backend("10.0.0.2", 8080, 1, true),
        ];
        let wrr = WeightedRoundRobin::new();
        let mut counts = std::collections::HashMap::new();
        for _ in 0..40 {
            let s = wrr.select(&backends, &ctx()).await.unwrap();
            *counts.entry(s.config.host.clone()).or_insert(0u32) += 1;
        }
        assert_eq!(*counts.get("10.0.0.1").unwrap_or(&0), 30);
        assert_eq!(*counts.get("10.0.0.2").unwrap_or(&0), 10);
    }

    #[tokio::test]
    async fn consistent_hash_routes_same_ip_to_same_backend() {
        let backends = vec![
            make_backend("10.0.0.1", 8080, 1, true),
            make_backend("10.0.0.2", 8080, 1, true),
            make_backend("10.0.0.3", 8080, 1, true),
        ];
        let ch = ConsistentHashRing::new(150);
        let first = ch.select(&backends, &ctx()).await.unwrap();
        let first_id = first.id.clone();
        for _ in 0..20 {
            let s = ch.select(&backends, &ctx()).await.unwrap();
            assert_eq!(s.id, first_id);
        }
    }
}
