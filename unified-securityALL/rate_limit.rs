use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use crate::config::WafConfig;

#[derive(Clone)]
pub struct RateLimiter {
    config: Arc<WafConfig>,
    windows: Arc<RwLock<HashMap<String, RateLimitWindow>>>,
}

#[derive(Debug, Clone)]
struct RateLimitWindow {
    requests: Vec<u64>,
    last_cleanup: u64,
}

impl RateLimiter {
    pub fn new(config: Arc<WafConfig>) -> Self {
        Self {
            config,
            windows: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    pub async fn check_rate_limit(&self, ip: &str) -> bool {
        if !self.config.enable_rate_limiting {
            return true;
        }
        
        let now = current_timestamp();
        let window_start = now - self.config.rate_limit_window;
        
        let mut windows = self.windows.write().await;
        
        let window = windows.entry(ip.to_string()).or_insert(RateLimitWindow {
            requests: Vec::new(),
            last_cleanup: now,
        });
        
        // Clean old requests
        window.requests.retain(|&ts| ts > window_start);
        
        // Check if limit exceeded
        if window.requests.len() >= self.config.rate_limit_requests as usize {
            return false;
        }
        
        // Add current request
        window.requests.push(now);
        window.last_cleanup = now;
        
        // Periodic cleanup of old windows
        if windows.len() > 10000 {
            windows.retain(|_, w| w.last_cleanup > window_start);
        }
        
        true
    }
    
    pub async fn get_rate_limit_status(&self, ip: &str) -> RateLimitStatus {
        let now = current_timestamp();
        let window_start = now - self.config.rate_limit_window;
        
        let windows = self.windows.read().await;
        
        if let Some(window) = windows.get(ip) {
            let request_count = window.requests.iter().filter(|&&ts| ts > window_start).count();
            
            RateLimitStatus {
                requests_made: request_count as u32,
                requests_allowed: self.config.rate_limit_requests,
                window_seconds: self.config.rate_limit_window,
                reset_at: window_start + self.config.rate_limit_window,
            }
        } else {
            RateLimitStatus {
                requests_made: 0,
                requests_allowed: self.config.rate_limit_requests,
                window_seconds: self.config.rate_limit_window,
                reset_at: now + self.config.rate_limit_window,
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct RateLimitStatus {
    pub requests_made: u32,
    pub requests_allowed: u32,
    pub window_seconds: u64,
    pub reset_at: u64,
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_rate_limiting() {
        let mut config = WafConfig::default();
        config.rate_limit_requests = 3;
        config.rate_limit_window = 10;
        config.enable_rate_limiting = true;
        
        let limiter = RateLimiter::new(Arc::new(config));
        
        // First 3 requests should pass
        assert!(limiter.check_rate_limit("192.168.1.1").await);
        assert!(limiter.check_rate_limit("192.168.1.1").await);
        assert!(limiter.check_rate_limit("192.168.1.1").await);
        
        // 4th request should fail
        assert!(!limiter.check_rate_limit("192.168.1.1").await);
        
        // Different IP should not be affected
        assert!(limiter.check_rate_limit("192.168.1.2").await);
    }
}
