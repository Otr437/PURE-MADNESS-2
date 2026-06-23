'use strict';

/**
 * bot/config/config.js
 * Central configuration for the crypto agent.
 * Values are read from environment variables with safe defaults.
 * No external dependencies.
 */

const path = require('path');
const fs   = require('fs');

const ROOT     = path.resolve(__dirname, '../..');
const DATA_DIR = path.resolve(__dirname, '../data');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG = {
  // ── Anthropic API ──────────────────────────────────────────────────────────
  apiKey:       process.env.ANTHROPIC_API_KEY || '',
  model:        process.env.CRYPTO_BOT_MODEL  || 'claude-sonnet-4-20250514',
  maxTokens:    parseInt(process.env.CRYPTO_BOT_MAX_TOKENS  || '1024', 10),

  // ── Agent behaviour ────────────────────────────────────────────────────────
  maxSteps:     parseInt(process.env.CRYPTO_BOT_MAX_STEPS   || '20',   10),
  retryMax:     parseInt(process.env.CRYPTO_BOT_RETRY_MAX   || '3',    10),
  retryBaseMs:  parseInt(process.env.CRYPTO_BOT_RETRY_MS    || '500',  10),

  // ── Persistence ────────────────────────────────────────────────────────────
  sessionFile:  process.env.CRYPTO_BOT_SESSION_FILE || path.join(DATA_DIR, 'session.enc'),
  memoryFile:   process.env.CRYPTO_BOT_MEMORY_FILE  || path.join(DATA_DIR, 'memory.jsonl'),
  auditFile:    process.env.CRYPTO_BOT_AUDIT_FILE   || path.join(DATA_DIR, 'audit.jsonl'),
  schedulerFile:process.env.CRYPTO_BOT_SCHED_FILE   || path.join(DATA_DIR, 'scheduler.json'),

  // ── Session encryption passphrase (derives the session file key) ───────────
  // In production set CRYPTO_BOT_PASSPHRASE via a secrets manager.
  passphrase:   process.env.CRYPTO_BOT_PASSPHRASE   || 'default-dev-passphrase-change-me',

  // ── Logging ────────────────────────────────────────────────────────────────
  logLevel:     process.env.LOG_LEVEL               || 'info',

  // ── Scheduler ─────────────────────────────────────────────────────────────
  schedulerTickMs: parseInt(process.env.CRYPTO_BOT_SCHED_TICK || '60000', 10), // 1 min

  // ── Multi-agent / peer ─────────────────────────────────────────────────────
  peerHost:     process.env.CRYPTO_BOT_PEER_HOST    || '127.0.0.1',
  peerPort:     parseInt(process.env.CRYPTO_BOT_PEER_PORT    || '9876',  10),

  // ── Paths ──────────────────────────────────────────────────────────────────
  dataDir:      DATA_DIR,
  rootDir:      ROOT,
};

// Validation warnings (non-fatal)
if (!CONFIG.apiKey)       process.stderr.write('[config] WARNING: ANTHROPIC_API_KEY not set\n');
if (CONFIG.passphrase === 'default-dev-passphrase-change-me')
  process.stderr.write('[config] WARNING: using default passphrase — set CRYPTO_BOT_PASSPHRASE in production\n');

module.exports = CONFIG;
