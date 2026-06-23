-- Initial WAF database schema
CREATE TABLE IF NOT EXISTS attack_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    ip_address TEXT NOT NULL,
    attack_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    request_method TEXT NOT NULL,
    request_path TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    payload TEXT,
    blocked INTEGER NOT NULL,
    details TEXT
);

CREATE TABLE IF NOT EXISTS blocked_ips (
    ip_address TEXT PRIMARY KEY,
    blocked_at INTEGER NOT NULL,
    unblock_at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    block_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS whitelist (
    ip_address TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    ip_address TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_time REAL NOT NULL
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_attack_logs_timestamp ON attack_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_attack_logs_ip ON attack_logs(ip_address);
CREATE INDEX IF NOT EXISTS idx_attack_logs_type ON attack_logs(attack_type);
CREATE INDEX IF NOT EXISTS idx_request_stats_timestamp ON request_stats(timestamp);
CREATE INDEX IF NOT EXISTS idx_request_stats_ip ON request_stats(ip_address);
