'use strict';

/**
 * @package @crypto-monorepo/crypto-utils
 * Low-level cryptographic primitives and helpers.
 *
 * No dependencies outside Node's built-in `crypto` module.
 */

const crypto = require('crypto');

/**
 * Generate cryptographically secure random bytes.
 * @param {number} n  Number of bytes.
 * @returns {Buffer}
 */
function randomBytes(n) {
  return crypto.randomBytes(n);
}

/**
 * Generate a cryptographically secure random hex string.
 * @param {number} n  Number of bytes (hex string will be 2n chars long).
 * @returns {string}
 */
function randomHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

/**
 * SHA-256 hash.
 * @param {Buffer|string} data
 * @returns {Buffer}
 */
function sha256(data) {
  return crypto.createHash('sha256')
    .update(Buffer.isBuffer(data) ? data : Buffer.from(data))
    .digest();
}

/**
 * SHA-512 hash.
 * @param {Buffer|string} data
 * @returns {Buffer}
 */
function sha512(data) {
  return crypto.createHash('sha512')
    .update(Buffer.isBuffer(data) ? data : Buffer.from(data))
    .digest();
}

/**
 * HMAC with configurable algorithm.
 * @param {Buffer|string} key
 * @param {Buffer|string} data
 * @param {string}        [alg='sha256']
 * @returns {Buffer}
 */
function hmac(key, data, alg = 'sha256') {
  return crypto.createHmac(alg, key)
    .update(Buffer.isBuffer(data) ? data : Buffer.from(data))
    .digest();
}

/**
 * Timing-safe equality check.
 * Returns false (not throws) if the buffers differ in length.
 * @param {Buffer|string} a
 * @param {Buffer|string} b
 * @returns {boolean}
 */
function timingSafeEq(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Overwrite a Buffer with zeros (in-place).
 * No-op if the argument is not a Buffer.
 * @param {Buffer} buf
 */
function zeroize(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

/**
 * XOR two buffers together.
 * The output length equals the longer buffer; the shorter is cycled.
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {Buffer}
 */
function xorBufs(a, b) {
  const len = Math.max(a.length, b.length);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    out[i] = (a[i % a.length] || 0) ^ (b[i % b.length] || 0);
  }
  return out;
}

/**
 * Encode a Buffer as URL-safe Base64 (no padding).
 * @param {Buffer} buf
 * @returns {string}
 */
function toBase64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode a URL-safe Base64 string to a Buffer.
 * @param {string} str
 * @returns {Buffer}
 */
function fromBase64url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const rem    = padded.length % 4;
  return Buffer.from(rem ? padded + '='.repeat(4 - rem) : padded, 'base64');
}

/**
 * Constant-time comparison of two strings (via Buffer coercion).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeStringEq(a, b) {
  return timingSafeEq(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

module.exports = {
  randomBytes,
  randomHex,
  sha256,
  sha512,
  hmac,
  timingSafeEq,
  zeroize,
  xorBufs,
  toBase64url,
  fromBase64url,
  safeStringEq,
};
