'use strict';

/**
 * bot/core/session.js
 * Persists the in-memory SecureKeyStore to an AES-256-GCM encrypted file.
 *
 * File format (binary):
 *   [salt:32][iv:12][tag:16][ciphertext:N]
 *
 * The file key is derived from CONFIG.passphrase via scrypt.
 * Pure Node.js — no external deps.
 */

const fs     = require('fs');
const crypto = require('crypto');
const path   = require('path');

require('../core/resolver');

const { AESCipher }      = require('@crypto-monorepo/aes-gcm');
const { scrypt }         = require('@crypto-monorepo/key-derivation');
const { SecureKeyStore } = require('@crypto-monorepo/secure-key-store');
const { audit }          = require('./audit');
const CONFIG             = require('../config/config');

const SESSION_FILE = CONFIG.sessionFile;
const PASSPHRASE   = CONFIG.passphrase;

// ── Key derivation from passphrase ────────────────────────────────────────────

function _deriveFileKey(salt) {
  const { key } = scrypt(PASSPHRASE, salt, 32, { N: 16384 });
  return key;
}

// ── Save ──────────────────────────────────────────────────────────────────────

/**
 * Serialize and encrypt the key store to disk.
 * @param {SecureKeyStore} store
 * @param {string[]}       [channelNames]  Names of active channels to record.
 */
function save(store, channelNames = []) {
  const salt    = crypto.randomBytes(32);
  const fileKey = _deriveFileKey(salt);
  const cipher  = new AESCipher(fileKey);

  // Export all entries: { id, keyHex, meta, createdAt, accessCount }
  const entries = store.list().map(entry => ({
    ...entry,
    keyHex: store.retrieve(entry.id).toString('hex'),
  }));

  const payload = JSON.stringify({ entries, channelNames, savedAt: Date.now() });
  const ct      = cipher.encrypt(Buffer.from(payload, 'utf8'));

  // Write: [salt:32][GCM blob: iv:12 + tag:16 + ct:N]
  const fd = fs.openSync(SESSION_FILE, 'w', 0o600);
  fs.writeSync(fd, salt);
  fs.writeSync(fd, ct);
  fs.closeSync(fd);

  audit('session.save', { entries: entries.length, channelNames });
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Load and decrypt the key store from disk.
 * @returns {{ store: SecureKeyStore, channelNames: string[], savedAt: number } | null}
 *   Returns null if no session file exists.
 */
function load() {
  if (!fs.existsSync(SESSION_FILE)) return null;

  const raw     = fs.readFileSync(SESSION_FILE);
  const salt    = raw.slice(0, 32);
  const blob    = raw.slice(32);
  const fileKey = _deriveFileKey(salt);
  const cipher  = new AESCipher(fileKey);

  let payload;
  try {
    payload = JSON.parse(cipher.decrypt(blob).toString('utf8'));
  } catch (err) {
    throw new Error(`Session file is corrupted or passphrase is wrong: ${err.message}`);
  }

  const store = new SecureKeyStore();
  for (const entry of payload.entries) {
    store.store(entry.id, Buffer.from(entry.keyHex, 'hex'), entry.meta);
  }

  audit('session.load', { entries: payload.entries.length });
  return { store, channelNames: payload.channelNames || [], savedAt: payload.savedAt };
}

// ── Delete ────────────────────────────────────────────────────────────────────

function clear() {
  if (fs.existsSync(SESSION_FILE)) {
    // Overwrite with random bytes before unlinking (best-effort)
    const size = fs.statSync(SESSION_FILE).size;
    const fd   = fs.openSync(SESSION_FILE, 'r+');
    fs.writeSync(fd, crypto.randomBytes(size));
    fs.closeSync(fd);
    fs.unlinkSync(SESSION_FILE);
    audit('session.clear', {});
  }
}

/** @returns {boolean} */
function exists() { return fs.existsSync(SESSION_FILE); }

module.exports = { save, load, clear, exists };
