'use strict';

const assert = require('assert');
const { AESCBCCipher } = require('../src/index');

// Basic encrypt / decrypt
const key    = AESCBCCipher.generate();
const plain  = Buffer.from('hello CBC world');
const ct     = key.encrypt(plain);
const result = key.decrypt(ct);
assert.deepStrictEqual(result, plain, 'Round-trip failed');

// JSON round-trip
const obj  = { mode: 'cbc', data: [1, 2, 3] };
const ct2  = key.encryptJSON(obj);
const res2 = key.decryptJSON(ct2);
assert.deepStrictEqual(res2, obj, 'JSON round-trip failed');

// Hex constructor round-trip
const hex = key.keyHex();
const k2  = new AESCBCCipher(hex);
assert.deepStrictEqual(k2.keyBuffer(), key.keyBuffer(), 'Hex constructor failed');

// Different IVs produce different ciphertexts
const ct3 = key.encrypt(plain);
assert.notDeepStrictEqual(ct, ct3, 'IVs should differ per call');

// Block-boundary alignment (plaintext already block size)
const blockPlain = Buffer.alloc(16, 0x41);
const ctBlock    = key.encrypt(blockPlain);
const resBlock   = key.decrypt(ctBlock);
assert.deepStrictEqual(resBlock, blockPlain, 'Block-aligned round-trip failed');

console.log('aes-cbc: all tests passed');
