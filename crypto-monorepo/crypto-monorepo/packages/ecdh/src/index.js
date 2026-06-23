'use strict';

/**
 * @package @crypto-monorepo/ecdh
 * Elliptic-Curve Diffie-Hellman key exchange with HKDF-based AES key derivation.
 *
 * Depends on: @crypto-monorepo/aes-gcm (peer)
 */

const crypto = require('crypto');
const { AESCipher } = require('@crypto-monorepo/aes-gcm');

class ECDHKeyExchange {
  /**
   * @param {string} [curve='prime256v1']  Named curve (prime256v1, secp384r1, secp521r1).
   */
  constructor(curve = 'prime256v1') {
    this._curve = curve;
    this._ecdh  = crypto.createECDH(curve);
    this._ecdh.generateKeys();
  }

  /** @type {Buffer} Uncompressed public key. */
  get publicKey()  { return this._ecdh.getPublicKey(); }

  /** @type {Buffer} Private key (keep secret). */
  get privateKey() { return this._ecdh.getPrivateKey(); }

  /** @returns {string} Hex-encoded public key. */
  publicKeyHex()  { return this._ecdh.getPublicKey('hex'); }

  /** @returns {string} Hex-encoded private key. */
  privateKeyHex() { return this._ecdh.getPrivateKey('hex'); }

  /**
   * Compute the raw ECDH shared secret with a peer's public key.
   * @param {Buffer|string} peerPublicKey  Buffer or hex string.
   * @returns {Buffer}
   */
  computeSecret(peerPublicKey) {
    return this._ecdh.computeSecret(
      Buffer.isBuffer(peerPublicKey) ? peerPublicKey : Buffer.from(peerPublicKey, 'hex')
    );
  }

  /**
   * Derive an AES-256-GCM key from the shared secret via HKDF (SHA-256).
   *
   * @param {Buffer|string} peerPublicKey
   * @param {string}        [info='aes-key']   HKDF context string.
   * @param {Buffer|null}   [salt=null]         Random 32-byte salt; generated if null.
   * @returns {{ key: AESCipher, salt: Buffer, sharedSecret: Buffer }}
   */
  deriveAESKey(peerPublicKey, info = 'aes-key', salt = null) {
    const secret  = this.computeSecret(peerPublicKey);
    const saltBuf = salt || crypto.randomBytes(32);

    // Two-step HKDF (extract → expand)
    const prk = crypto.createHmac('sha256', saltBuf).update(secret).digest();
    const okm = crypto.createHmac('sha256', prk)
      .update(Buffer.from(info + '\x01'))
      .digest()
      .slice(0, 32);

    return { key: new AESCipher(okm), salt: saltBuf, sharedSecret: secret };
  }
}

module.exports = { ECDHKeyExchange };
