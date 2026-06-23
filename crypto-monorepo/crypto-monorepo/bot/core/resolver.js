'use strict';

/**
 * bot/core/resolver.js
 * Registers workspace package paths so require('@crypto-monorepo/...')
 * works without npm install or symlinks.
 * Must be required FIRST before any other monorepo imports.
 */

const path   = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '../..');

const PKG_MAP = {
  '@crypto-monorepo/aes-gcm':           path.join(ROOT, 'packages/aes-gcm/src/index.js'),
  '@crypto-monorepo/aes-cbc':           path.join(ROOT, 'packages/aes-cbc/src/index.js'),
  '@crypto-monorepo/rsa-hybrid':        path.join(ROOT, 'packages/rsa-hybrid/src/index.js'),
  '@crypto-monorepo/ecdh':              path.join(ROOT, 'packages/ecdh/src/index.js'),
  '@crypto-monorepo/encrypted-channel': path.join(ROOT, 'packages/encrypted-channel/src/index.js'),
  '@crypto-monorepo/key-derivation':    path.join(ROOT, 'packages/key-derivation/src/index.js'),
  '@crypto-monorepo/signatures':        path.join(ROOT, 'packages/signatures/src/index.js'),
  '@crypto-monorepo/secure-key-store':  path.join(ROOT, 'packages/secure-key-store/src/index.js'),
  '@crypto-monorepo/crypto-utils':      path.join(ROOT, 'packages/crypto-utils/src/index.js'),
  '@crypto-monorepo/shared':            path.join(ROOT, 'shared/logger.js'),
};

const _orig = Module._resolveFilename.bind(Module);
Module._resolveFilename = (req, ...args) => PKG_MAP[req] || _orig(req, ...args);

module.exports = PKG_MAP;
