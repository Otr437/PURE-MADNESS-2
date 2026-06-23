'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path   = require('path');

const Module = require('module');
const orig   = Module._resolveFilename.bind(Module);
Module._resolveFilename = (req, ...args) =>
  req === '@crypto-monorepo/aes-gcm'
    ? path.resolve(__dirname, '../../aes-gcm/src/index.js')
    : orig(req, ...args);

const { RSACipher } = require('../src/index');

// Key generation + basic encrypt/decrypt
const rsa   = RSACipher.generate(2048);
const plain = Buffer.from('secret payload');
const ct    = rsa.encrypt(plain);
const res   = rsa.decrypt(ct);
assert.deepStrictEqual(res, plain, 'RSA OAEP round-trip failed');

// Sign / verify
const data = Buffer.from('signed message');
const sig  = rsa.sign(data);
assert.ok(rsa.verify(data, sig),                          'Valid signature should verify');
assert.ok(!rsa.verify(Buffer.from('tampered'), sig),      'Tampered data should not verify');

// Hybrid encrypt/decrypt (large payload)
const large = crypto.randomBytes(10000);
const hct   = rsa.hybridEncrypt(large);
const hres  = rsa.hybridDecrypt(hct);
assert.deepStrictEqual(hres, large, 'Hybrid round-trip failed');

// Public-only clone cannot decrypt
const pubOnly = rsa.publicOnly();
assert.throws(() => pubOnly.decrypt(ct), 'Public-only should not decrypt');

// publicKeyPEM / privateKeyPEM
assert.ok(rsa.publicKeyPEM().startsWith('-----BEGIN'),  'publicKeyPEM should be PEM');
assert.ok(rsa.privateKeyPEM().startsWith('-----BEGIN'), 'privateKeyPEM should be PEM');

console.log('rsa-hybrid: all tests passed');
