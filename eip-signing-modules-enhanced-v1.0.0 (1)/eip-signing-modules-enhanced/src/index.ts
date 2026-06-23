/**
 * eip-signing-modules — v1.0.0
 *
 * Unified, production-grade off-chain signing and account abstraction utilities
 * for Ethereum. Covers all 11 EIPs in the signatures / gasless / AA family.
 *
 * Modules:
 *   EIP191  — Simple personal message signing (EIP-191)
 *   EIP712  — Typed structured data signing (EIP-712)
 *   EIP1271 — Smart contract signature verification (EIP-1271)
 *   EIP2612 — Gasless ERC-20 permit approvals (EIP-2612)
 *   EIP4337 — Account abstraction via alt mempool (EIP-4337 v0.7)
 *   EIP6492 — Counterfactual signature validation (EIP-6492)
 *   EIP6900 — Modular smart accounts with plugins (EIP-6900)
 *   EIP7579 — Minimal modular smart account interfaces (EIP-7579)
 *   EIP7702 — EOA as smart contract — Pectra (EIP-7702)
 *   EIP7739 — Replay-safe typed signatures for smart accounts (EIP-7739)
 *   EIP8141 — Frame Transactions — native AA, post-quantum (EIP-8141, Hegota H2 2026)
 *
 * Error types:
 *   All modules throw typed errors from ./errors.ts — never bare Error strings.
 *   Import { ValidationError, ProviderError, SignatureError, ... } from "eip-signing-modules/errors"
 *
 * Validation utilities:
 *   Shared input validators used by all modules are exported from ./validate.ts
 */

export * as EIP191 from "./eip191.js";
export * as EIP712 from "./eip712.js";
export * as EIP1271 from "./eip1271.js";
export * as EIP2612 from "./eip2612.js";
export * as EIP4337 from "./eip4337.js";
export * as EIP6492 from "./eip6492.js";
export * as EIP6900 from "./eip6900.js";
export * as EIP7579 from "./eip7579.js";
export * as EIP7702 from "./eip7702.js";
export * as EIP7739 from "./eip7739.js";
export * as EIP8141 from "./eip8141.js";

export * from "./errors.js";
export * from "./validate.js";
