'use strict';

/**
 * @package @crypto-monorepo/aes-gcm
 * AES-256-GCM authenticated encryption.
 *
 * Encrypted blob layout: [iv:12 bytes][tag:16 bytes][ciphertext:N bytes]
 */

const crypto = require('crypto');

class AESCipher {
  /**
   * @param {Buffer|string|null} key  32-byte Buffer, hex string, or null to auto-generate.
   */
  constructor(key) {
    this._key =
      Buffer.isBuffer(key)    ? key :
      typeof key === 'string' ? Buffer.from(key, 'hex') :
                                crypto.randomBytes(32);
    if (this._key.length !== 32) throw new RangeError('AES-256 requires a 32-byte key');
  }

  /** Generate a new AESCipher with a random key. */
  static generate() {
    return new AESCipher(crypto.randomBytes(32));
  }

  /**
   * Encrypt plaintext with AES-256-GCM.
   * @param {Buffer|string} plaintext
   * @param {Buffer|string|null} [aad]  Optional Additional Authenticated Data.
   * @returns {Buffer}  [iv:12][tag:16][ciphertext:N]
   */
  encrypt(plaintext, aad = null) {
    const iv     = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key, iv);
    if (aad) cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad));
    const ct  = Buffer.concat([
      cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]);
  }

  /**
   * Decrypt an AES-256-GCM blob produced by {@link encrypt}.
   * @param {Buffer|string} data
   * @param {Buffer|string|null} [aad]
   * @returns {Buffer}
   */
  decrypt(data, aad = null) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 28) throw new RangeError('Ciphertext too short (min 28 bytes)');
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const ct  = buf.slice(28);
    const dec = crypto.createDecipheriv('aes-256-gcm', this._key, iv);
    if (aad) dec.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad));
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(ct), dec.final()]);
  }

  /**
   * Encrypt a JSON-serialisable value.
   * @param {*} obj
   * @param {Buffer|string|null} [aad]
   * @returns {Buffer}
   */
  encryptJSON(obj, aad = null) {
    return this.encrypt(Buffer.from(JSON.stringify(obj)), aad);
  }

  /**
   * Decrypt and parse JSON.
   * @param {Buffer|string} data
   * @param {Buffer|string|null} [aad]
   * @returns {*}
   */
  decryptJSON(data, aad = null) {
    return JSON.parse(this.decrypt(data, aad).toString('utf8'));
  }

  /**
   * Re-encrypt existing blob under a fresh random key.
   * @param {Buffer} data  Existing AES-GCM blob.
   * @returns {{ newKey: AESCipher, data: Buffer }}
   */
  rotate(data) {
    const plain  = this.decrypt(data);
    const newKey = AESCipher.generate();
    return { newKey, data: newKey.encrypt(plain) };
  }

  /** @returns {string} Hex-encoded 32-byte key. */
  keyHex() { return this._key.toString('hex'); }

  /** @returns {Buffer} Raw 32-byte key copy. */
  keyBuffer() { return Buffer.from(this._key); }
}

module.exports = { AESCipher };
