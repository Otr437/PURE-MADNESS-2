# eip-signing-modules v1.0.0

Production-grade off-chain signing and account abstraction utilities for Ethereum.
Covers all 11 EIPs in the signatures / gasless / AA family.

## Modules

| Module     | EIP      | Purpose                                              |
|------------|----------|------------------------------------------------------|
| `eip191`   | EIP-191  | Simple personal message signing                      |
| `eip712`   | EIP-712  | Typed structured data signing                        |
| `eip1271`  | EIP-1271 | Smart contract signature verification                |
| `eip2612`  | EIP-2612 | Gasless ERC-20 permit approvals                      |
| `eip4337`  | EIP-4337 | Account abstraction — UserOps, bundlers, paymasters  |
| `eip6492`  | EIP-6492 | Counterfactual contract signature validation         |
| `eip6900`  | EIP-6900 | Modular smart accounts with plugin system            |
| `eip7579`  | EIP-7579 | Minimal modular smart account interfaces             |
| `eip7702`  | EIP-7702 | EOA as smart contract (Pectra upgrade, May 2025)     |
| `eip7739`  | EIP-7739 | Replay-safe typed signatures for smart accounts      |
| `eip8141`  | EIP-8141 | Frame Transactions — native AA, post-quantum (Hegota H2 2026) |

## Enhancements in v1.0.0

- **Typed error hierarchy** — all modules throw named error classes (`ValidationError`,
  `ProviderError`, `SignatureError`, `ContractSignatureError`, `DeadlineExpiredError`,
  `UnknownSchemeError`, `NotEIP6492Error`, `InvalidAddressError`, `InvalidHexError`).
  Never bare `Error` strings. Catch by `instanceof` without string parsing.
- **Full input validation** — every public function validates all inputs before
  any async work: zero-address guards, bytes32 format checks, deadline expiry,
  gas field overflow guards, bigint range checks, non-empty array checks.
- **Complete JSDoc** — every exported function, type, and constant documented with
  `@param`, `@returns`, `@throws`, and security notes.
- **Strict TypeScript** — zero `any`, explicit return types, discriminated union results.
- **Security guards** — deadline checks before signing and submission, staticCall-only
  for all read-only contract queries, revert-treated-as-invalid for EIP-1271.
- **Named constants** — all magic values extracted: `EIP1271_MAGIC_VALUE`,
  `EIP6492_MAGIC_SUFFIX`, `ENTRY_POINT_V07`, `DELEGATION_PREFIX`, `SIGNING_SCHEME.*`,
  `EXEC_MODE_*`, `MODULE_TYPE_*`, `MAX_MESSAGE_BYTES`, deadline constants.
- **Shared validation module** — `validate.ts` exports all guards for use in
  consuming code without reimplementing.
- **Result types** — every verify/check function returns a typed result object
  with a `valid` boolean plus context fields, never a raw boolean alone.

## Install

```bash
npm install eip-signing-modules ethers
```

## Quick Start

```typescript
import {
  EIP191, EIP712, EIP1271, EIP2612, EIP4337,
  EIP6492, EIP6900, EIP7579, EIP7702, EIP7739, EIP8141,
  ValidationError, ProviderError, SignatureError,
} from "eip-signing-modules";

// ── EIP-191: personal_sign ────────────────────────────────────────────────────
const result = await EIP191.signMessage(wallet, "Hello Ethereum");
// result.signature, result.prefixedHash, result.components.v/r/s

const verified = EIP191.verifyMessage("Hello Ethereum", result.signature, wallet.address);
// verified.valid, verified.recoveredAddress

// ── EIP-712: typed data ───────────────────────────────────────────────────────
const domain = EIP712.buildDomain("MyApp", "1", 1, contractAddress);
const types = { Transfer: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }] };
const typed = await EIP712.signTypedData(wallet, domain, types, { to: "0x...", amount: 1000n });
// typed.digest, typed.domainSeparator, typed.structHash

// ── EIP-2612: gasless permit ──────────────────────────────────────────────────
const permit = await EIP2612.signPermit(
  wallet, tokenAddress, spenderAddress, 1000n,
  EIP2612.oneHourDeadline(), chainId
);
// permit.v, permit.r, permit.s, permit.digest
await EIP2612.submitPermit(provider, tokenAddress, permit);

// ── EIP-4337: UserOperation ───────────────────────────────────────────────────
const nonce = await EIP4337.getAccountNonce(provider, accountAddress);
const userOp = EIP4337.buildUserOperation({
  sender: accountAddress,
  nonce,
  callData: EIP4337.encodeExecuteCall(target, 0n, "0x"),
  gasParams: {
    verificationGasLimit: 150_000n, callGasLimit: 100_000n,
    maxPriorityFeePerGas: 1n, maxFeePerGas: 20n,
  },
});
const signedOp = await EIP4337.signUserOperation(wallet, userOp, provider);

// ── EIP-6492: counterfactual ──────────────────────────────────────────────────
const factoryCalldata = EIP6492.encodeSimpleAccountFactoryCalldata(wallet.address, 0n);
const wrapped = EIP6492.wrapWithEIP6492(factoryAddress, factoryCalldata, innerSig);
const { valid, accountType } = await EIP6492.validateUniversal(
  provider, accountAddress, "message", wrapped
);

// ── EIP-7702: EOA delegation ──────────────────────────────────────────────────
const auth = { chainId: 1n, address: implAddress, nonce: 0n };
const signedAuth = await EIP7702.signAuthorization(wallet, auth);
const impl = await EIP7702.getDelegatedImplementation(provider, wallet.address);

// ── EIP-7739: account-bound typed signatures ─────────────────────────────────
const accountDomain = EIP7739.buildAccountDomain(accountAddress, chainId);
const r7739 = await EIP7739.signWithEIP7739(wallet, accountDomain, appDomain, types, value);
// r7739.outerDigest, r7739.contentsHash, r7739.contentsType

// ── EIP-8141: Frame Transactions (Hegota H2 2026) ─────────────────────────────
const frameTx = EIP8141.buildFrameTx({
  sender: wallet.address,
  nonce: 0n,
  maxFeePerGas: 20n * 10n ** 9n,
  maxPriorityFeePerGas: 1n * 10n ** 9n,
  gasLimit: 21_000n,
  to: recipientAddress,
  value: 1n * 10n ** 18n,
  signerKey: wallet.address,
});
const signedFrame = await EIP8141.signFrameTxECDSA(wallet, frameTx);
const { valid: frameValid } = EIP8141.verifyFrameTxECDSA(signedFrame);

// ── Error handling ────────────────────────────────────────────────────────────
try {
  await EIP2612.signPermit(wallet, tokenAddress, spenderAddress, 0n, deadline, chainId);
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(`Invalid input: [${err.field}] ${err.message}`);
  } else if (err instanceof ProviderError) {
    console.error(`Contract call failed: ${err.message}`);
  }
}
```

## Error Types

| Class                   | Code                        | When thrown                                         |
|-------------------------|-----------------------------|-----------------------------------------------------|
| `ValidationError`       | `VALIDATION_ERROR`          | Input fails type/range/format check                 |
| `ProviderError`         | `PROVIDER_ERROR`            | ethers provider or contract call fails              |
| `SignatureError`        | `SIGNATURE_ERROR`           | Signature is malformed or recovery fails            |
| `SignerMismatchError`   | `SIGNER_MISMATCH`           | Recovered signer ≠ expected address                 |
| `ContractSignatureError`| `CONTRACT_SIGNATURE_INVALID`| EIP-1271 returned wrong magic value                 |
| `DeadlineExpiredError`  | `DEADLINE_EXPIRED`          | Permit or authorization deadline is in the past     |
| `UnknownSchemeError`    | `UNKNOWN_SCHEME`            | No EIP-8141 adapter registered for signing scheme   |
| `NotEIP6492Error`       | `NOT_EIP6492`               | Signature lacks EIP-6492 magic suffix               |
| `InvalidAddressError`   | `INVALID_ADDRESS`           | String is not a valid checksummed Ethereum address  |
| `InvalidHexError`       | `INVALID_HEX`               | String is not valid 0x-prefixed hex                 |

## Notes

- **EIP-8141** targets Hegota (H2 2026). The `SigningSchemeRegistry` accepts
  custom adapters for BLS12-381, Dilithium3, Falcon-512, and SPHINCS+.
- All modules are pure off-chain utilities — no bundler or node required for signing.
- All modules use `ethers` v6 exclusively. ethers v5 is not supported.
- Peer dependency: `ethers ^6.0.0`.

## License

MIT
