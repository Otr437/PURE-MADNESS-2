'use strict';

const assert = require('assert');
const {
  randomBytes, randomHex, sha256, sha512,
  hmac, timingSafeEq, zeroize, xorBufs,
  toBase64url, fromBase64url, safeStringEq,
} = require('../src/index');

// randomBytes
const rb = randomBytes(16);
assert.strictEqual(rb.length, 16, 'randomBytes length');
assert.ok(Buffer.isBuffer(rb), 'randomBytes returns Buffer');

// randomHex
const rh = randomHex(16);
assert.strictEqual(rh.length, 32, 'randomHex string length (2 * n)');
assert.ok(/^[0-9a-f]+$/.test(rh), 'randomHex is hex');

// sha256 deterministic
const h1 = sha256('hello');
const h2 = sha256(Buffer.from('hello'));
assert.deepStrictEqual(h1, h2, 'sha256 Buffer/string equivalence');
assert.strictEqual(h1.length, 32, 'sha256 output length');

// sha512
const h3 = sha512('hello');
assert.strictEqual(h3.length, 64, 'sha512 output length');

// hmac
const key  = randomBytes(32);
const mac1 = hmac(key, 'data');
const mac2 = hmac(key, 'data');
assert.deepStrictEqual(mac1, mac2, 'HMAC deterministic');
const mac3 = hmac(key, 'other');
assert.notDeepStrictEqual(mac1, mac3, 'Different data → different HMAC');

// timingSafeEq
assert.ok(timingSafeEq(Buffer.from('abc'), Buffer.from('abc')), 'Equal buffers');
assert.ok(!timingSafeEq(Buffer.from('abc'), Buffer.from('xyz')), 'Unequal buffers');
assert.ok(!timingSafeEq(Buffer.from('a'), Buffer.from('ab')),   'Different lengths');

// zeroize
const buf = Buffer.from('secret');
zeroize(buf);
assert.ok(buf.every(b => b === 0), 'Buffer should be zeroed');
zeroize(null); // should not throw

// xorBufs
const a   = Buffer.from([0xff, 0x00]);
const b   = Buffer.from([0x0f, 0xf0]);
const xor = xorBufs(a, b);
assert.deepStrictEqual(xor, Buffer.from([0xf0, 0xf0]), 'XOR result wrong');

// Base64url round-trip
const raw    = randomBytes(32);
const enc    = toBase64url(raw);
const dec    = fromBase64url(enc);
assert.deepStrictEqual(dec, raw, 'Base64url round-trip failed');
assert.ok(!/[+/=]/.test(enc), 'Base64url must not contain +, /, or =');

// safeStringEq
assert.ok(safeStringEq('hello', 'hello'), 'Same strings should be equal');
assert.ok(!safeStringEq('hello', 'world'), 'Different strings should not be equal');

console.log('crypto-utils: all tests passed');
