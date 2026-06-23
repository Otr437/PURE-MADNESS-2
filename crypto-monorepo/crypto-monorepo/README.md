# crypto-monorepo

Full-stack Node.js encryption monorepo. Each package is self-contained with complete logic, a clean public API, and a test suite. Packages that depend on each other declare that dependency explicitly.

## Packages

| Package | Description | Depends on |
|---|---|---|
| `@crypto-monorepo/aes-gcm` | AES-256-GCM authenticated encryption | — |
| `@crypto-monorepo/aes-cbc` | AES-256-CBC encryption with PKCS#7 padding | — |
| `@crypto-monorepo/rsa-hybrid` | RSA-OAEP, RSA-PSS, RSA+AES hybrid | `aes-gcm` |
| `@crypto-monorepo/ecdh` | ECDH key exchange + HKDF key derivation | `aes-gcm` |
| `@crypto-monorepo/encrypted-channel` | ECDH-negotiated AES-GCM channel | `ecdh`, `aes-gcm` |
| `@crypto-monorepo/key-derivation` | HKDF, PBKDF2, scrypt | — |
| `@crypto-monorepo/signatures` | HMAC-SHA256, Ed25519, JSON signing | — |
| `@crypto-monorepo/secure-key-store` | Encrypted in-memory key store | `aes-gcm` |
| `@crypto-monorepo/crypto-utils` | SHA-2, HMAC, XOR, Base64url, timing-safe eq | — |

## Structure

```
crypto-monorepo/
├── package.json              # workspace root
├── shared/
│   └── logger.js             # shared structured logger
└── packages/
    ├── aes-gcm/
    │   ├── src/index.js
    │   ├── __tests__/
    │   └── package.json
    ├── aes-cbc/  ...
    ├── rsa-hybrid/  ...
    ├── ecdh/  ...
    ├── encrypted-channel/  ...
    ├── key-derivation/  ...
    ├── signatures/  ...
    ├── secure-key-store/  ...
    └── crypto-utils/  ...
```

## Running tests

Run all packages in one shot (no install needed — pure Node built-ins):

```bash
node run-tests.js
```

Or run a single package test:

```bash
node packages/aes-gcm/__tests__/aes-gcm.test.js
```

## Usage example

```js
const { AESCipher }       = require('@crypto-monorepo/aes-gcm');
const { ECDHKeyExchange }  = require('@crypto-monorepo/ecdh');
const { EncryptedChannel } = require('@crypto-monorepo/encrypted-channel');
const { SecureKeyStore }   = require('@crypto-monorepo/secure-key-store');
const { hmacSign }         = require('@crypto-monorepo/signatures');

// Generate an AES key and round-trip some data
const cipher = AESCipher.generate();
const ct     = cipher.encrypt('hello world');
console.log(cipher.decrypt(ct).toString()); // → hello world

// Negotiate a shared channel between two peers
const alice = new EncryptedChannel();
const bob   = new EncryptedChannel();
const hi    = alice.initiateHandshake();
const reply = bob.respondHandshake(hi.publicKey);
alice.completeHandshake(reply.publicKey);

const msg = alice.send('ping');
console.log(bob.receive(msg).data.toString()); // → ping
```

## Notes

- All crypto uses Node's built-in `crypto` module — zero npm dependencies.
- AES-GCM is preferred over AES-CBC for new designs (authenticated encryption).
- Key material is never logged; buffers containing secrets should be zeroized after use via `@crypto-monorepo/crypto-utils` `zeroize()`.
