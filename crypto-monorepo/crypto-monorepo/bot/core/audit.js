'use strict';

/**
 * bot/core/audit.js
 * Tamper-evident append-only audit log.
 *
 * Each entry is a JSONL line:
 *   { seq, ts, event, data, prevHash, hash }
 *
 * The hash chain: hash = SHA-256(prevHash + seq + ts + event + JSON(data))
 * Any tampering with a past entry breaks all subsequent hashes.
 *
 * Pure Node.js — no external deps.
 */

const fs     = require('fs');
const crypto = require('crypto');
const path   = require('path');
const CONFIG = require('../config/config');

const AUDIT_FILE = CONFIG.auditFile;

let _seq      = 0;
let _prevHash = '0'.repeat(64); // genesis hash

// ── Load existing tail to continue the chain ──────────────────────────────────

function _init() {
  if (!fs.existsSync(AUDIT_FILE)) return;
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8')
      .split('\n').filter(Boolean);
    if (lines.length === 0) return;
    const last = JSON.parse(lines[lines.length - 1]);
    _seq      = last.seq;
    _prevHash = last.hash;
  } catch {
    // corrupted tail — log will still append, chain verification will catch it
  }
}

_init();

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Append an audit event.
 * @param {string} event  Short event name, e.g. 'key.generate', 'encrypt', 'decrypt'.
 * @param {object} data   Arbitrary metadata (no key material).
 */
function audit(event, data = {}) {
  _seq++;
  const ts      = new Date().toISOString();
  const payload = `${_prevHash}${_seq}${ts}${event}${JSON.stringify(data)}`;
  const hash    = crypto.createHash('sha256').update(payload).digest('hex');
  const entry   = { seq: _seq, ts, event, data, prevHash: _prevHash, hash };
  _prevHash     = hash;
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

// ── Verify entire log ─────────────────────────────────────────────────────────

/**
 * Verify the hash chain integrity of the audit log.
 * @returns {{ ok: boolean, entries: number, firstBrokenSeq: number|null }}
 */
function verify() {
  if (!fs.existsSync(AUDIT_FILE)) return { ok: true, entries: 0, firstBrokenSeq: null };
  const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
  let prev = '0'.repeat(64);

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { return { ok: false, entries: lines.length, firstBrokenSeq: -1 }; }
    const payload  = `${entry.prevHash}${entry.seq}${entry.ts}${entry.event}${JSON.stringify(entry.data)}`;
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    if (entry.hash !== expected || entry.prevHash !== prev) {
      return { ok: false, entries: lines.length, firstBrokenSeq: entry.seq };
    }
    prev = entry.hash;
  }
  return { ok: true, entries: lines.length, firstBrokenSeq: null };
}

/**
 * Read all audit entries.
 * @returns {object[]}
 */
function readAll() {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  return fs.readFileSync(AUDIT_FILE, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

module.exports = { audit, verify, readAll };
