'use strict';

const assert = require('assert');
const path   = require('path');

// Local resolution fallback for monorepo without workspace links
const Module = require('module');
const orig   = Module._resolveFilename.bind(Module);
Module._resolveFilename = (req, ...args) => {
  if (req === '@crypto-monorepo/aes-gcm') return path.resolve(__dirname, '../../aes-gcm/src/index.js');
  return orig(req, ...args);
};

const { ECDHKeyExchange } = require('../src/index');

// Two-party key agreement
const alice = new ECDHKeyExchange();
const bob   = new ECDHKeyExchange();

const { key: aliceKey, salt } = alice.deriveAESKey(bob.publicKey);
const { key: bobKey }         = bob.deriveAESKey(alice.publicKey, 'aes-key', salt);

// Both should derive the same key
assert.deepStrictEqual(aliceKey.keyBuffer(), bobKey.keyBuffer(), 'Keys must match');

// Encrypt with one side, decrypt with the other
const plain = Buffer.from('shared secret message');
const ct    = aliceKey.encrypt(plain);
const res   = bobKey.decrypt(ct);
assert.deepStrictEqual(res, plain, 'Cross-side decrypt failed');

// Different curve
const alice384 = new ECDHKeyExchange('secp384r1');
const bob384   = new ECDHKeyExchange('secp384r1');
const { key: k384a, salt: s384 } = alice384.deriveAESKey(bob384.publicKey);
const { key: k384b }             = bob384.deriveAESKey(alice384.publicKey, 'aes-key', s384);
assert.deepStrictEqual(k384a.keyBuffer(), k384b.keyBuffer(), 'secp384r1 keys must match');

// Hex key accessors
assert.ok(alice.publicKeyHex().length > 0,  'publicKeyHex should return string');
assert.ok(alice.privateKeyHex().length > 0, 'privateKeyHex should return string');

console.log('ecdh: all tests passed');
