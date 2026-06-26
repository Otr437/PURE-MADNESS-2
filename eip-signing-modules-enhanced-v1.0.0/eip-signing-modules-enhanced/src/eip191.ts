/**
 * EIP-191: Signed Data Standard — v1.0.0
 *
 * Simple personal message signing and verification (off-chain).
 * Version byte 0x45 → "\x19Ethereum Signed Message:\n<len><message>"
 *
 * Security properties:
 * - Domain-separated from EIP-712 by the version byte prefix.
 * - Not replay-safe across accounts — use EIP-7739 for smart-account binding.
 * - Suitable for basic authentication, ownership proofs, and intent signing.
 *
 * @see https://eips.ethereum.org/EIPS/eip-191
 */

import { ethers } from "ethers";
import {
  assertAddress,
  assertNonZeroAddress,
  assertNonEmpty,
  assertECDSASignature,
} from "./validate.js";
import { ProviderError } from "./errors.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result returned by signMessage and signBytes. */
export interface EIP191SignResult {
  /** The original message (string or hex-encoded bytes). */
  message: string;
  /** keccak256 of the EIP-191 prefixed message — the hash that was signed. */
  prefixedHash: string;
  /** 65-byte ECDSA signature (r || s || v), 0x-prefixed hex. */
  signature: string;
  /** Checksummed address of the signer. */
  signer: string;
  /** Decomposed signature components. */
  components: { v: number; r: string; s: string };
}

/** Result returned by verifyMessage and verifyBytes. */
export interface EIP191VerifyResult {
  /** True when recoveredAddress matches expectedAddress (case-insensitive). */
  valid: boolean;
  /** The address recovered from the signature via ecrecover. */
  recoveredAddress: string;
  /** The expected address supplied by the caller. */
  expectedAddress: string;
  /** The hash that was signed. */
  prefixedHash: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** EIP-191 version byte for personal_sign. */
export const PERSONAL_SIGN_VERSION_BYTE = "0x45";

/** Maximum safe message length (bytes). Wallets may reject beyond this. */
export const MAX_MESSAGE_BYTES = 65_536;

// ─── Signing ─────────────────────────────────────────────────────────────────

/**
 * Sign a plain text message using the EIP-191 personal_sign prefix.
 *
 * Prepends "\x19Ethereum Signed Message:\n<length><message>" before hashing,
 * preventing the signature from being mistaken for a raw transaction.
 *
 * @param signer  - An ethers Signer (Wallet, JsonRpcSigner, etc.)
 * @param message - UTF-8 string to sign. Must be non-empty and ≤ MAX_MESSAGE_BYTES.
 * @returns       Signature result including prefixed hash and v/r/s components.
 * @throws ValidationError  if message is empty.
 * @throws ProviderError    if the signer call fails.
 */
export async function signMessage(
  signer: ethers.Signer,
  message: string
): Promise<EIP191SignResult> {
  assertNonEmpty("message", message);
  const encoded = new TextEncoder().encode(message);
  if (encoded.length > MAX_MESSAGE_BYTES) {
    throw new Error(
      `message exceeds MAX_MESSAGE_BYTES (${encoded.length} > ${MAX_MESSAGE_BYTES})`
    );
  }

  let signature: string;
  let signerAddress: string;
  try {
    [signature, signerAddress] = await Promise.all([
      signer.signMessage(message),
      signer.getAddress(),
    ]);
  } catch (err) {
    throw new ProviderError("EIP191.signMessage", err);
  }

  const prefixedHash = ethers.hashMessage(message);
  const { v, r, s } = ethers.Signature.from(signature);

  return { message, prefixedHash, signature, signer: signerAddress, components: { v, r, s } };
}

/**
 * Sign raw bytes using the EIP-191 personal_sign prefix.
 *
 * Useful when signing binary payloads (e.g., packed ABI data) rather than
 * human-readable strings.
 *
 * @param signer - An ethers Signer.
 * @param bytes  - Arbitrary bytes to sign. Must be non-empty.
 * @returns Signature result. `message` field is hex-encoded input bytes.
 * @throws ValidationError if bytes is empty.
 * @throws ProviderError   if the signer call fails.
 */
export async function signBytes(
  signer: ethers.Signer,
  bytes: Uint8Array
): Promise<EIP191SignResult> {
  if (bytes.length === 0) {
    throw new Error("[bytes] Must be non-empty");
  }
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw new Error(
      `bytes exceeds MAX_MESSAGE_BYTES (${bytes.length} > ${MAX_MESSAGE_BYTES})`
    );
  }

  let signature: string;
  let signerAddress: string;
  try {
    [signature, signerAddress] = await Promise.all([
      signer.signMessage(bytes),
      signer.getAddress(),
    ]);
  } catch (err) {
    throw new ProviderError("EIP191.signBytes", err);
  }

  const prefixedHash = ethers.hashMessage(bytes);
  const hexMessage = ethers.hexlify(bytes);
  const { v, r, s } = ethers.Signature.from(signature);

  return { message: hexMessage, prefixedHash, signature, signer: signerAddress, components: { v, r, s } };
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify that a signature over a plain text message was produced by expectedAddress.
 *
 * Uses ecrecover internally via ethers.verifyMessage.
 *
 * @param message         - The original message that was signed.
 * @param signature       - The 65-byte ECDSA signature, 0x-prefixed hex.
 * @param expectedAddress - Checksummed address expected to have signed.
 * @returns Verification result including recoveredAddress and validity flag.
 * @throws ValidationError  if message is empty or expectedAddress is invalid.
 * @throws SignatureError   if signature is malformed.
 */
export function verifyMessage(
  message: string,
  signature: string,
  expectedAddress: string
): EIP191VerifyResult {
  assertNonEmpty("message", message);
  assertECDSASignature("signature", signature);
  assertNonZeroAddress("expectedAddress", expectedAddress);

  const recovered = ethers.verifyMessage(message, signature);
  const prefixedHash = ethers.hashMessage(message);

  return {
    valid: recovered.toLowerCase() === expectedAddress.toLowerCase(),
    recoveredAddress: recovered,
    expectedAddress,
    prefixedHash,
  };
}

/**
 * Verify a signature over raw bytes.
 *
 * @param bytes           - The original byte array that was signed.
 * @param signature       - The 65-byte ECDSA signature, 0x-prefixed hex.
 * @param expectedAddress - Checksummed address expected to have signed.
 * @returns Verification result.
 * @throws ValidationError if expectedAddress is invalid.
 * @throws SignatureError  if signature is malformed.
 */
export function verifyBytes(
  bytes: Uint8Array,
  signature: string,
  expectedAddress: string
): EIP191VerifyResult {
  if (bytes.length === 0) throw new Error("[bytes] Must be non-empty");
  assertECDSASignature("signature", signature);
  assertNonZeroAddress("expectedAddress", expectedAddress);

  const recovered = ethers.verifyMessage(bytes, signature);
  const prefixedHash = ethers.hashMessage(bytes);

  return {
    valid: recovered.toLowerCase() === expectedAddress.toLowerCase(),
    recoveredAddress: recovered,
    expectedAddress,
    prefixedHash,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Compute the EIP-191 prefixed hash of a message without signing.
 *
 * Returns the exact bytes32 value that ecrecover expects on-chain.
 *
 * @param message - UTF-8 message string.
 * @returns 0x-prefixed 32-byte keccak256 hash.
 */
export function hashMessage(message: string): string {
  assertNonEmpty("message", message);
  return ethers.hashMessage(message);
}

/**
 * Compute the EIP-191 prefixed hash of raw bytes without signing.
 *
 * @param bytes - Raw bytes to hash.
 * @returns 0x-prefixed 32-byte keccak256 hash.
 */
export function hashBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new Error("[bytes] Must be non-empty");
  return ethers.hashMessage(bytes);
}

/**
 * Recover the signer address from a message and signature.
 *
 * @param message   - The original plaintext message.
 * @param signature - The 65-byte ECDSA signature.
 * @returns Checksummed signer address.
 * @throws SignatureError if recovery fails.
 */
export function recoverSigner(message: string, signature: string): string {
  assertNonEmpty("message", message);
  assertECDSASignature("signature", signature);
  try {
    return ethers.verifyMessage(message, signature);
  } catch (err) {
    throw new ProviderError("EIP191.recoverSigner", err);
  }
}

/**
 * Decompose a 65-byte ECDSA signature into its v, r, s components.
 *
 * @param signature - 0x-prefixed 65-byte hex signature.
 * @returns Object with numeric v and 0x-prefixed 32-byte r and s strings.
 * @throws SignatureError if signature is malformed.
 */
export function decomposeSignature(signature: string): {
  v: number;
  r: string;
  s: string;
} {
  assertECDSASignature("signature", signature);
  try {
    const { v, r, s } = ethers.Signature.from(signature);
    return { v, r, s };
  } catch (err) {
    throw new ProviderError("EIP191.decomposeSignature", err);
  }
}
