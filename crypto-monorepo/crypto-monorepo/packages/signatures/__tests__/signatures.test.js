'use strict';

const assert  = require('assert');
const crypto  = require('crypto');
const {
  hmacSign, hmacVerify,
  ed25519Generate, ed25519Sign, ed25519Verify,
  signJSON, verifyJSON,
} = require('../src/index');

// HMAC sign + verify
const key  = crypto.randomBytes(32);
const data = Buffer.from('authenticate me');
const mac  = hmacSign(data, key);
assert.ok(hmacVerify(data, mac, key), 'Valid HMAC should verify');
assert.ok(!hmacVerify(Buffer.from('tampered'), mac, key), 'Tampered data should not verify');
assert.ok(!hmacVerify(data, Buffer.from(mac).fill(0), key), 'Bad MAC should not verify');

// HMAC hex key variant
const hexKey = key.toString('hex');
const mac2   = hmacSign(data, hexKey);
assert.ok(hmacVerify(data, mac2, hexKey), 'Hex key HMAC should verify');

// Ed25519 generate + sign + verify
const { publicKey, privateKey } = ed25519Generate();
const msg = Buffer.from('ed25519 message');
const sig = ed25519Sign(msg, privateKey);
assert.ok(ed25519Verify(msg, sig, publicKey), 'Valid Ed25519 signature should verify');
assert.ok(!ed25519Verify(Buffer.from('wrong'), sig, publicKey), 'Tampered Ed25519 should not verify');

// JSON signing convenience
const obj = { userId: 123, role: 'admin' };
const { payload, sig: jsonSig } = signJSON(obj, key);
assert.ok(verifyJSON(payload, jsonSig, key), 'JSON signature should verify');
assert.ok(!verifyJSON('{"tampered":true}', jsonSig, key), 'Tampered JSON should not verify');

console.log('signatures: all tests passed');
