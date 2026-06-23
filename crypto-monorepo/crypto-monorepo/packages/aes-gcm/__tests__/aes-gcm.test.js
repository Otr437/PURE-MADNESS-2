'use strict';

const assert = require('assert');
const { AESCipher } = require('../src/index');

// Basic encrypt / decrypt
const key    = AESCipher.generate();
const plain  = Buffer.from('hello world');
const ct     = key.encrypt(plain);
const result = key.decrypt(ct);
assert.deepStrictEqual(result, plain, 'Round-trip failed');

// With AAD
const aad  = Buffer.from('channel-id-42');
const ct2  = key.encrypt(plain, aad);
const res2 = key.decrypt(ct2, aad);
assert.deepStrictEqual(res2, plain, 'AAD round-trip failed');

// Wrong AAD must throw
assert.throws(() => key.decrypt(ct2, Buffer.from('wrong')), 'Bad AAD should throw');

// JSON round-trip
const obj  = { foo: 'bar', n: 42 };
const ct3  = key.encryptJSON(obj);
const res3 = key.decryptJSON(ct3);
assert.deepStrictEqual(res3, obj, 'JSON round-trip failed');

// Key rotation
const { newKey, data: rotated } = key.rotate(ct);
const res4 = newKey.decrypt(rotated);
assert.deepStrictEqual(res4, plain, 'Key rotation failed');

// Constructor variants
const hexKey = key.keyHex();
const k2     = new AESCipher(hexKey);
assert.deepStrictEqual(k2.keyBuffer(), key.keyBuffer(), 'Hex constructor failed');

console.log('aes-gcm: all tests passed');
