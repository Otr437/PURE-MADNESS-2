'use strict';

/**
 * bot/tools/file.js
 * File I/O crypto tools — encrypt, decrypt, hash, and sign files on disk.
 *
 * File format (encrypted):
 *   [salt:32][GCM blob: iv:12 + tag:16 + ciphertext:N]
 *
 * Pure Node.js fs + crypto — zero external deps.
 */

require('../core/resolver');

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { AESCipher }    = require('@crypto-monorepo/aes-gcm');
const { scrypt }       = require('@crypto-monorepo/key-derivation');
const { hmacSign, hmacVerify } = require('@crypto-monorepo/signatures');
const { sha256, sha512, toBase64url, fromBase64url } = require('@crypto-monorepo/crypto-utils');
const { audit }        = require('../core/audit');

const ENC_EXT = '.cbot';  // encrypted file extension

// ── Internal helpers ──────────────────────────────────────────────────────────

function _deriveKey(passphrase, salt) {
  const { key } = scrypt(passphrase, salt, 32, { N: 16384 });
  return key;
}

function _assertExists(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
}

function _safeOutPath(outPath, srcPath, suffix) {
  return outPath || srcPath + suffix;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const FILE_TOOLS = [

  {
    name: 'file_encrypt',
    description: 'Encrypt a file on disk with AES-256-GCM using a passphrase or stored key. Writes a .cbot file.',
    parameters: {
      srcPath:    'string — absolute or relative path to the source file',
      passphrase: 'string (optional) — if omitted, keyId must be provided',
      keyId:      'string (optional) — key in the SecureKeyStore to use instead of passphrase',
      outPath:    'string (optional) — output path; defaults to srcPath + ".cbot"',
    },
    run({ srcPath, passphrase, keyId, outPath } = {}, _store) {
      if (!srcPath) throw new Error('Missing required parameter: srcPath');
      if (!passphrase && !keyId) throw new Error('Provide either passphrase or keyId');
      _assertExists(srcPath);

      const plain  = fs.readFileSync(srcPath);
      const salt   = crypto.randomBytes(32);
      const rawKey = passphrase ? _deriveKey(passphrase, salt) : _store.retrieve(keyId);
      const cipher = new AESCipher(rawKey);
      const ct     = cipher.encrypt(plain);

      // Prepend salt so it can be recovered on decrypt
      const outBuf = passphrase ? Buffer.concat([salt, ct]) : ct;
      const dest   = _safeOutPath(outPath, srcPath, ENC_EXT);

      fs.writeFileSync(dest, outBuf);
      audit('file.encrypt', { srcPath, dest, bytes: plain.length, mode: passphrase ? 'passphrase' : 'keyId' });

      return { ok: true, srcPath, outPath: dest, originalBytes: plain.length, encryptedBytes: outBuf.length };
    },
  },

  {
    name: 'file_decrypt',
    description: 'Decrypt a .cbot encrypted file using the same passphrase or keyId used to encrypt it.',
    parameters: {
      srcPath:    'string — path to the .cbot encrypted file',
      passphrase: 'string (optional)',
      keyId:      'string (optional)',
      outPath:    'string (optional) — defaults to srcPath with .cbot removed',
    },
    run({ srcPath, passphrase, keyId, outPath } = {}, _store) {
      if (!srcPath) throw new Error('Missing required parameter: srcPath');
      if (!passphrase && !keyId) throw new Error('Provide either passphrase or keyId');
      _assertExists(srcPath);

      const raw    = fs.readFileSync(srcPath);
      let   plain;

      if (passphrase) {
        const salt   = raw.slice(0, 32);
        const blob   = raw.slice(32);
        const rawKey = _deriveKey(passphrase, salt);
        plain        = new AESCipher(rawKey).decrypt(blob);
      } else {
        const rawKey = _store.retrieve(keyId);
        plain        = new AESCipher(rawKey).decrypt(raw);
      }

      const dest = _safeOutPath(outPath, srcPath.replace(/\.cbot$/, ''), '.decrypted');
      fs.writeFileSync(dest, plain);
      audit('file.decrypt', { srcPath, dest, bytes: plain.length });

      return { ok: true, srcPath, outPath: dest, decryptedBytes: plain.length };
    },
  },

  {
    name: 'file_hash',
    description: 'Compute SHA-256 or SHA-512 hash of a file. Returns hexdigest.',
    parameters: {
      filePath: 'string',
      algo:     '"sha256" or "sha512" (default sha256)',
    },
    run({ filePath, algo = 'sha256' } = {}) {
      if (!filePath) throw new Error('Missing required parameter: filePath');
      _assertExists(filePath);

      const data   = fs.readFileSync(filePath);
      const digest = algo === 'sha512' ? sha512(data) : sha256(data);
      const hex    = digest.toString('hex');

      audit('file.hash', { filePath, algo, hex: hex.slice(0, 16) + '...' });
      return { ok: true, filePath, algo, hexdigest: hex, bytes: data.length };
    },
  },

  {
    name: 'file_hmac_sign',
    description: 'Compute an HMAC-SHA256 MAC over a file using a stored key. Returns macHex.',
    parameters: {
      filePath: 'string',
      keyId:    'string — key in the SecureKeyStore',
    },
    run({ filePath, keyId } = {}, _store) {
      if (!filePath) throw new Error('Missing required parameter: filePath');
      if (!keyId)    throw new Error('Missing required parameter: keyId');
      _assertExists(filePath);

      const data = fs.readFileSync(filePath);
      const key  = _store.retrieve(keyId);
      const mac  = hmacSign(data, key).toString('hex');

      audit('file.hmac_sign', { filePath, keyId, mac: mac.slice(0, 16) + '...' });
      return { ok: true, filePath, keyId, macHex: mac };
    },
  },

  {
    name: 'file_hmac_verify',
    description: 'Verify an HMAC-SHA256 MAC over a file. Returns { valid: boolean }.',
    parameters: {
      filePath: 'string',
      keyId:    'string',
      macHex:   'string — hex MAC to verify against',
    },
    run({ filePath, keyId, macHex } = {}, _store) {
      if (!filePath) throw new Error('Missing required parameter: filePath');
      if (!keyId)    throw new Error('Missing required parameter: keyId');
      if (!macHex)   throw new Error('Missing required parameter: macHex');
      _assertExists(filePath);

      const data  = fs.readFileSync(filePath);
      const key   = _store.retrieve(keyId);
      const valid = hmacVerify(data, Buffer.from(macHex, 'hex'), key);

      audit('file.hmac_verify', { filePath, keyId, valid });
      return { ok: true, filePath, valid };
    },
  },

  {
    name: 'file_read_text',
    description: 'Read a plain text file and return its contents as a string (max 64KB).',
    parameters: {
      filePath: 'string',
    },
    run({ filePath } = {}) {
      if (!filePath) throw new Error('Missing required parameter: filePath');
      _assertExists(filePath);

      const stat = fs.statSync(filePath);
      if (stat.size > 65536) throw new Error('File too large (max 64KB for text read)');

      const content = fs.readFileSync(filePath, 'utf8');
      return { ok: true, filePath, content, bytes: stat.size };
    },
  },

  {
    name: 'file_write_text',
    description: 'Write a string to a file on disk.',
    parameters: {
      filePath: 'string',
      content:  'string',
    },
    run({ filePath, content } = {}) {
      if (!filePath) throw new Error('Missing required parameter: filePath');
      if (content === undefined) throw new Error('Missing required parameter: content');

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
      audit('file.write', { filePath, bytes: Buffer.byteLength(content) });
      return { ok: true, filePath, bytes: Buffer.byteLength(content) };
    },
  },

  {
    name: 'file_list',
    description: 'List files in a directory (non-recursive).',
    parameters: {
      dirPath:    'string',
      extension:  'string (optional) — filter by extension e.g. ".cbot"',
    },
    run({ dirPath, extension } = {}) {
      if (!dirPath) throw new Error('Missing required parameter: dirPath');
      if (!fs.existsSync(dirPath)) return { ok: true, files: [] };

      let files = fs.readdirSync(dirPath).map(f => {
        const full = path.join(dirPath, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, bytes: stat.size, isFile: stat.isFile() };
      }).filter(f => f.isFile);

      if (extension) files = files.filter(f => f.name.endsWith(extension));
      return { ok: true, dirPath, files };
    },
  },
];

module.exports = { FILE_TOOLS };
