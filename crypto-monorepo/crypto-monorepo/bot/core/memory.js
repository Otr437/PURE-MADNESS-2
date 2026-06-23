'use strict';

/**
 * bot/core/memory.js
 * Persistent conversation memory — append-only JSONL on disk.
 *
 * Each record: { id, ts, role, content, goalId?, tags? }
 *
 * Supports:
 *   - append(role, content, meta)   — write a new message
 *   - search(query)                 — naive substring search over content
 *   - recent(n)                     — last N messages
 *   - summarize()                   — compact stats
 *   - clear()                       — wipe memory file
 *
 * Pure Node.js — no external deps, no vector DB, no npm packages.
 */

const fs     = require('fs');
const crypto = require('crypto');
const CONFIG = require('../config/config');

const MEMORY_FILE = CONFIG.memoryFile;

// ── Internal helpers ──────────────────────────────────────────────────────────

function _readAll() {
  if (!fs.existsSync(MEMORY_FILE)) return [];
  return fs.readFileSync(MEMORY_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function _write(record) {
  fs.appendFileSync(MEMORY_FILE, JSON.stringify(record) + '\n', 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Append a message to memory.
 * @param {'user'|'assistant'|'system'|'tool'} role
 * @param {string} content
 * @param {object} [meta]  Optional: { goalId, tags, action, toolResult }
 * @returns {object} The stored record.
 */
function append(role, content, meta = {}) {
  const record = {
    id:      crypto.randomBytes(6).toString('hex'),
    ts:      new Date().toISOString(),
    role,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    ...meta,
  };
  _write(record);
  return record;
}

/**
 * Return the last N records.
 * @param {number} [n=20]
 * @returns {object[]}
 */
function recent(n = 20) {
  const all = _readAll();
  return all.slice(-n);
}

/**
 * Naive full-text search over content and tags.
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {object[]}
 */
function search(query, limit = 10) {
  const q   = query.toLowerCase();
  const all = _readAll();
  return all
    .filter(r =>
      r.content.toLowerCase().includes(q) ||
      (r.tags  && r.tags.some(t => t.toLowerCase().includes(q))) ||
      (r.goalId && r.goalId.toLowerCase().includes(q))
    )
    .slice(-limit);
}

/**
 * Return a summary of the memory store.
 * @returns {{ total: number, byRole: object, oldest: string|null, newest: string|null }}
 */
function summarize() {
  const all    = _readAll();
  const byRole = {};
  for (const r of all) byRole[r.role] = (byRole[r.role] || 0) + 1;
  return {
    total:  all.length,
    byRole,
    oldest: all[0]?.ts || null,
    newest: all[all.length - 1]?.ts || null,
    filePath: MEMORY_FILE,
  };
}

/**
 * Build a context string from recent memory for injection into the system prompt.
 * @param {number} [n=10]
 * @returns {string}
 */
function buildContext(n = 10) {
  const msgs = recent(n);
  if (msgs.length === 0) return '';
  const lines = msgs.map(r => `[${r.ts}] ${r.role}: ${r.content.slice(0, 200)}`);
  return `\n## Recent conversation history (last ${msgs.length} messages)\n${lines.join('\n')}\n`;
}

/**
 * Wipe the memory file.
 */
function clear() {
  if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);
}

/**
 * Return all records (use sparingly on large files).
 * @returns {object[]}
 */
function all() { return _readAll(); }

module.exports = { append, recent, search, summarize, buildContext, clear, all };
