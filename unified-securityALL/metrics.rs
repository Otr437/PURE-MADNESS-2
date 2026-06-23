use prometheus::{
    Counter, Histogram, HistogramOpts, IntCounter, IntGauge, Opts, Registry,
};
use std::sync::Arc;

pub struct WafMetrics {
    pub registry: Registry,
    
    // Request counters
    pub requests_total: IntCounter,
    pub requests_allowed: IntCounter,
    pub requests_blocked: IntCounter,
    
    // Attack type counters
    pub sql_injection_blocked: IntCounter,
    pub xss_blocked: IntCounter,
    pub path_traversal_blocked: IntCounter,
    pub command_injection_blocked: IntCounter,
    pub xxe_blocked: IntCounter,
    pub ssrf_blocked: IntCounter,
    
    // Rate limiting
    pub rate_limits_triggered: IntCounter,
    pub custom_rules_triggered: IntCounter,
    
    // Response time
    pub response_time: Histogram,
    
    // Active connections
    pub active_blocks: IntGauge,
}

impl WafMetrics {
    pub fn new() -> Self {
        let registry = Registry::new();
        
        let requests_total = IntCounter::with_opts(
            Opts::new("waf_requests_total", "Total number of requests processed")
        ).unwrap();
        
        let requests_allowed = IntCounter::with_opts(
            Opts::new("waf_requests_allowed", "Number of requests allowed through")
        ).unwrap();
        
        let requests_blocked = IntCounter::with_opts(
            Opts::new("waf_requests_blocked", "Number of requests blocked")
        ).unwrap();
        
        let sql_injection_blocked = IntCounter::with_opts(
            Opts::new("waf_sql_injection_blocked", "SQL injection attacks blocked")
        ).unwrap();
        
        let xss_blocked = IntCounter::with_opts(
            Opts::new("waf_xss_blocked", "XSS attacks blocked")
        ).unwrap();
        
        let path_traversal_blocked = IntCounter::with_opts(
            Opts::new("waf_path_traversal_blocked", "Path traversal attacks blocked")
        ).unwrap();
        
        let command_injection_blocked = IntCounter::with_opts(
            Opts::new("waf_command_injection_blocked", "Command injection attacks blocked")
        ).unwrap();
        
        let xxe_blocked = IntCounter::with_opts(
            Opts::new("waf_xxe_blocked", "XXE attacks blocked")
        ).unwrap();
        
        let ssrf_blocked = IntCounter::with_opts(
            Opts::new("waf_ssrf_blocked", "SSRF attacks blocked")
        ).unwrap();
        
        let rate_limits_triggered = IntCounter::with_opts(
            Opts::new("waf_rate_limits_triggered", "Rate limits triggered")
        ).unwrap();
        
        let custom_rules_triggered = IntCounter::with_opts(
            Opts::new("waf_custom_rules_triggered", "Custom rules triggered")
        ).unwrap();
        
        let response_time = Histogram::with_opts(
            HistogramOpts::new("waf_response_time_seconds", "Response time in seconds")
        ).unwrap();
        
        let active_blocks = IntGauge::with_opts(
            Opts::new("waf_active_blocks", "Number of currently blocked IPs")
        ).unwrap();
        
        // Register all metrics
        registry.register(Box::new(requests_total.clone())).unwrap();
        registry.register(Box::new(requests_allowed.clone())).unwrap();
        registry.register(Box::new(requests_blocked.clone())).unwrap();
        registry.register(Box::new(sql_injection_blocked.clone())).unwrap();
        registry.register(Box::new(xss_blocked.clone())).unwrap();
        registry.register(Box::new(path_traversal_blocked.clone())).unwrap();
        registry.register(Box::new(command_injection_blocked.clone())).unwrap();
        registry.register(Box::new(xxe_blocked.clone())).unwrap();
        registry.register(Box::new(ssrf_blocked.clone())).unwrap();
        registry.register(Box::new(rate_limits_triggered.clone())).unwrap();
        registry.register(Box::new(custom_rules_triggered.clone())).unwrap();
        registry.register(Box::new(response_time.clone())).unwrap();
        registry.register(Box::new(active_blocks.clone())).unwrap();
        
        Self {
            registry,
            requests_total,
            requests_allowed,
            requests_blocked,
            sql_injection_blocked,
            xss_blocked,
            path_traversal_blocked,
            command_injection_blocked,
            xxe_blocked,
            ssrf_blocked,
            rate_limits_triggered,
            custom_rules_triggered,
            response_time,
            active_blocks,
        }
    }
}
