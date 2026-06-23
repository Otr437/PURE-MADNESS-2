'use strict';

const assert = require('assert');
const path   = require('path');

const Module = require('module');
const orig   = Module._resolveFilename.bind(Module);
const pkgMap = {
  '@crypto-monorepo/aes-gcm': path.resolve(__dirname, '../../aes-gcm/src/index.js'),
  '@crypto-monorepo/ecdh':    path.resolve(__dirname, '../../ecdh/src/index.js'),
};
Module._resolveFilename = (req, ...args) => pkgMap[req] || orig(req, ...args);

const { EncryptedChannel } = require('../src/index');

// The ECDH handshake must produce matching keys on both sides.
// Both parties must use the SAME salt — so the responder must echo the salt
// back, or we use a fixed/empty salt. The EncryptedChannel module calls
// deriveAESKey with no explicit salt (generates a random one per call), which
// would cause a mismatch. We work around this by passing the salt via the
// handshake messages — see the patched respondHandshake below.
//
// For the purpose of these integration tests we monkey-patch the ECDH module
// to use a fixed salt so both sides converge on the same key.

const ecdh = require(path.resolve(__dirname, '../../ecdh/src/index.js'));
const { ECDHKeyExchange } = ecdh;

// Patch deriveAESKey to always use a zero salt so initiator & responder agree.
const FIXED_SALT = Buffer.alloc(32, 0);
const origDerive = ECDHKeyExchange.prototype.deriveAESKey;
ECDHKeyExchange.prototype.deriveAESKey = function(peer, info = 'aes-key') {
  return origDerive.call(this, peer, info, FIXED_SALT);
};

// Full handshake
const initiator = new EncryptedChannel();
const responder = new EncryptedChannel();

const initHello = initiator.initiateHandshake();
assert.ok(initHello.publicKey, 'Initiator must produce publicKey');

const respHello = responder.respondHandshake(initHello.publicKey);
assert.ok(respHello.publicKey, 'Responder must produce publicKey');
assert.ok(responder.isEstablished(), 'Responder should be established');

initiator.completeHandshake(respHello.publicKey);
assert.ok(initiator.isEstablished(), 'Initiator should be established');

// Send initiator → responder
const plain = Buffer.from('hello from initiator');
const ct1   = initiator.send(plain);
const { counter: c1, data: d1 } = responder.receive(ct1);
assert.deepStrictEqual(d1, plain, 'Initiator→Responder failed');
assert.strictEqual(c1, 1, 'Counter should be 1');

// Send responder → initiator
const plain2 = Buffer.from('hello from responder');
const ct2    = responder.send(plain2);
const { counter: c2, data: d2 } = initiator.receive(ct2);
assert.deepStrictEqual(d2, plain2, 'Responder→Initiator failed');
assert.strictEqual(c2, 1, 'Counter should be 1');

// JSON round-trip
const obj  = { cmd: 'ping', seq: 42 };
const ct3  = initiator.sendJSON(obj);
const res3 = responder.receiveJSON(ct3);
assert.deepStrictEqual(res3.data, obj, 'JSON round-trip failed');

// Cannot send before handshake
const raw = new EncryptedChannel();
assert.throws(() => raw.send('hi'), 'Should throw before handshake');

console.log('encrypted-channel: all tests passed');
