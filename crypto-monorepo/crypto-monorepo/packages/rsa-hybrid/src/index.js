'use strict';

/**
 * @package @crypto-monorepo/rsa-hybrid
 * RSA-OAEP encryption, RSA-PSS signatures, and RSA+AES-GCM hybrid encryption.
 *
 * Hybrid blob layout: [keyLen:4 bytes BE][encryptedAESKey:keyLen][encryptedData:N]
 *
 * Depends on: @crypto-monorepo/aes-gcm (peer)
 */

const crypto = require('crypto');
const { AESCipher } = require('@crypto-monorepo/aes-gcm');

class RSACipher {
  /**
   * @param {string|null} publicKey   PEM string (PKCS#1).
   * @param {string|null} privateKey  PEM string (PKCS#8).
   */
  constructor(publicKey = null, privateKey = null) {
    this._pub  = publicKey  || null;
    this._priv = privateKey || null;
  }

  /**
   * Generate a new RSA key pair.
   * @param {number} [bits=2048]  Key size in bits (2048 or 4096 recommended).
   * @returns {RSACipher}
   */
  static generate(bits = 2048) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: bits,
      publicKeyEncoding:  { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return new RSACipher(publicKey, privateKey);
  }

  /**
   * Encrypt small payloads (≤ keySize - 66 bytes) with RSA-OAEP.
   * For larger data use {@link hybridEncrypt}.
   * @param {Buffer|string} data
   * @returns {Buffer}
   */
  encrypt(data) {
    if (!this._pub) throw new Error('No public key available');
    return crypto.publicEncrypt(
      { key: this._pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.isBuffer(data) ? data : Buffer.from(data)
    );
  }

  /**
   * Decrypt an RSA-OAEP ciphertext.
   * @param {Buffer|string} data
   * @returns {Buffer}
   */
  decrypt(data) {
    if (!this._priv) throw new Error('No private key available');
    return crypto.privateDecrypt(
      { key: this._priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.isBuffer(data) ? data : Buffer.from(data)
    );
  }

  /**
   * Sign data with RSA-PSS.
   * @param {Buffer|string} data
   * @param {string} [alg='sha256']
   * @returns {Buffer}  DER-encoded signature.
   */
  sign(data, alg = 'sha256') {
    if (!this._priv) throw new Error('No private key available');
    const s = crypto.createSign(alg);
    s.update(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return s.sign({ key: this._priv, padding: crypto.constants.RSA_PKCS1_PSS_PADDING });
  }

  /**
   * Verify an RSA-PSS signature.
   * @param {Buffer|string} data
   * @param {Buffer} sig
   * @param {string} [alg='sha256']
   * @returns {boolean}
   */
  verify(data, sig, alg = 'sha256') {
    if (!this._pub) throw new Error('No public key available');
    const v = crypto.createVerify(alg);
    v.update(Buffer.isBuffer(data) ? data : Buffer.from(data));
    try {
      return v.verify({ key: this._pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, sig);
    } catch {
      return false;
    }
  }

  /**
   * Encrypt arbitrarily large data using RSA+AES-GCM hybrid encryption.
   * A random AES key is generated, used to encrypt the payload, then the AES
   * key itself is RSA-encrypted and prepended to the blob.
   *
   * @param {Buffer|string} plaintext
   * @returns {Buffer}  [keyLen:4][encryptedAESKey:keyLen][encryptedData:N]
   */
  hybridEncrypt(plaintext) {
    if (!this._pub) throw new Error('No public key available');
    const aes    = AESCipher.generate();
    const encKey = this.encrypt(aes.keyBuffer());
    const encDat = aes.encrypt(plaintext);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(encKey.length, 0);
    return Buffer.concat([lenBuf, encKey, encDat]);
  }

  /**
   * Decrypt a hybrid blob produced by {@link hybridEncrypt}.
   * @param {Buffer|string} data
   * @returns {Buffer}
   */
  hybridDecrypt(data) {
    if (!this._priv) throw new Error('No private key available');
    const buf    = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const keyLen = buf.readUInt32BE(0);
    const rawKey = this.decrypt(buf.slice(4, 4 + keyLen));
    return new AESCipher(rawKey).decrypt(buf.slice(4 + keyLen));
  }

  /** @returns {string|null} Public key PEM. */
  publicKeyPEM()  { return this._pub; }

  /** @returns {string|null} Private key PEM. */
  privateKeyPEM() { return this._priv; }

  /** Return a public-only RSACipher (safe to share / serialize). */
  publicOnly() { return new RSACipher(this._pub, null); }
}

module.exports = { RSACipher };
