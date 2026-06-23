'use strict';

/**
 * @package @crypto-monorepo/aes-cbc
 * AES-256-CBC encryption with PKCS#7 padding.
 *
 * Encrypted blob layout: [iv:16 bytes][ciphertext:N bytes]
 *
 * NOTE: AES-GCM is preferred for new designs (it provides authentication).
 * Use this module when CBC interoperability is required.
 */

const crypto = require('crypto');

class AESCBCCipher {
  /**
   * @param {Buffer|string} key  32-byte Buffer or hex string.
   */
  constructor(key) {
    this._key = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
    if (this._key.length !== 32) throw new RangeError('AES-256 requires a 32-byte key');
  }

  /** Generate a new AESCBCCipher with a random key. */
  static generate() {
    return new AESCBCCipher(crypto.randomBytes(32));
  }

  /**
   * Encrypt plaintext with AES-256-CBC.
   * @param {Buffer|string} plaintext
   * @returns {Buffer}  [iv:16][ciphertext:N]
   */
  encrypt(plaintext) {
    const iv  = crypto.randomBytes(16);
    const pad = this._pkcs7Pad(
      Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)
    );
    const c  = crypto.createCipheriv('aes-256-cbc', this._key, iv);
    const ct = Buffer.concat([c.update(pad), c.final()]);
    return Buffer.concat([iv, ct]);
  }

  /**
   * Decrypt an AES-256-CBC blob produced by {@link encrypt}.
   * @param {Buffer|string} data
   * @returns {Buffer}
   */
  decrypt(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 32) throw new RangeError('Ciphertext too short (min 32 bytes)');
    const iv = buf.slice(0, 16);
    const ct = buf.slice(16);
    const d  = crypto.createDecipheriv('aes-256-cbc', this._key, iv);
    return this._pkcs7Unpad(Buffer.concat([d.update(ct), d.final()]));
  }

  /**
   * Encrypt a JSON-serialisable value.
   * @param {*} obj
   * @returns {Buffer}
   */
  encryptJSON(obj) {
    return this.encrypt(Buffer.from(JSON.stringify(obj)));
  }

  /**
   * Decrypt and parse JSON.
   * @param {Buffer|string} data
   * @returns {*}
   */
  decryptJSON(data) {
    return JSON.parse(this.decrypt(data).toString('utf8'));
  }

  /** @returns {string} Hex-encoded 32-byte key. */
  keyHex() { return this._key.toString('hex'); }

  /** @returns {Buffer} Raw 32-byte key copy. */
  keyBuffer() { return Buffer.from(this._key); }

  // ── Private helpers ────────────────────────────────────────────────────────

  _pkcs7Pad(buf) {
    const pad = 16 - (buf.length % 16);
    const out = Buffer.alloc(buf.length + pad);
    buf.copy(out);
    out.fill(pad, buf.length);
    return out;
  }

  _pkcs7Unpad(buf) {
    const pad = buf[buf.length - 1];
    if (pad > 16 || pad === 0) throw new RangeError('Invalid PKCS7 padding');
    for (let i = buf.length - pad; i < buf.length; i++) {
      if (buf[i] !== pad) throw new RangeError('Invalid PKCS7 padding byte');
    }
    return buf.slice(0, buf.length - pad);
  }
}

module.exports = { AESCBCCipher };
