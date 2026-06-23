'use strict';

const assert = require('assert');
const path   = require('path');

// Resolve sibling workspace package locally
const Module = require('module');
const orig   = Module._resolveFilename.bind(Module);
Module._resolveFilename = (req, ...args) =>
  req === '@crypto-monorepo/aes-gcm'
    ? path.resolve(__dirname, '../../aes-gcm/src/index.js')
    : orig(req, ...args);

const { SecureKeyStore } = require('../src/index');
const crypto = require('crypto');

// Store and retrieve
const store  = new SecureKeyStore();
const rawKey = crypto.randomBytes(32);
store.store('my-aes-key', rawKey, { purpose: 'encryption' });

const retrieved = store.retrieve('my-aes-key');
assert.deepStrictEqual(retrieved, rawKey, 'Retrieved key must match stored');

// Access tracking
const entry = store.list().find(e => e.id === 'my-aes-key');
assert.strictEqual(entry.accessCount, 1, 'Access count should be 1');
assert.ok(entry.lastAccessed, 'lastAccessed should be set');

// has()
assert.ok(store.has('my-aes-key'),    'Should exist');
assert.ok(!store.has('nonexistent'),  'Should not exist');

// Rotate key
const newRaw = store.rotate('my-aes-key');
assert.strictEqual(newRaw.length, 32, 'Rotated key should be 32 bytes');
assert.notDeepStrictEqual(newRaw, rawKey, 'Rotated key should differ');
const rotatedMeta = store.list().find(e => e.id === 'my-aes-key');
assert.ok(rotatedMeta.meta.rotatedAt, 'rotatedAt should be in meta');

// Delete
store.delete('my-aes-key');
assert.ok(!store.has('my-aes-key'), 'Key should be deleted');
assert.throws(() => store.retrieve('my-aes-key'), 'Retrieve after delete should throw');

// Master key rotation
const s2 = new SecureKeyStore();
s2.store('k1', crypto.randomBytes(32));
s2.store('k2', crypto.randomBytes(16));
const orig1 = s2.retrieve('k1');
const orig2 = s2.retrieve('k2');

const { store: s3 } = s2.rotateMasterKey();
assert.deepStrictEqual(s3.retrieve('k1'), orig1, 'k1 intact after master rotation');
assert.deepStrictEqual(s3.retrieve('k2'), orig2, 'k2 intact after master rotation');

// Missing key throws
assert.throws(() => store.retrieve('ghost'), /Key not found/);

console.log('secure-key-store: all tests passed');
