use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WafConfig {
    // Server
    pub port: u16,
    pub workers: usize,
    
    // Database
    pub database_url: String,
    
    // Rate Limiting
    pub rate_limit_requests: u32,
    pub rate_limit_window: u64,
    pub rate_limit_ban_duration: u64,
    
    // Brute Force
    pub login_max_attempts: u32,
    pub login_attempt_window: u64,
    pub login_ban_duration: u64,
    
    // Request Limits
    pub max_request_size: usize,
    pub max_header_size: usize,
    pub max_url_length: usize,
    
    // Attack Response
    pub attack_ban_duration: u64,
    
    // Backends (for proxying)
    pub backends: Vec<Backend>,
    
    // Features
    pub enable_geoip: bool,
    pub enable_bot_detection: bool,
    pub enable_rate_limiting: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Backend {
    pub name: String,
    pub url: String,
    pub path_prefix: String,
}

impl WafConfig {
    pub fn load() -> anyhow::Result<Self> {
        // Try to load from config file first
        if let Ok(contents) = fs::read_to_string("config.toml") {
            return Ok(toml::from_str(&contents)?);
        }
        
        // Fall back to defaults
        Ok(Self::default())
    }
}

impl Default for WafConfig {
    fn default() -> Self {
        Self {
            port: 8080,
            workers: num_cpus::get(),
            database_url: "sqlite://waf_data.db".to_string(),
            rate_limit_requests: 100,
            rate_limit_window: 60,
            rate_limit_ban_duration: 300,
            login_max_attempts: 5,
            login_attempt_window: 300,
            login_ban_duration: 900,
            max_request_size: 10 * 1024 * 1024, // 10MB
            max_header_size: 8192,
            max_url_length: 2048,
            attack_ban_duration: 3600, // 1 hour
            backends: vec![
                Backend {
                    name: "default".to_string(),
                    url: "http://localhost:3000".to_string(),
                    path_prefix: "/".to_string(),
                }
            ],
            enable_geoip: false,
            enable_bot_detection: true,
            enable_rate_limiting: true,
        }
    }
}
