import Database from 'better-sqlite3';
import { config } from './config.js';
import fs from 'fs';
import path from 'path';

let db;

export function initDatabase() {
  // Ensure data directory exists
  const dataDir = path.dirname(config.databasePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  
  // Create tables
  db.exec(`
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
    
    CREATE INDEX IF NOT EXISTS idx_attack_logs_timestamp ON attack_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_attack_logs_ip ON attack_logs(ip_address);
    CREATE INDEX IF NOT EXISTS idx_attack_logs_type ON attack_logs(attack_type);
    
    CREATE TABLE IF NOT EXISTS blocked_ips (
      ip_address TEXT PRIMARY KEY,
      blocked_at INTEGER NOT NULL,
      unblock_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      block_count INTEGER NOT NULL DEFAULT 1
    );
    
    CREATE TABLE IF NOT EXISTS whitelist (
      ip_address TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL,
      reason TEXT NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS custom_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      action TEXT NOT NULL,
      conditions TEXT NOT NULL,
      ban_duration INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  
  console.log('✓ Database initialized');
}

export function getDatabase() {
  return db;
}

// Attack Logging
export function logAttackToDb(attack) {
  const stmt = db.prepare(`
    INSERT INTO attack_logs (
      timestamp, ip_address, attack_type, severity, 
      request_method, request_path, user_agent, payload, blocked, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    Math.floor(Date.now() / 1000),
    attack.ip,
    attack.attackType,
    attack.severity,
    attack.method,
    attack.path,
    attack.userAgent,
    attack.payload || '',
    attack.blocked ? 1 : 0,
    attack.details || ''
  );
}

// IP Blocking
export function blockIp(ip, reason, duration) {
  const now = Math.floor(Date.now() / 1000);
  const unblockAt = now + duration;
  
  const existing = db.prepare('SELECT block_count FROM blocked_ips WHERE ip_address = ?').get(ip);
  const blockCount = existing ? existing.block_count + 1 : 1;
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO blocked_ips (ip_address, blocked_at, unblock_at, reason, block_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  
  stmt.run(ip, now, unblockAt, reason, blockCount);
}

export function isBlocked(ip) {
  const stmt = db.prepare('SELECT * FROM blocked_ips WHERE ip_address = ?');
  return stmt.get(ip);
}

export function getBlockedIps() {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare('SELECT * FROM blocked_ips WHERE unblock_at > ?');
  return stmt.all(now);
}

export function clearBlocks() {
  db.prepare('DELETE FROM blocked_ips').run();
}

// Whitelist
export function isWhitelisted(ip) {
  const stmt = db.prepare('SELECT * FROM whitelist WHERE ip_address = ?');
  return stmt.get(ip) !== undefined;
}

export function addToWhitelist(ip, reason) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO whitelist (ip_address, added_at, reason)
    VALUES (?, ?, ?)
  `);
  stmt.run(ip, Math.floor(Date.now() / 1000), reason);
}

export function removeFromWhitelist(ip) {
  const stmt = db.prepare('DELETE FROM whitelist WHERE ip_address = ?');
  stmt.run(ip);
}

export function getWhitelist() {
  const stmt = db.prepare('SELECT * FROM whitelist');
  return stmt.all();
}

// Attack Logs
export function getAttackLogs(limit = 100) {
  const stmt = db.prepare(`
    SELECT * FROM attack_logs 
    ORDER BY id DESC 
    LIMIT ?
  `);
  return stmt.all(limit);
}

// Custom Rules
export function saveRule(rule) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO custom_rules 
    (id, name, description, enabled, action, conditions, ban_duration, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    rule.id,
    rule.name,
    rule.description || '',
    rule.enabled ? 1 : 0,
    rule.action,
    JSON.stringify(rule.conditions),
    rule.banDuration || config.attackBanDuration,
    rule.createdAt || now,
    now
  );
}

export function getRules() {
  const stmt = db.prepare('SELECT * FROM custom_rules');
  const rows = stmt.all();
  
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    action: row.action,
    conditions: JSON.parse(row.conditions),
    banDuration: row.ban_duration,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function deleteRule(id) {
  const stmt = db.prepare('DELETE FROM custom_rules WHERE id = ?');
  stmt.run(id);
}

// Stats
export function getStats() {
  const totalAttacks = db.prepare('SELECT COUNT(*) as count FROM attack_logs').get().count;
  const blockedIps = db.prepare('SELECT COUNT(*) as count FROM blocked_ips WHERE unblock_at > ?')
    .get(Math.floor(Date.now() / 1000)).count;
  const whitelistCount = db.prepare('SELECT COUNT(*) as count FROM whitelist').get().count;
  
  return {
    totalAttacks,
    blockedIps,
    whitelistCount
  };
}
