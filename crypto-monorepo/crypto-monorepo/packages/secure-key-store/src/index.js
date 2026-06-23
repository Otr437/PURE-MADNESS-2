'use strict';

/**
 * @package @crypto-monorepo/secure-key-store
 * In-memory encrypted key store backed by AES-256-GCM.
 *
 * All stored keys are wrapped (encrypted) under a master AES key so that even
 * if the JS heap is inspected, raw key material is not sitting in plain Buffers.
 *
 * Depends on: @crypto-monorepo/aes-gcm
 */

const crypto    = require('crypto');
const { AESCipher } = require('@crypto-monorepo/aes-gcm');

class SecureKeyStore {
  /**
   * @param {Buffer|string|null} masterKey
   *   32-byte Buffer or hex string.  If null, a random master key is generated.
   */
  constructor(masterKey = null) {
    this._master = masterKey ? new AESCipher(masterKey) : AESCipher.generate();
    this._keys   = new Map(); // id → entry
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Encrypt and store a key.
   * @param {string}        id       Unique identifier for this key.
   * @param {Buffer|string} keyData  Raw key bytes (Buffer) or hex string.
   * @param {object}        [meta]   Arbitrary metadata (not encrypted).
   * @returns {string}  The id passed in.
   */
  store(id, keyData, meta = {}) {
    const buf = Buffer.isBuffer(keyData) ? keyData : Buffer.from(keyData, 'hex');
    this._keys.set(id, {
      id,
      encrypted:   this._master.encrypt(buf),
      meta,
      createdAt:   Date.now(),
      accessCount: 0,
      lastAccessed: null,
    });
    return id;
  }

  /**
   * Decrypt and return a stored key.
   * @param {string} id
   * @returns {Buffer}
   * @throws if id not found.
   */
  retrieve(id) {
    const entry = this._keys.get(id);
    if (!entry) throw new Error(`Key not found: ${id}`);
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    return this._master.decrypt(entry.encrypted);
  }

  /**
   * Rotate a stored key: replace it with new random bytes of the same length.
   * @param {string} id
   * @returns {Buffer}  The new raw key (caller should store this securely).
   */
  rotate(id) {
    const old    = this.retrieve(id);
    const newKey = crypto.randomBytes(old.length);
    this.store(id, newKey, { ...this._keys.get(id).meta, rotatedAt: Date.now() });
    old.fill(0); // zeroize old key in memory
    return newKey;
  }

  /**
   * Securely delete a key entry (zeroizes the encrypted buffer).
   * @param {string} id
   */
  delete(id) {
    const entry = this._keys.get(id);
    if (entry) {
      entry.encrypted.fill(0);
      this._keys.delete(id);
    }
  }

  /**
   * List all stored key entries (metadata only — no key material).
   * @returns {Array<{ id: string, meta: object, createdAt: number, accessCount: number, lastAccessed: number|null }>}
   */
  list() {
    return [...this._keys.values()].map(({ id, meta, createdAt, accessCount, lastAccessed }) => ({
      id,
      meta,
      createdAt,
      accessCount,
      lastAccessed,
    }));
  }

  /**
   * Check whether a key id exists in the store.
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this._keys.has(id);
  }

  /**
   * Re-wrap all stored keys under a new master key and return the new store.
   * Useful for master-key rotation.
   * @returns {{ store: SecureKeyStore, newMasterKeyHex: string }}
   */
  rotateMasterKey() {
    const newStore = new SecureKeyStore(); // fresh random master
    for (const entry of this._keys.values()) {
      const raw = this._master.decrypt(entry.encrypted);
      newStore.store(entry.id, raw, entry.meta);
      raw.fill(0);
    }
    return { store: newStore, newMasterKeyHex: newStore._master.keyHex() };
  }
}

module.exports = { SecureKeyStore };
