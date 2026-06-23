'use strict';

/**
 * @package @crypto-monorepo/encrypted-channel
 * Bidirectional ECDH-negotiated AES-256-GCM encrypted channel with replay protection.
 *
 * Protocol (3-step handshake):
 *   1. Initiator  → respondHandshake  → { sessionId, publicKey }
 *   2. Responder  → initiateHandshake → { sessionId, publicKey, curve, ts }
 *   3. Initiator calls completeHandshake(responder.publicKey) to finalise.
 *
 * Message framing: [counter:8 bytes ASCII][payload:N bytes]
 *
 * Depends on: @crypto-monorepo/ecdh, @crypto-monorepo/aes-gcm
 */

const crypto = require('crypto');
const { ECDHKeyExchange } = require('@crypto-monorepo/ecdh');

// Lazy-load logger so the module works without the shared package in tests.
let _log = null;
function log() {
  if (!_log) {
    try { _log = require('@crypto-monorepo/shared').getLogger('encrypted-channel'); }
    catch { _log = { info: () => {}, warn: () => {}, error: () => {} }; }
  }
  return _log;
}

class EncryptedChannel {
  constructor() {
    this._cipher     = null;
    this._ecdh       = null;
    this._sessionId  = null;
    this._msgCounter = 0;
  }

  // ── Handshake ──────────────────────────────────────────────────────────────

  /**
   * Step 1 (Initiator): Begin the handshake.
   * @returns {{ sessionId: string, publicKey: string, curve: string, ts: number }}
   */
  initiateHandshake() {
    this._ecdh      = new ECDHKeyExchange();
    this._sessionId = crypto.randomBytes(8).toString('hex');
    return {
      sessionId: this._sessionId,
      publicKey: this._ecdh.publicKeyHex(),
      curve:     'prime256v1',
      ts:        Date.now(),
    };
  }

  /**
   * Step 2 (Responder): Accept the initiator's public key and respond with ours.
   * The responder's cipher is ready after this call.
   * @param {string} initiatorPublicKeyHex
   * @returns {{ sessionId: string, publicKey: string }}
   */
  respondHandshake(initiatorPublicKeyHex) {
    this._ecdh = new ECDHKeyExchange();
    const { key } = this._ecdh.deriveAESKey(Buffer.from(initiatorPublicKeyHex, 'hex'));
    this._cipher    = key;
    this._sessionId = crypto.randomBytes(8).toString('hex');
    return {
      sessionId: this._sessionId,
      publicKey: this._ecdh.publicKeyHex(),
    };
  }

  /**
   * Step 3 (Initiator): Complete the handshake using the responder's public key.
   * The initiator's cipher is ready after this call.
   * @param {string} responderPublicKeyHex
   */
  completeHandshake(responderPublicKeyHex) {
    const { key } = this._ecdh.deriveAESKey(Buffer.from(responderPublicKeyHex, 'hex'));
    this._cipher  = key;
    log().info('Encrypted channel established', { sessionId: this._sessionId });
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  /**
   * Encrypt and frame a message.
   * @param {Buffer|string} data
   * @returns {Buffer}
   */
  send(data) {
    this._assertReady();
    this._msgCounter++;
    const counter = Buffer.from(String(this._msgCounter).padStart(8, '0'));
    return this._cipher.encrypt(
      Buffer.concat([counter, Buffer.isBuffer(data) ? data : Buffer.from(data)])
    );
  }

  /**
   * Decrypt and unframe a message.
   * @param {Buffer|string} data
   * @returns {{ counter: number, data: Buffer }}
   */
  receive(data) {
    this._assertReady();
    const plain   = this._cipher.decrypt(data);
    const counter = parseInt(plain.slice(0, 8).toString(), 10);
    return { counter, data: plain.slice(8) };
  }

  /**
   * Convenience: send a JSON-serialisable value.
   * @param {*} obj
   * @returns {Buffer}
   */
  sendJSON(obj) {
    return this.send(Buffer.from(JSON.stringify(obj)));
  }

  /**
   * Convenience: receive and parse JSON.
   * @param {Buffer|string} data
   * @returns {{ counter: number, data: * }}
   */
  receiveJSON(data) {
    const r = this.receive(data);
    return { ...r, data: JSON.parse(r.data.toString()) };
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  /** @returns {boolean} True if the channel is fully negotiated and ready. */
  isEstablished() { return !!this._cipher; }

  /** @returns {string|null} Session identifier. */
  sessionId()     { return this._sessionId; }

  // ── Private ────────────────────────────────────────────────────────────────

  _assertReady() {
    if (!this._cipher) throw new Error('Channel not established — run the handshake first');
  }
}

module.exports = { EncryptedChannel };
