'use strict';

/**
 * @package @crypto-monorepo/key-derivation
 * Password / secret key derivation functions: HKDF, PBKDF2, scrypt.
 *
 * All functions are pure (no state) and have no dependencies outside Node's
 * built-in `crypto` module.
 */

const crypto = require('crypto');

/**
 * HKDF (RFC 5869) — derive keying material from existing high-entropy input.
 *
 * @param {Buffer|string} ikm        Input keying material.
 * @param {Buffer|string|null} salt  Random salt (recommended). Defaults to a
 *                                   zero-filled buffer of hash output length.
 * @param {Buffer|string|null} info  Context / application-specific info string.
 * @param {number} [length=32]       Output length in bytes.
 * @param {string} [hash='sha256']   Hash algorithm.
 * @returns {Buffer}
 */
function hkdf(ikm, salt = null, info = null, length = 32, hash = 'sha256') {
  const hashLen = crypto.createHash(hash).digest().length;
  const saltBuf = salt
    ? Buffer.from(salt)
    : Buffer.alloc(hashLen, 0);

  // Extract
  const prk = crypto.createHmac(hash, saltBuf)
    .update(Buffer.from(ikm))
    .digest();

  // Expand
  const n      = Math.ceil(length / hashLen);
  const blocks = [];
  let prev     = Buffer.alloc(0);
  const infoBuf = info ? Buffer.from(info) : Buffer.alloc(0);

  for (let i = 1; i <= n; i++) {
    prev = crypto.createHmac(hash, prk)
      .update(Buffer.concat([prev, infoBuf, Buffer.from([i])]))
      .digest();
    blocks.push(prev);
  }

  return Buffer.concat(blocks).slice(0, length);
}

/**
 * PBKDF2 — password-based key derivation (NIST SP 800-132).
 *
 * @param {string|Buffer} password
 * @param {Buffer|string|null} salt       Random salt; generated (32 bytes) if null.
 * @param {number} [iterations=100000]   Iteration count (increase for higher security).
 * @param {number} [keyLen=32]           Output key length in bytes.
 * @param {string} [digest='sha256']     PRF hash algorithm.
 * @returns {{ key: Buffer, salt: Buffer, iterations: number }}
 */
function pbkdf2(password, salt = null, iterations = 100_000, keyLen = 32, digest = 'sha256') {
  const s = salt ? Buffer.from(salt) : crypto.randomBytes(32);
  const k = crypto.pbkdf2Sync(Buffer.from(password), s, iterations, keyLen, digest);
  return { key: k, salt: s, iterations };
}

/**
 * scrypt — memory-hard password-based key derivation (RFC 7914).
 *
 * @param {string|Buffer} password
 * @param {Buffer|string|null} salt  Random salt; generated (32 bytes) if null.
 * @param {number} [keyLen=32]       Output key length in bytes.
 * @param {object} [opts]
 * @param {number} [opts.N=16384]    CPU/memory cost factor (must be power of 2).
 * @param {number} [opts.r=8]        Block size.
 * @param {number} [opts.p=1]        Parallelisation factor.
 * @returns {{ key: Buffer, salt: Buffer }}
 */
function scrypt(password, salt = null, keyLen = 32, opts = {}) {
  const s = salt ? Buffer.from(salt) : crypto.randomBytes(32);
  const k = crypto.scryptSync(Buffer.from(password), s, keyLen, {
    N: opts.N || 16384,
    r: opts.r || 8,
    p: opts.p || 1,
  });
  return { key: k, salt: s };
}

/**
 * Convenience: derive an AES-256 key (32 bytes) from a password using scrypt
 * with sensible defaults.
 *
 * @param {string} password
 * @param {Buffer|null} [salt]
 * @returns {{ key: Buffer, salt: Buffer }}
 */
function deriveAESKey(password, salt = null) {
  return scrypt(password, salt, 32);
}

module.exports = { hkdf, pbkdf2, scrypt, deriveAESKey };
