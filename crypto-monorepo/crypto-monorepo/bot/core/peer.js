'use strict';

/**
 * bot/core/peer.js
 * Multi-agent peer communication over TCP using the EncryptedChannel.
 *
 * Two bot instances negotiate an ECDH handshake then exchange length-prefixed
 * JSON messages, fully encrypted with AES-256-GCM.
 *
 * Wire protocol (after handshake):
 *   [length: 4 bytes BE][encrypted frame: N bytes]
 *
 * Pure Node.js (net module) — zero external deps.
 */

require('./resolver');

const net    = require('net');
const crypto = require('crypto');
const CONFIG = require('../config/config');
const { audit }          = require('./audit');
const { getLogger }      = require('@crypto-monorepo/shared');
const { EncryptedChannel } = require('@crypto-monorepo/encrypted-channel');
const { ECDHKeyExchange }  = require('@crypto-monorepo/ecdh');
const { toBase64url, fromBase64url } = require('@crypto-monorepo/crypto-utils');

const log = getLogger('peer');

// Shared deterministic salt for in-process or loopback peers (dev mode)
// In production replace with a salt exchange step in the handshake.
const FIXED_SALT = Buffer.alloc(32, 0xAB);

function _patchDeriveForFixedSalt() {
  const origDerive = ECDHKeyExchange.prototype.deriveAESKey;
  ECDHKeyExchange.prototype.deriveAESKey = function(peer, info = 'aes-key') {
    return origDerive.call(this, peer, info, FIXED_SALT);
  };
}
_patchDeriveForFixedSalt();

// ── Message framing ───────────────────────────────────────────────────────────

function _writeFrame(socket, channel, obj) {
  const encrypted = channel.send(Buffer.from(JSON.stringify(obj)));
  const lenBuf    = Buffer.alloc(4);
  lenBuf.writeUInt32BE(encrypted.length, 0);
  socket.write(Buffer.concat([lenBuf, encrypted]));
}

function _makeFrameParser(channel, onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const msgLen = buf.readUInt32BE(0);
      if (buf.length < 4 + msgLen) break;
      const frame = buf.slice(4, 4 + msgLen);
      buf         = buf.slice(4 + msgLen);
      try {
        const { data } = channel.receive(frame);
        const msg = JSON.parse(data.toString('utf8'));
        onMessage(msg);
      } catch (err) {
        log.warn('Frame parse error', { error: err.message });
      }
    }
  };
}

// ── PeerServer ────────────────────────────────────────────────────────────────

class PeerServer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.port]
   * @param {string} [opts.host]
   * @param {Function} opts.onMessage  (msg, reply) => void | Promise<void>
   */
  constructor({ port, host, onMessage } = {}) {
    this._port      = port || CONFIG.peerPort;
    this._host      = host || CONFIG.peerHost;
    this._onMessage = onMessage || (() => {});
    this._server    = null;
    this._clients   = new Map(); // id → { socket, channel }
  }

  /**
   * Start listening for peer connections.
   * @returns {Promise<void>}
   */
  listen() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => this._handleClient(socket));
      this._server.once('error', reject);
      this._server.listen(this._port, this._host, () => {
        log.info('PeerServer listening', { host: this._host, port: this._port });
        audit('peer.server.start', { host: this._host, port: this._port });
        resolve();
      });
    });
  }

  _handleClient(socket) {
    const id      = crypto.randomBytes(4).toString('hex');
    const channel = new EncryptedChannel();
    let   ready   = false;
    let   buf     = Buffer.alloc(0);

    log.info('Peer connected', { id, remote: socket.remoteAddress });

    // Handshake: wait for initiator hello, respond, channel is ready
    socket.once('data', (chunk) => {
      try {
        const hello  = JSON.parse(chunk.toString('utf8'));
        const reply  = channel.respondHandshake(hello.publicKey);
        socket.write(JSON.stringify(reply) + '\n');
        ready = true;

        this._clients.set(id, { socket, channel });
        audit('peer.server.handshake', { id });

        const parser = _makeFrameParser(channel, (msg) => {
          const reply = (response) => _writeFrame(socket, channel, response);
          this._onMessage(msg, reply, id);
        });

        socket.on('data', parser);
      } catch (err) {
        log.warn('Handshake failed', { id, error: err.message });
        socket.destroy();
      }
    });

    socket.on('close', () => {
      this._clients.delete(id);
      log.info('Peer disconnected', { id });
    });

    socket.on('error', (err) => log.warn('Socket error', { id, error: err.message }));
  }

  /**
   * Broadcast a message to all connected peers.
   * @param {object} obj
   */
  broadcast(obj) {
    for (const { socket, channel } of this._clients.values()) {
      try { _writeFrame(socket, channel, obj); } catch {}
    }
  }

  /**
   * Send to a specific peer by id.
   */
  send(peerId, obj) {
    const client = this._clients.get(peerId);
    if (!client) throw new Error(`Peer not found: ${peerId}`);
    _writeFrame(client.socket, client.channel, obj);
  }

  /** @returns {string[]} Connected peer IDs. */
  peers() { return [...this._clients.keys()]; }

  close() { if (this._server) this._server.close(); }
}

// ── PeerClient ────────────────────────────────────────────────────────────────

class PeerClient {
  /**
   * @param {object} [opts]
   * @param {number} [opts.port]
   * @param {string} [opts.host]
   * @param {Function} opts.onMessage  (msg) => void | Promise<void>
   */
  constructor({ port, host, onMessage } = {}) {
    this._port      = port || CONFIG.peerPort;
    this._host      = host || CONFIG.peerHost;
    this._onMessage = onMessage || (() => {});
    this._socket    = null;
    this._channel   = null;
  }

  /**
   * Connect to a PeerServer and complete the ECDH handshake.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      this._socket  = net.createConnection({ host: this._host, port: this._port });
      this._channel = new EncryptedChannel();

      this._socket.once('error', reject);

      this._socket.once('connect', () => {
        // Send initiator hello
        const hello = this._channel.initiateHandshake();
        this._socket.write(JSON.stringify(hello));

        // Wait for responder reply
        this._socket.once('data', (chunk) => {
          try {
            const reply = JSON.parse(chunk.toString('utf8').split('\n')[0]);
            this._channel.completeHandshake(reply.publicKey);
            audit('peer.client.connected', { host: this._host, port: this._port });

            const parser = _makeFrameParser(this._channel, this._onMessage);
            this._socket.on('data', parser);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    });
  }

  /**
   * Send a message to the server peer.
   * @param {object} obj
   */
  send(obj) {
    if (!this._channel?.isEstablished()) throw new Error('Not connected');
    _writeFrame(this._socket, this._channel, obj);
  }

  disconnect() { if (this._socket) this._socket.destroy(); }
}

module.exports = { PeerServer, PeerClient };
