'use strict';

const assert = require('assert');
const { hkdf, pbkdf2, scrypt, deriveAESKey } = require('../src/index');

// HKDF — deterministic with same inputs
const ikm  = Buffer.from('input keying material');
const salt = Buffer.from('random-salt');
const k1   = hkdf(ikm, salt, 'test', 32);
const k2   = hkdf(ikm, salt, 'test', 32);
assert.deepStrictEqual(k1, k2, 'HKDF must be deterministic');
assert.strictEqual(k1.length, 32, 'HKDF output length wrong');

// HKDF — different info → different key
const k3 = hkdf(ikm, salt, 'other-info', 32);
assert.notDeepStrictEqual(k1, k3, 'Different info must yield different key');

// HKDF — variable length
const k64 = hkdf(ikm, salt, 'x', 64);
assert.strictEqual(k64.length, 64, 'HKDF 64-byte output length wrong');

// PBKDF2 — round-trip with same salt
const pw   = 'my-secure-password';
const { key: pk, salt: ps, iterations } = pbkdf2(pw, null, 10000);
assert.strictEqual(pk.length, 32,    'PBKDF2 key length');
assert.strictEqual(iterations, 10000, 'PBKDF2 iterations');

const { key: pk2 } = pbkdf2(pw, ps, 10000);
assert.deepStrictEqual(pk, pk2, 'PBKDF2 must be deterministic with same salt');

// scrypt
const { key: sk, salt: ss } = scrypt('password', null, 32);
assert.strictEqual(sk.length, 32, 'scrypt key length');
const { key: sk2 } = scrypt('password', ss, 32);
assert.deepStrictEqual(sk, sk2, 'scrypt must be deterministic with same salt');

// deriveAESKey convenience
const { key: aesKey, salt: aesSalt } = deriveAESKey('my-password');
assert.strictEqual(aesKey.length, 32, 'deriveAESKey must produce 32-byte key');
const { key: aesKey2 } = deriveAESKey('my-password', aesSalt);
assert.deepStrictEqual(aesKey, aesKey2, 'deriveAESKey deterministic with same salt');

console.log('key-derivation: all tests passed');
