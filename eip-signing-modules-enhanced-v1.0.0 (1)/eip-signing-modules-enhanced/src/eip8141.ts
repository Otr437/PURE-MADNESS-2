/**
 * EIP-8141: Frame Transactions — v1.0.0
 *
 * Native account abstraction at the protocol level, targeted for the
 * Hegota upgrade (H2 2026). Supports arbitrary signing schemes including
 * ECDSA, BLS12-381, Schnorr, Ed25519, and post-quantum lattice-based schemes
 * (Dilithium3, Falcon-512, SPHINCS+).
 *
 * Key differences from ERC-4337:
 * - First-class protocol support — no alt mempool or bundler required.
 * - Signing scheme is declared in the transaction itself (signingScheme field).
 * - Gas sponsorship via paymasterData (same model as ERC-4337).
 * - Post-quantum schemes are declared in the SIGNING_SCHEME registry and
 *   pluggable via SigningSchemeRegistry — adapters added when libs ship.
 *
 * Status: Draft — targeted for Hegota (H2 2026). No canonical deployment.
 * This module provides off-chain construction, signing, and verification.
 *
 * Security properties:
 * - The 0x08141 type prefix prevents cross-type replay with EIP-1559/EIP-2930.
 * - ECDSA adapter is the only built-in scheme — PQ adapters must be registered.
 * - chainId=0 makes the tx valid on all chains; prefer explicit chain IDs.
 * - Verify signatures off-chain before broadcasting to avoid wasted fees.
 *
 * @see https://eips-wg.github.io/EIPs/8141/
 */

import { ethers } from "ethers";
import {
  assertNonZeroAddress,
  assertAddress,
  assertChainId,
  assertPositiveBigInt,
  assertBigIntRange,
} from "./validate.js";
import {
  ProviderError,
  ValidationError,
  UnknownSchemeError,
  SignatureError,
} from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** EIP-8141 transaction type identifier. */
export const FRAME_TX_TYPE = 0x08141;

/** Type prefix bytes prepended before RLP encoding for the signing hash. */
export const FRAME_TX_TYPE_PREFIX = new Uint8Array([0x08, 0x14, 0x01]);

/** Maximum uint128 — used for gas field validation. */
const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);

/** Maximum uint64 — used for nonce validation. */
const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1);

// ─── Signing Scheme Registry ──────────────────────────────────────────────────

/**
 * Signing scheme identifiers defined in EIP-8141 §4.2.
 * Values 0x00–0x0f are reserved for standard schemes.
 * Values 0x10–0x1f are reserved for post-quantum schemes.
 * Values 0x20+ are available for custom/vendor schemes.
 */
export const SIGNING_SCHEME = {
  /** Standard Ethereum ECDSA secp256k1 — backward-compatible with all current tooling. */
  ECDSA_SECP256K1: 0x00,
  /** BLS12-381 — enables signature aggregation for rollup and validator use cases. */
  BLS12_381: 0x01,
  /** Schnorr over secp256k1 — Taproot-compatible, linear multi-sig support. */
  SCHNORR_SECP256K1: 0x02,
  /** Ed25519 — widely used in Solana, Cosmos, and libp2p ecosystems. */
  ED25519: 0x03,
  /** Dilithium3 (CRYSTALS-Dilithium) — NIST PQC standard, lattice-based. */
  DILITHIUM3: 0x10,
  /** Falcon-512 — NIST PQC standard, compact lattice-based signatures. */
  FALCON512: 0x11,
  /** SPHINCS+ — NIST PQC standard, stateless hash-based, no lattice assumptions. */
  SPHINCS_PLUS: 0x12,
} as const;

export type SigningSchemeId = (typeof SIGNING_SCHEME)[keyof typeof SIGNING_SCHEME];

// ─── Types ───────────────────────────────────────────────────────────────────

/** EIP-2930-style access list entry. */
export interface AccessListEntry {
  address: string;
  storageKeys: string[];
}

/** An unsigned Frame Transaction (without signature field). */
export type UnsignedFrameTransaction = Omit<FrameTransaction, "signature">;

/** A fully signed Frame Transaction. */
export interface FrameTransaction {
  /** Must equal FRAME_TX_TYPE (0x08141). */
  type: typeof FRAME_TX_TYPE;
  /** Sender account address. */
  sender: string;
  /** Sequential nonce or 2D nonce key. Must not exceed uint64. */
  nonce: bigint;
  /** EIP-1559 max fee per gas. Must be >= maxPriorityFeePerGas. */
  maxFeePerGas: bigint;
  /** EIP-1559 priority tip per gas. */
  maxPriorityFeePerGas: bigint;
  /** Gas limit for frame execution. */
  gasLimit: bigint;
  /** Destination address or null for contract creation. */
  to: string | null;
  /** ETH value attached (in wei). */
  value: bigint;
  /** Calldata payload. */
  data: string;
  /** Signing scheme identifier from SIGNING_SCHEME. */
  signingScheme: SigningSchemeId;
  /**
   * Scheme-specific signer key identifier.
   * For ECDSA: checksummed EOA address.
   * For BLS/PQ: hex-encoded public key or its hash.
   */
  signerKey: string;
  /** Scheme-specific signature bytes. */
  signature: string;
  /** Optional paymaster address (20 bytes) + paymaster data. */
  paymasterData?: string;
  /** Optional EIP-2930 access list. */
  accessList?: AccessListEntry[];
  /** Chain ID. Use 0 for chain-agnostic (use with care). */
  chainId?: bigint;
}

/** Pluggable adapter interface for a signing scheme. */
export interface SigningSchemeAdapter {
  /** Scheme identifier this adapter handles. */
  schemeId: SigningSchemeId;
  /**
   * Sign a 32-byte hash and return raw signature bytes.
   * @param hash       - 32-byte message hash.
   * @param privateKey - Raw private key bytes.
   */
  sign(hash: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array>;
  /**
   * Verify a signature against a hash and signer key identifier.
   * @param hash      - 32-byte message hash.
   * @param signature - Raw signature bytes.
   * @param signerKey - Signer key identifier (address for ECDSA, pubkey for others).
   */
  verify(hash: Uint8Array, signature: Uint8Array, signerKey: string): Promise<boolean>;
  /**
   * Encode a raw public key into the signerKey format expected in the transaction.
   * @param publicKey - Raw public key bytes.
   */
  encodeSignerKey(publicKey: Uint8Array): string;
}

// ─── Signing Scheme Registry ──────────────────────────────────────────────────

/**
 * Registry of signing scheme adapters.
 *
 * Pre-populated with the ECDSA secp256k1 adapter.
 * Register additional adapters for BLS, Dilithium3, Falcon-512, SPHINCS+
 * once the corresponding cryptography libraries are available.
 *
 * @example
 * signingSchemeRegistry.register({
 *   schemeId: SIGNING_SCHEME.BLS12_381,
 *   async sign(hash, privateKey) { ... },
 *   async verify(hash, signature, signerKey) { ... },
 *   encodeSignerKey(publicKey) { ... },
 * });
 */
export class SigningSchemeRegistry {
  private readonly adapters = new Map<SigningSchemeId, SigningSchemeAdapter>();

  /**
   * Register a signing scheme adapter.
   * Overwrites any existing adapter for the same schemeId.
   */
  register(adapter: SigningSchemeAdapter): void {
    if (adapter.schemeId === undefined || adapter.schemeId === null) {
      throw new ValidationError("adapter.schemeId", "Must be a valid SigningSchemeId");
    }
    this.adapters.set(adapter.schemeId, adapter);
  }

  /**
   * Retrieve a registered adapter by scheme ID.
   * @throws UnknownSchemeError if no adapter is registered for the schemeId.
   */
  get(schemeId: SigningSchemeId): SigningSchemeAdapter {
    const adapter = this.adapters.get(schemeId);
    if (!adapter) throw new UnknownSchemeError(schemeId);
    return adapter;
  }

  /** Return true if an adapter is registered for the given schemeId. */
  has(schemeId: SigningSchemeId): boolean {
    return this.adapters.has(schemeId);
  }

  /** List all registered scheme IDs. */
  list(): SigningSchemeId[] {
    return Array.from(this.adapters.keys());
  }
}

/** Global default registry — pre-populated with ECDSA. */
export const signingSchemeRegistry = new SigningSchemeRegistry();

// Register built-in ECDSA adapter
signingSchemeRegistry.register({
  schemeId: SIGNING_SCHEME.ECDSA_SECP256K1,

  async sign(hash: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
    if (hash.length !== 32) {
      throw new SignatureError(`ECDSA.sign: hash must be 32 bytes, got ${hash.length}`);
    }
    const signingKey = new ethers.SigningKey(privateKey);
    const sig = signingKey.sign(hash);
    return ethers.getBytes(ethers.Signature.from(sig).serialized);
  },

  async verify(
    hash: Uint8Array,
    signature: Uint8Array,
    signerKey: string
  ): Promise<boolean> {
    if (hash.length !== 32) {
      throw new SignatureError(`ECDSA.verify: hash must be 32 bytes, got ${hash.length}`);
    }
    try {
      const recovered = ethers.recoverAddress(hash, ethers.hexlify(signature));
      return recovered.toLowerCase() === signerKey.toLowerCase();
    } catch {
      return false;
    }
  },

  encodeSignerKey(publicKey: Uint8Array): string {
    return ethers.computeAddress(publicKey);
  },
});

// ─── Encoding ─────────────────────────────────────────────────────────────────

/**
 * Encode access list entries as nested RLP arrays.
 */
function encodeAccessList(list: AccessListEntry[]): [string, string[]][] {
  return list.map((entry) => {
    assertAddress(`accessList[].address`, entry.address);
    return [entry.address, entry.storageKeys];
  });
}

/**
 * Encode an unsigned Frame Transaction for signing.
 *
 * Hash input = keccak256(FRAME_TX_TYPE_PREFIX || rlp(fields))
 *
 * @param tx - Unsigned frame transaction.
 * @returns Raw bytes to hash (type prefix + RLP encoded fields).
 */
export function encodeUnsignedFrameTx(tx: UnsignedFrameTransaction): Uint8Array {
  const fields: ethers.RlpStructuredData = [
    tx.chainId !== undefined && tx.chainId !== BigInt(0)
      ? ethers.toBeHex(tx.chainId)
      : "0x",
    tx.nonce === BigInt(0) ? "0x" : ethers.toBeHex(tx.nonce),
    ethers.toBeHex(tx.maxPriorityFeePerGas),
    ethers.toBeHex(tx.maxFeePerGas),
    ethers.toBeHex(tx.gasLimit),
    tx.to ?? "0x",
    tx.value > BigInt(0) ? ethers.toBeHex(tx.value) : "0x",
    tx.data,
    encodeAccessList(tx.accessList ?? []),
    ethers.toBeHex(tx.signingScheme),
    tx.signerKey,
    tx.paymasterData ?? "0x",
  ];

  const rlpEncoded = ethers.getBytes(ethers.encodeRlp(fields));
  return ethers.getBytes(ethers.concat([FRAME_TX_TYPE_PREFIX, rlpEncoded]));
}

/**
 * Compute the signing hash for a Frame Transaction.
 *
 * hash = keccak256(0x08 0x14 0x01 || rlp(unsignedFields))
 *
 * @param tx - Unsigned frame transaction.
 * @returns 0x-prefixed 32-byte signing hash.
 */
export function computeFrameTxHash(tx: UnsignedFrameTransaction): string {
  return ethers.keccak256(encodeUnsignedFrameTx(tx));
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build an unsigned Frame Transaction with validated fields.
 *
 * @param params - Transaction parameters.
 * @returns Unsigned FrameTransaction (signature omitted).
 * @throws ValidationError if any field fails validation.
 */
export function buildFrameTx(params: {
  sender: string;
  nonce: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  to: string | null;
  value?: bigint;
  data?: string;
  signerKey: string;
  signingScheme?: SigningSchemeId;
  paymasterData?: string;
  chainId?: bigint;
  accessList?: AccessListEntry[];
}): UnsignedFrameTransaction {
  assertNonZeroAddress("sender", params.sender);
  assertBigIntRange("nonce", params.nonce, BigInt(0), MAX_UINT64);
  assertPositiveBigInt("gasLimit", params.gasLimit);
  assertBigIntRange("maxFeePerGas", params.maxFeePerGas, BigInt(0), MAX_UINT128);
  assertBigIntRange("maxPriorityFeePerGas", params.maxPriorityFeePerGas, BigInt(0), MAX_UINT128);

  if (params.maxFeePerGas < params.maxPriorityFeePerGas) {
    throw new ValidationError(
      "maxFeePerGas",
      "maxFeePerGas must be >= maxPriorityFeePerGas"
    );
  }
  if (params.to !== null && params.to !== undefined) {
    assertNonZeroAddress("to", params.to);
  }
  if (params.chainId !== undefined && params.chainId !== BigInt(0)) {
    assertChainId("chainId", params.chainId);
  }

  return {
    type: FRAME_TX_TYPE,
    sender: params.sender,
    nonce: params.nonce,
    maxFeePerGas: params.maxFeePerGas,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    gasLimit: params.gasLimit,
    to: params.to ?? null,
    value: params.value ?? BigInt(0),
    data: params.data ?? "0x",
    signingScheme: params.signingScheme ?? SIGNING_SCHEME.ECDSA_SECP256K1,
    signerKey: params.signerKey,
    paymasterData: params.paymasterData,
    chainId: params.chainId,
    accessList: params.accessList ?? [],
  };
}

// ─── ECDSA Signing (Scheme 0x00) ──────────────────────────────────────────────

/**
 * Sign a Frame Transaction using standard ECDSA secp256k1 (scheme 0x00).
 *
 * Sets signingScheme to ECDSA_SECP256K1 and signerKey to the wallet address.
 *
 * @param wallet - The signing wallet.
 * @param tx     - Unsigned FrameTransaction (from buildFrameTx).
 * @returns Fully signed FrameTransaction.
 * @throws ProviderError if signing fails.
 */
export async function signFrameTxECDSA(
  wallet: ethers.Wallet,
  tx: Omit<UnsignedFrameTransaction, "signingScheme" | "signerKey">
): Promise<FrameTransaction> {
  const signerKey = await wallet.getAddress();
  const unsignedTx: UnsignedFrameTransaction = {
    ...tx,
    signingScheme: SIGNING_SCHEME.ECDSA_SECP256K1,
    signerKey,
  };

  const hash = ethers.getBytes(computeFrameTxHash(unsignedTx));
  let sig: ethers.SignatureLike;
  try {
    sig = wallet.signingKey.sign(hash);
  } catch (err) {
    throw new ProviderError("EIP8141.signFrameTxECDSA", err);
  }

  return {
    ...unsignedTx,
    type: FRAME_TX_TYPE,
    signature: ethers.Signature.from(sig).serialized,
  };
}

/**
 * Verify an ECDSA-signed Frame Transaction off-chain.
 *
 * @param tx - The signed FrameTransaction.
 * @returns Object with valid flag and recoveredAddress.
 * @throws ValidationError if the transaction uses a non-ECDSA scheme.
 * @throws SignatureError  if recovery fails.
 */
export function verifyFrameTxECDSA(
  tx: FrameTransaction
): { valid: boolean; recoveredAddress: string } {
  if (tx.signingScheme !== SIGNING_SCHEME.ECDSA_SECP256K1) {
    throw new ValidationError(
      "signingScheme",
      `Expected ECDSA_SECP256K1 (0x00), got 0x${tx.signingScheme.toString(16)}`
    );
  }

  const { signature, ...unsigned } = tx;
  const hash = computeFrameTxHash(unsigned);
  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.recoverAddress(hash, signature);
  } catch (err) {
    throw new SignatureError(
      `EIP8141.verifyFrameTxECDSA: recovery failed — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    valid: recoveredAddress.toLowerCase() === tx.signerKey.toLowerCase(),
    recoveredAddress,
  };
}

// ─── Generic Sign/Verify via Registry ────────────────────────────────────────

/**
 * Sign a Frame Transaction using any registered signing scheme.
 *
 * @param tx         - Unsigned frame transaction (signingScheme must be set).
 * @param privateKey - Raw private key bytes for the scheme.
 * @param registry   - Signing scheme registry (default: global registry).
 * @returns Fully signed FrameTransaction.
 * @throws UnknownSchemeError if no adapter is registered for tx.signingScheme.
 * @throws ProviderError      if signing fails.
 */
export async function signFrameTx(
  tx: UnsignedFrameTransaction,
  privateKey: Uint8Array,
  registry: SigningSchemeRegistry = signingSchemeRegistry
): Promise<FrameTransaction> {
  const adapter = registry.get(tx.signingScheme);
  const hash = ethers.getBytes(computeFrameTxHash(tx));

  let sigBytes: Uint8Array;
  try {
    sigBytes = await adapter.sign(hash, privateKey);
  } catch (err) {
    throw new ProviderError(
      `EIP8141.signFrameTx (scheme 0x${tx.signingScheme.toString(16)})`,
      err
    );
  }

  return {
    ...tx,
    type: FRAME_TX_TYPE,
    signature: ethers.hexlify(sigBytes),
  };
}

/**
 * Verify a signed Frame Transaction using its declared signing scheme.
 *
 * @param tx       - The signed FrameTransaction.
 * @param registry - Signing scheme registry (default: global registry).
 * @returns true if the signature is valid for tx.signerKey.
 * @throws UnknownSchemeError if no adapter is registered for tx.signingScheme.
 * @throws ProviderError      if verification throws unexpectedly.
 */
export async function verifyFrameTx(
  tx: FrameTransaction,
  registry: SigningSchemeRegistry = signingSchemeRegistry
): Promise<boolean> {
  const adapter = registry.get(tx.signingScheme);
  const { signature, ...unsigned } = tx;
  const hash = ethers.getBytes(computeFrameTxHash(unsigned));
  try {
    return await adapter.verify(hash, ethers.getBytes(signature), tx.signerKey);
  } catch (err) {
    throw new ProviderError(
      `EIP8141.verifyFrameTx (scheme 0x${tx.signingScheme.toString(16)})`,
      err
    );
  }
}

// ─── Paymaster Helper ─────────────────────────────────────────────────────────

/**
 * Build paymasterData for a verifying paymaster (mirrors ERC-4337 structure).
 *
 * Layout: paymasterAddress (20 bytes) || validUntil (6 bytes) || validAfter (6 bytes) || signature
 *
 * @param paymasterAddress  - Paymaster contract address.
 * @param validUntil        - Unix timestamp after which paymaster approval expires.
 * @param validAfter        - Unix timestamp before which paymaster approval is invalid.
 * @param paymasterSignature - Paymaster's signature bytes.
 * @returns Concatenated paymasterData bytes.
 * @throws ValidationError if paymasterAddress is zero.
 */
export function buildPaymasterData(
  paymasterAddress: string,
  validUntil: bigint,
  validAfter: bigint,
  paymasterSignature: string
): string {
  assertNonZeroAddress("paymasterAddress", paymasterAddress);
  const validUntilHex = ethers.zeroPadValue(ethers.toBeHex(validUntil), 6);
  const validAfterHex = ethers.zeroPadValue(ethers.toBeHex(validAfter), 6);
  return ethers.concat([
    paymasterAddress,
    validUntilHex,
    validAfterHex,
    paymasterSignature,
  ]);
}
