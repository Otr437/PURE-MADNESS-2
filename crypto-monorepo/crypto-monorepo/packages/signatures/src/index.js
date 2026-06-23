'use strict';

/**
 * @package @crypto-monorepo/signatures
 * Digital signature utilities: HMAC-SHA256, Ed25519, and helper combiners.
 *
 * No dependencies outside Node's built-in `crypto` module.
 */

const crypto = require('crypto');

// ── HMAC ──────────────────────────────────────────────────────────────────────

/**
 * Compute an HMAC-SHA256 (or other algorithm) MAC.
 *
 * @param {Buffer|string} data   Data to sign.
 * @param {Buffer|string} key    Signing key (Buffer or hex string).
 * @param {string} [alg='sha256']
 * @returns {Buffer}
 */
function hmacSign(data, key, alg = 'sha256') {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
  return crypto
    .createHmac(alg, keyBuf)
    .update(Buffer.isBuffer(data) ? data : Buffer.from(data))
    .digest();
}

/**
 * Timing-safe HMAC verification.
 *
 * @param {Buffer|string} data
 * @param {Buffer|string} sig
 * @param {Buffer|string} key
 * @param {string} [alg='sha256']
 * @returns {boolean}
 */
function hmacVerify(data, sig, key, alg = 'sha256') {
  const expected = hmacSign(data, key, alg);
  const actual   = Buffer.isBuffer(sig) ? sig : Buffer.from(sig, 'hex');
  try {
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── Ed25519 ───────────────────────────────────────────────────────────────────

/**
 * Generate an Ed25519 key pair.
 * @returns {{ publicKey: string, privateKey: string }}  PEM-encoded keys.
 */
function ed25519Generate() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/**
 * Sign data with an Ed25519 private key.
 * @param {Buffer|string} data
 * @param {string} privPEM  PKCS#8 PEM private key.
 * @returns {Buffer}
 */
function ed25519Sign(data, privPEM) {
  return crypto.sign(
    null,
    Buffer.isBuffer(data) ? data : Buffer.from(data),
    privPEM
  );
}

/**
 * Verify an Ed25519 signature.
 * @param {Buffer|string} data
 * @param {Buffer}        sig
 * @param {string}        pubPEM  SPKI PEM public key.
 * @returns {boolean}
 */
function ed25519Verify(data, sig, pubPEM) {
  try {
    return crypto.verify(
      null,
      Buffer.isBuffer(data) ? data : Buffer.from(data),
      pubPEM,
      sig
    );
  } catch {
    return false;
  }
}

// ── Convenience combiner ──────────────────────────────────────────────────────

/**
 * Sign a JSON payload with HMAC-SHA256 and return the payload + signature.
 * @param {*}             obj
 * @param {Buffer|string} key
 * @returns {{ payload: string, sig: string }}  Base64-encoded for easy transport.
 */
function signJSON(obj, key) {
  const payload = JSON.stringify(obj);
  const sig     = hmacSign(Buffer.from(payload), key).toString('base64');
  return { payload, sig };
}

/**
 * Verify a JSON payload signed by {@link signJSON}.
 * @param {string}        payload
 * @param {string}        sig    Base64-encoded.
 * @param {Buffer|string} key
 * @returns {boolean}
 */
function verifyJSON(payload, sig, key) {
  return hmacVerify(Buffer.from(payload), Buffer.from(sig, 'base64'), key);
}

module.exports = {
  hmacSign, hmacVerify,
  ed25519Generate, ed25519Sign, ed25519Verify,
  signJSON, verifyJSON,
};
