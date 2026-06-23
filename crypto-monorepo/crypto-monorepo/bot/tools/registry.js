'use strict';

/**
 * bot/tools/registry.js
 * Every crypto-monorepo capability exposed as a discrete Tool.
 *
 * A Tool is: { name, description, parameters, run(params) → result }
 * The agent calls run() and receives a plain object result it can reason over.
 *
 * Zero external npm dependencies — only Node built-ins + workspace packages.
 */

require('../core/resolver');

const { AESCipher }        = require('@crypto-monorepo/aes-gcm');
const { AESCBCCipher }     = require('@crypto-monorepo/aes-cbc');
const { RSACipher }        = require('@crypto-monorepo/rsa-hybrid');
const { ECDHKeyExchange }  = require('@crypto-monorepo/ecdh');
const { EncryptedChannel } = require('@crypto-monorepo/encrypted-channel');
const { hkdf, pbkdf2, scrypt, deriveAESKey } = require('@crypto-monorepo/key-derivation');
const { hmacSign, hmacVerify, ed25519Generate, ed25519Sign, ed25519Verify, signJSON, verifyJSON } = require('@crypto-monorepo/signatures');
const { SecureKeyStore }   = require('@crypto-monorepo/secure-key-store');
const { randomBytes, randomHex, sha256, sha512, timingSafeEq, toBase64url, fromBase64url } = require('@crypto-monorepo/crypto-utils');

// ── In-process state shared across tool calls within one agent session ────────
const _keyStore = new SecureKeyStore();
const _channels = new Map(); // name → { initiator: EncryptedChannel, responder: EncryptedChannel }
let   _rsaKeypair = null;
let   _ed25519Keypair = null;

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [

  // ── AES-GCM ────────────────────────────────────────────────────────────────

  {
    name: 'aes_gcm_generate_key',
    description: 'Generate a new random AES-256-GCM key. Returns keyId (stored in key store) and keyHex.',
    parameters: { keyId: 'string (optional label; auto-generated if omitted)' },
    run({ keyId } = {}) {
      const cipher = AESCipher.generate();
      const id     = keyId || 'aes-gcm-' + randomHex(4);
      _keyStore.store(id, cipher.keyBuffer(), { algo: 'aes-256-gcm', createdBy: 'bot' });
      return { ok: true, keyId: id, keyHex: cipher.keyHex() };
    },
  },

  {
    name: 'aes_gcm_encrypt',
    description: 'Encrypt plaintext with AES-256-GCM using a stored key. Returns base64url ciphertext.',
    parameters: { keyId: 'string', plaintext: 'string', aad: 'string (optional)' },
    run({ keyId, plaintext, aad } = {}) {
      _assertParam(keyId, 'keyId'); _assertParam(plaintext, 'plaintext');
      const key    = _keyStore.retrieve(keyId);
      const cipher = new AESCipher(key);
      const ct     = cipher.encrypt(plaintext, aad || null);
      return { ok: true, ciphertext: toBase64url(ct) };
    },
  },

  {
    name: 'aes_gcm_decrypt',
    description: 'Decrypt AES-256-GCM ciphertext (base64url) with a stored key. Returns plaintext.',
    parameters: { keyId: 'string', ciphertext: 'string (base64url)', aad: 'string (optional)' },
    run({ keyId, ciphertext, aad } = {}) {
      _assertParam(keyId, 'keyId'); _assertParam(ciphertext, 'ciphertext');
      const key    = _keyStore.retrieve(keyId);
      const cipher = new AESCipher(key);
      const plain  = cipher.decrypt(fromBase64url(ciphertext), aad || null);
      return { ok: true, plaintext: plain.toString('utf8') };
    },
  },

  {
    name: 'aes_gcm_rotate_key',
    description: 'Re-encrypt existing AES-GCM ciphertext under a fresh key. Old key remains in store. Returns new keyId and new ciphertext.',
    parameters: { keyId: 'string', ciphertext: 'string (base64url)' },
    run({ keyId, ciphertext } = {}) {
      _assertParam(keyId, 'keyId'); _assertParam(ciphertext, 'ciphertext');
      const key    = _keyStore.retrieve(keyId);
      const cipher = new AESCipher(key);
      const { newKey, data } = cipher.rotate(fromBase64url(ciphertext));
      const newId  = 'aes-gcm-rotated-' + randomHex(4);
      _keyStore.store(newId, newKey.keyBuffer(), { algo: 'aes-256-gcm', rotatedFrom: keyId });
      return { ok: true, newKeyId: newId, newCiphertext: toBase64url(data) };
    },
  },

  // ── AES-CBC ────────────────────────────────────────────────────────────────

  {
    name: 'aes_cbc_generate_key',
    description: 'Generate a new random AES-256-CBC key. Returns keyId and keyHex.',
    parameters: { keyId: 'string (optional)' },
    run({ keyId } = {}) {
      const cipher = AESCBCCipher.generate();
      const id     = keyId || 'aes-cbc-' + randomHex(4);
      _keyStore.store(id, cipher.keyBuffer(), { algo: 'aes-256-cbc' });
      return { ok: true, keyId: id, keyHex: cipher.keyHex() };
    },
  },

  {
    name: 'aes_cbc_encrypt',
    description: 'Encrypt plaintext with AES-256-CBC using a stored key. Returns base64url ciphertext.',
    parameters: { keyId: 'string', plaintext: 'string' },
    run({ keyId, plaintext } = {}) {
      _assertParam(keyId, 'keyId'); _assertParam(plaintext, 'plaintext');
      const key    = _keyStore.retrieve(keyId);
      const cipher = new AESCBCCipher(key);
      return { ok: true, ciphertext: toBase64url(cipher.encrypt(plaintext)) };
    },
  },

  {
    name: 'aes_cbc_decrypt',
    description: 'Decrypt AES-256-CBC ciphertext (base64url) with a stored key. Returns plaintext.',
    parameters: { keyId: 'string', ciphertext: 'string (base64url)' },
    run({ keyId, ciphertext } = {}) {
      _assertParam(keyId, 'keyId'); _assertParam(ciphertext, 'ciphertext');
      const key   = _keyStore.retrieve(keyId);
      const plain = new AESCBCCipher(key).decrypt(fromBase64url(ciphertext));
      return { ok: true, plaintext: plain.toString('utf8') };
    },
  },

  // ── RSA ────────────────────────────────────────────────────────────────────

  {
    name: 'rsa_generate_keypair',
    description: 'Generate an RSA key pair (2048 or 4096 bit). Stores in session. Returns publicKeyPEM.',
    parameters: { bits: 'number (2048 or 4096, default 2048)' },
    run({ bits = 2048 } = {}) {
      _rsaKeypair = RSACipher.generate(bits);
      return { ok: true, bits, publicKeyPEM: _rsaKeypair.publicKeyPEM() };
    },
  },

  {
    name: 'rsa_hybrid_encrypt',
    description: 'Hybrid-encrypt plaintext using the session RSA public key (RSA wraps a fresh AES key). Returns base64url blob.',
    parameters: { plaintext: 'string' },
    run({ plaintext } = {}) {
      _assertParam(plaintext, 'plaintext');
      if (!_rsaKeypair) throw new Error('No RSA keypair — run rsa_generate_keypair first');
      return { ok: true, ciphertext: toBase64url(_rsaKeypair.hybridEncrypt(plaintext)) };
    },
  },

  {
    name: 'rsa_hybrid_decrypt',
    description: 'Decrypt a hybrid RSA+AES blob using the session RSA private key. Returns plaintext.',
    parameters: { ciphertext: 'string (base64url)' },
    run({ ciphertext } = {}) {
      _assertParam(ciphertext, 'ciphertext');
      if (!_rsaKeypair) throw new Error('No RSA keypair — run rsa_generate_keypair first');
      return { ok: true, plaintext: _rsaKeypair.hybridDecrypt(fromBase64url(ciphertext)).toString('utf8') };
    },
  },

  {
    name: 'rsa_sign',
    description: 'Sign data with the session RSA private key (RSA-PSS). Returns base64url signature.',
    parameters: { data: 'string' },
    run({ data } = {}) {
      _assertParam(data, 'data');
      if (!_rsaKeypair) throw new Error('No RSA keypair — run rsa_generate_keypair first');
      return { ok: true, signature: toBase64url(_rsaKeypair.sign(data)) };
    },
  },

  {
    name: 'rsa_verify',
    description: 'Verify an RSA-PSS signature. Returns { valid: boolean }.',
    parameters: { data: 'string', signature: 'string (base64url)' },
    run({ data, signature } = {}) {
      _assertParam(data, 'data'); _assertParam(signature, 'signature');
      if (!_rsaKeypair) throw new Error('No RSA keypair — run rsa_generate_keypair first');
      return { ok: true, valid: _rsaKeypair.verify(data, fromBase64url(signature)) };
    },
  },

  // ── ECDH ───────────────────────────────────────────────────────────────────

  {
    name: 'ecdh_generate_keypair',
    description: 'Generate an ECDH key pair on prime256v1. Returns publicKeyHex. Private key stored in key store.',
    parameters: { keyId: 'string (optional)' },
    run({ keyId } = {}) {
      const ecdh = new ECDHKeyExchange();
      const id   = keyId || 'ecdh-' + randomHex(4);
      _keyStore.store(id + ':priv', ecdh.privateKey, { algo: 'ecdh', curve: 'prime256v1' });
      _keyStore.store(id + ':pub',  ecdh.publicKey,  { algo: 'ecdh', curve: 'prime256v1', public: true });
      return { ok: true, keyId: id, publicKeyHex: ecdh.publicKeyHex() };
    },
  },

  // ── Encrypted channel ──────────────────────────────────────────────────────

  {
    name: 'channel_create',
    description: 'Create and fully negotiate an in-process encrypted channel between two named peers. Returns sessionIds.',
    parameters: { channelName: 'string' },
    run({ channelName } = {}) {
      _assertParam(channelName, 'channelName');
      const FIXED_SALT = Buffer.alloc(32, 0); // deterministic derivation for in-process peers
      const { ECDHKeyExchange } = require('@crypto-monorepo/ecdh');
      const origDerive = ECDHKeyExchange.prototype.deriveAESKey;
      ECDHKeyExchange.prototype.deriveAESKey = function(peer, info = 'aes-key') {
        return origDerive.call(this, peer, info, FIXED_SALT);
      };
      const initiator = new EncryptedChannel();
      const responder = new EncryptedChannel();
      const hi    = initiator.initiateHandshake();
      const reply = responder.respondHandshake(hi.publicKey);
      initiator.completeHandshake(reply.publicKey);
      ECDHKeyExchange.prototype.deriveAESKey = origDerive; // restore
      _channels.set(channelName, { initiator, responder });
      return { ok: true, channelName, initiatorSessionId: initiator.sessionId(), responderSessionId: responder.sessionId() };
    },
  },

  {
    name: 'channel_send',
    description: 'Send a message over a named channel (initiator → responder). Returns base64url encrypted frame.',
    parameters: { channelName: 'string', message: 'string', direction: '"i2r" (initiator→responder) or "r2i"' },
    run({ channelName, message, direction = 'i2r' } = {}) {
      _assertParam(channelName, 'channelName'); _assertParam(message, 'message');
      const ch  = _getChannel(channelName);
      const sender = direction === 'i2r' ? ch.initiator : ch.responder;
      return { ok: true, frame: toBase64url(sender.send(message)) };
    },
  },

  {
    name: 'channel_receive',
    description: 'Receive and decrypt a frame from a named channel. Returns plaintext message and counter.',
    parameters: { channelName: 'string', frame: 'string (base64url)', direction: '"i2r" or "r2i"' },
    run({ channelName, frame, direction = 'i2r' } = {}) {
      _assertParam(channelName, 'channelName'); _assertParam(frame, 'frame');
      const ch       = _getChannel(channelName);
      const receiver = direction === 'i2r' ? ch.responder : ch.initiator;
      const { counter, data } = receiver.receive(fromBase64url(frame));
      return { ok: true, message: data.toString('utf8'), counter };
    },
  },

  // ── Key derivation ─────────────────────────────────────────────────────────

  {
    name: 'kdf_hkdf',
    description: 'Derive a key from high-entropy input material using HKDF-SHA256. Returns derived keyHex.',
    parameters: { ikm: 'string (hex input keying material)', info: 'string (optional context)', length: 'number (bytes, default 32)' },
    run({ ikm, info = '', length = 32 } = {}) {
      _assertParam(ikm, 'ikm');
      const salt   = randomBytes(32);
      const derived = hkdf(Buffer.from(ikm, 'hex'), salt, info, length);
      return { ok: true, derivedKeyHex: derived.toString('hex'), saltHex: salt.toString('hex'), length };
    },
  },

  {
    name: 'kdf_pbkdf2',
    description: 'Derive a key from a password using PBKDF2-SHA256. Returns keyHex and saltHex.',
    parameters: { password: 'string', iterations: 'number (default 100000)', keyLen: 'number (bytes, default 32)' },
    run({ password, iterations = 100_000, keyLen = 32 } = {}) {
      _assertParam(password, 'password');
      const { key, salt } = pbkdf2(password, null, iterations, keyLen);
      return { ok: true, keyHex: key.toString('hex'), saltHex: salt.toString('hex'), iterations };
    },
  },

  {
    name: 'kdf_scrypt',
    description: 'Derive a key from a password using scrypt (memory-hard). Returns keyHex and saltHex.',
    parameters: { password: 'string', keyLen: 'number (bytes, default 32)', N: 'number (CPU cost, default 16384)' },
    run({ password, keyLen = 32, N = 16384 } = {}) {
      _assertParam(password, 'password');
      const { key, salt } = scrypt(password, null, keyLen, { N });
      return { ok: true, keyHex: key.toString('hex'), saltHex: salt.toString('hex') };
    },
  },

  // ── Signatures ─────────────────────────────────────────────────────────────

  {
    name: 'hmac_sign',
    description: 'Compute an HMAC-SHA256 MAC over data using a stored key. Returns macHex.',
    parameters: { keyId: 'string', data: 'string' },
    run({ keyId, data } = {}) {
      _assertParam(keyId, 'keyId'); _assertParam(data, 'data');
      const key = _keyStore.retrieve(keyId);
      return { ok: true, macHex: hmacSign(data, key).toString('hex') };
    },
  },

  {
    name: 'hmac_verify',
    description: 'Verify an HMAC-SHA256 MAC. Returns { valid: boolean }.',
    parameters: { keyId: 'string', data: 'string', macHex: 'string' },
    run({ keyId, data, macHex } = {}) {
      _assertParam(keyId, 'keyId'); _assertParam(data, 'data'); _assertParam(macHex, 'macHex');
      const key = _keyStore.retrieve(keyId);
      return { ok: true, valid: hmacVerify(data, Buffer.from(macHex, 'hex'), key) };
    },
  },

  {
    name: 'ed25519_generate',
    description: 'Generate an Ed25519 keypair for signing. Stored in session. Returns publicKeyPEM.',
    parameters: {},
    run() {
      _ed25519Keypair = ed25519Generate();
      return { ok: true, publicKeyPEM: _ed25519Keypair.publicKey };
    },
  },

  {
    name: 'ed25519_sign',
    description: 'Sign data with the session Ed25519 private key. Returns base64url signature.',
    parameters: { data: 'string' },
    run({ data } = {}) {
      _assertParam(data, 'data');
      if (!_ed25519Keypair) throw new Error('No Ed25519 keypair — run ed25519_generate first');
      return { ok: true, signature: toBase64url(ed25519Sign(data, _ed25519Keypair.privateKey)) };
    },
  },

  {
    name: 'ed25519_verify',
    description: 'Verify an Ed25519 signature. Returns { valid: boolean }.',
    parameters: { data: 'string', signature: 'string (base64url)' },
    run({ data, signature } = {}) {
      _assertParam(data, 'data'); _assertParam(signature, 'signature');
      if (!_ed25519Keypair) throw new Error('No Ed25519 keypair — run ed25519_generate first');
      return { ok: true, valid: ed25519Verify(data, fromBase64url(signature), _ed25519Keypair.publicKey) };
    },
  },

  {
    name: 'sign_json',
    description: 'HMAC-sign a JSON payload using a stored key. Returns { payload, sig } for transport.',
    parameters: { keyId: 'string', data: 'string (JSON)' },
    run({ keyId, data } = {}) {
      _assertParam(keyId, 'keyId'); _assertParam(data, 'data');
      const key = _keyStore.retrieve(keyId);
      return { ok: true, ...signJSON(JSON.parse(data), key) };
    },
  },

  {
    name: 'verify_json',
    description: 'Verify an HMAC-signed JSON payload. Returns { valid: boolean }.',
    parameters: { keyId: 'string', payload: 'string', sig: 'string (base64)' },
    run({ keyId, payload, sig } = {}) {
      _assertParam(keyId, 'keyId'); _assertParam(payload, 'payload'); _assertParam(sig, 'sig');
      const key = _keyStore.retrieve(keyId);
      return { ok: true, valid: verifyJSON(payload, sig, key) };
    },
  },

  // ── Key store management ───────────────────────────────────────────────────

  {
    name: 'keystore_list',
    description: 'List all keys currently in the secure key store (metadata only, no key material).',
    parameters: {},
    run() {
      return { ok: true, keys: _keyStore.list() };
    },
  },

  {
    name: 'keystore_delete',
    description: 'Securely delete a key from the store.',
    parameters: { keyId: 'string' },
    run({ keyId } = {}) {
      _assertParam(keyId, 'keyId');
      _keyStore.delete(keyId);
      return { ok: true, deleted: keyId };
    },
  },

  {
    name: 'keystore_rotate_key',
    description: 'Replace a stored key with new random bytes of the same length.',
    parameters: { keyId: 'string' },
    run({ keyId } = {}) {
      _assertParam(keyId, 'keyId');
      const newRaw = _keyStore.rotate(keyId);
      return { ok: true, keyId, newKeyHex: newRaw.toString('hex') };
    },
  },

  // ── Crypto utils ───────────────────────────────────────────────────────────

  {
    name: 'utils_random',
    description: 'Generate secure random bytes or a hex string.',
    parameters: { bytes: 'number', format: '"hex" or "base64url" (default hex)' },
    run({ bytes = 32, format = 'hex' } = {}) {
      const buf = randomBytes(bytes);
      return { ok: true, value: format === 'base64url' ? toBase64url(buf) : buf.toString('hex'), bytes };
    },
  },

  {
    name: 'utils_hash',
    description: 'Hash data with SHA-256 or SHA-512. Returns hexdigest.',
    parameters: { data: 'string', algo: '"sha256" or "sha512" (default sha256)' },
    run({ data, algo = 'sha256' } = {}) {
      _assertParam(data, 'data');
      const digest = algo === 'sha512' ? sha512(data) : sha256(data);
      return { ok: true, algo, hexdigest: digest.toString('hex') };
    },
  },

  {
    name: 'utils_timing_safe_eq',
    description: 'Timing-safe comparison of two hex strings. Returns { equal: boolean }.',
    parameters: { a: 'string (hex)', b: 'string (hex)' },
    run({ a, b } = {}) {
      _assertParam(a, 'a'); _assertParam(b, 'b');
      return { ok: true, equal: timingSafeEq(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')) };
    },
  },

];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _assertParam(val, name) {
  if (val === undefined || val === null || val === '')
    throw new Error(`Missing required parameter: ${name}`);
}

function _getChannel(name) {
  if (!_channels.has(name)) throw new Error(`Channel '${name}' not found — run channel_create first`);
  return _channels.get(name);
}

// Build lookup map
const TOOL_MAP = Object.fromEntries(TOOLS.map(t => [t.name, t]));

function getTool(name)  { return TOOL_MAP[name] || null; }
function listTools()    { return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })); }
function callTool(name, params) {
  const tool = TOOL_MAP[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(params);
}

module.exports = { listTools, getTool, callTool };

// ── Scheduler tools ───────────────────────────────────────────────────────────

const scheduler = require('../core/scheduler');

TOOLS.push(
  {
    name: 'scheduler_add',
    description: 'Add a recurring autonomous task. The agent will run the goal automatically on the given interval.',
    parameters: { name: 'string', goal: 'string', intervalMs: 'number', maxRuns: 'number (optional)', delayMs: 'number (optional)' },
    run({ name, goal, intervalMs, maxRuns, delayMs } = {}) {
      _assertParam(name, 'name'); _assertParam(goal, 'goal'); _assertParam(intervalMs, 'intervalMs');
      const task = scheduler.addTask({ name, goal, intervalMs, maxRuns, delayMs });
      return { ok: true, taskId: task.id, name: task.name, nextRunAt: new Date(task.nextRunAt).toISOString() };
    },
  },
  {
    name: 'scheduler_list',
    description: 'List all scheduled tasks and their status.',
    parameters: {},
    run() {
      return { ok: true, tasks: scheduler.listTasks() };
    },
  },
  {
    name: 'scheduler_remove',
    description: 'Remove a scheduled task by id.',
    parameters: { taskId: 'string' },
    run({ taskId } = {}) {
      _assertParam(taskId, 'taskId');
      scheduler.removeTask(taskId);
      return { ok: true, removed: taskId };
    },
  },
  {
    name: 'scheduler_toggle',
    description: 'Enable or disable a scheduled task.',
    parameters: { taskId: 'string', enabled: 'boolean' },
    run({ taskId, enabled } = {}) {
      _assertParam(taskId, 'taskId');
      scheduler.setEnabled(taskId, !!enabled);
      return { ok: true, taskId, enabled: !!enabled };
    },
  }
);

// ── File tools ────────────────────────────────────────────────────────────────

const { FILE_TOOLS } = require('./file');

// File tools need access to _keyStore — wrap run() to inject it
for (const ft of FILE_TOOLS) {
  TOOLS.push({
    ...ft,
    run: (params) => ft.run(params, _keyStore),
  });
  TOOL_MAP[ft.name] = { ...ft, run: (params) => ft.run(params, _keyStore) };
}

// ── Audit tools ───────────────────────────────────────────────────────────────

const auditMod = require('../core/audit');

TOOLS.push(
  {
    name: 'audit_verify',
    description: 'Verify the integrity of the tamper-evident audit log hash chain.',
    parameters: {},
    run() {
      return { ok: true, ...auditMod.verify() };
    },
  },
  {
    name: 'audit_recent',
    description: 'Return the last N audit log entries.',
    parameters: { n: 'number (default 20)' },
    run({ n = 20 } = {}) {
      const all = auditMod.readAll();
      return { ok: true, entries: all.slice(-n) };
    },
  }
);

// ── Memory tools ──────────────────────────────────────────────────────────────

const memMod = require('../core/memory');

TOOLS.push(
  {
    name: 'memory_search',
    description: 'Search conversation memory for past goals, actions, or results.',
    parameters: { query: 'string', limit: 'number (default 10)' },
    run({ query, limit = 10 } = {}) {
      _assertParam(query, 'query');
      return { ok: true, results: memMod.search(query, limit) };
    },
  },
  {
    name: 'memory_recent',
    description: 'Return the last N memory entries.',
    parameters: { n: 'number (default 20)' },
    run({ n = 20 } = {}) {
      return { ok: true, entries: memMod.recent(n) };
    },
  },
  {
    name: 'memory_summary',
    description: 'Return a summary of the memory store (counts, date range).',
    parameters: {},
    run() {
      return { ok: true, ...memMod.summarize() };
    },
  }
);

// Rebuild TOOL_MAP after pushing new tools
for (const t of TOOLS) TOOL_MAP[t.name] = t;

// Expose store injection for agent
function setStore(store) { _keyStore._keys = store._keys; _keyStore._master = store._master; }

// Re-export with updated signature
module.exports = { listTools, getTool, callTool, setStore };
