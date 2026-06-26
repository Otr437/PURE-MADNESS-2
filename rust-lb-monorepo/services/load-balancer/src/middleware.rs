use dashmap::DashMap;
use lb_core::config::RateLimitConfig;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::warn;

/// Token-bucket rate limiter keyed per client (IP, header value, or "global").
#[derive(Debug)]
pub struct RateLimiter {
    config: RateLimitConfig,
    buckets: Arc<DashMap<String, TokenBucket>>,
}

#[derive(Debug, Clone)]
struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(burst_size: u32) -> Self {
        Self {
            tokens: burst_size as f64,
            last_refill: Instant::now(),
        }
    }

    fn try_consume(&mut self, rate_per_second: f64, burst_size: f64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();

        // Refill tokens based on elapsed time
        self.tokens = (self.tokens + elapsed * rate_per_second).min(burst_size);
        self.last_refill = now;

        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            buckets: Arc::new(DashMap::new()),
        }
    }

    /// Returns true if the request is allowed, false if rate-limited.
    pub fn check(&self, key: &str) -> bool {
        let rate = self.config.requests_per_second as f64;
        let burst = self.config.burst_size as f64;

        let mut bucket = self
            .buckets
            .entry(key.to_owned())
            .or_insert_with(|| TokenBucket::new(self.config.burst_size));

        let allowed = bucket.try_consume(rate, burst);
        if !allowed {
            warn!(key = %key, "Rate limit exceeded");
        }
        allowed
    }

    /// Periodically evict stale buckets to prevent unbounded memory growth.
    /// Call this from a background task every few minutes.
    pub fn evict_stale(&self, max_idle: Duration) {
        self.buckets.retain(|_, bucket| {
            bucket.last_refill.elapsed() < max_idle
        });
    }
}
