/**
 * EIP-712: Typed Structured Data Hashing and Signing — v1.0.0
 *
 * Enables off-chain signing of strongly-typed structured data.
 * Produces human-readable prompts in EIP-712-aware wallets (MetaMask, Rabby, etc.).
 * Domain separation prevents cross-app and cross-chain replay attacks.
 *
 * Security properties:
 * - Domain separator binds signatures to a specific contract + chain + version.
 * - Use a non-zero salt if you need additional domain disambiguation.
 * - For smart-account binding (replay across accounts) use EIP-7739 instead.
 *
 * @see https://eips.ethereum.org/EIPS/eip-712
 */

import { ethers } from "ethers";
import {
  assertAddress,
  assertNonZeroAddress,
  assertNonEmpty,
  assertChainId,
  assertECDSASignature,
} from "./validate.js";
import { ProviderError } from "./errors.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** EIP-712 domain descriptor. All fields except name are optional per the spec. */
export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
  /** Optional 32-byte salt for additional domain disambiguation. */
  salt?: string;
}

/** A single field definition in a typed struct. */
export interface TypedDataField {
  name: string;
  type: string;
}

/** Map of type name to its fields. */
export type TypedDataTypes = Record<string, TypedDataField[]>;

/** Result returned by signTypedData. */
export interface EIP712SignResult {
  domain: EIP712Domain;
  types: TypedDataTypes;
  value: Record<string, unknown>;
  /** EIP-712 domain separator hash (bytes32). */
  domainSeparator: string;
  /** Struct hash of the primary typed value (bytes32). */
  structHash: string;
  /** Final digest = keccak256("\x19\x01" || domainSeparator || structHash). */
  digest: string;
  /** 65-byte ECDSA signature, 0x-prefixed hex. */
  signature: string;
  /** Checksummed signer address. */
  signer: string;
  /** Decomposed signature components. */
  components: { v: number; r: string; s: string };
}

/** Result returned by verifyTypedData. */
export interface EIP712VerifyResult {
  valid: boolean;
  recoveredAddress: string;
  expectedAddress: string;
  digest: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** EIP-712 prefix bytes prepended before \x01 + domainSeparator + structHash. */
export const EIP712_PREFIX = "\x19\x01";

// ─── Signing ─────────────────────────────────────────────────────────────────

/**
 * Sign a typed data payload per EIP-712.
 *
 * The signer must implement signTypedData (ethers Wallet or JsonRpcSigner with EIP-712 support).
 *
 * @param signer - ethers Wallet or compatible signer.
 * @param domain - EIP-712 domain descriptor.
 * @param types  - Type definitions (must NOT include EIP712Domain — ethers adds it).
 * @param value  - The typed data object to sign. Keys must match the primary type.
 * @returns Full signing result including digest and decomposed signature.
 * @throws ValidationError if domain fields are invalid.
 * @throws ProviderError   if the signer call fails.
 */
export async function signTypedData(
  signer: ethers.Wallet | ethers.JsonRpcSigner,
  domain: EIP712Domain,
  types: TypedDataTypes,
  value: Record<string, unknown>
): Promise<EIP712SignResult> {
  assertNonEmpty("domain.name", domain.name);
  assertNonEmpty("domain.version", domain.version);
  assertChainId("domain.chainId", domain.chainId);
  assertNonZeroAddress("domain.verifyingContract", domain.verifyingContract);
  if (Object.keys(types).length === 0) {
    throw new Error("[types] Must define at least one type");
  }

  let signature: string;
  let signerAddress: string;
  try {
    [signature, signerAddress] = await Promise.all([
      signer.signTypedData(domain, types, value),
      signer.getAddress(),
    ]);
  } catch (err) {
    throw new ProviderError("EIP712.signTypedData", err);
  }

  const domainSeparator = computeDomainSeparator(domain);
  const primaryType = Object.keys(types)[0];
  const structHash = ethers.TypedDataEncoder.hashStruct(primaryType, types, value);
  const digest = ethers.TypedDataEncoder.hash(domain, types, value);
  const { v, r, s } = ethers.Signature.from(signature);

  return {
    domain,
    types,
    value,
    domainSeparator,
    structHash,
    digest,
    signature,
    signer: signerAddress,
    components: { v, r, s },
  };
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify an EIP-712 typed data signature.
 *
 * Reconstructs the digest from the domain + types + value and recovers the signer.
 *
 * @param domain          - EIP-712 domain that was used to sign.
 * @param types           - Type definitions used to sign.
 * @param value           - The typed data value that was signed.
 * @param signature       - The 65-byte ECDSA signature.
 * @param expectedAddress - Checksummed address expected to have signed.
 * @returns Verification result.
 * @throws ValidationError if expectedAddress is invalid.
 * @throws SignatureError  if signature is malformed.
 */
export function verifyTypedData(
  domain: EIP712Domain,
  types: TypedDataTypes,
  value: Record<string, unknown>,
  signature: string,
  expectedAddress: string
): EIP712VerifyResult {
  assertECDSASignature("signature", signature);
  assertNonZeroAddress("expectedAddress", expectedAddress);

  const digest = ethers.TypedDataEncoder.hash(domain, types, value);
  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(domain, types, value, signature);
  } catch (err) {
    throw new ProviderError("EIP712.verifyTypedData", err);
  }

  return {
    valid: recovered.toLowerCase() === expectedAddress.toLowerCase(),
    recoveredAddress: recovered,
    expectedAddress,
    digest,
  };
}

// ─── Hash Utilities ───────────────────────────────────────────────────────────

/**
 * Compute the EIP-712 domain separator for a given domain.
 *
 * The domain separator is a bytes32 value stored in verifying contracts.
 * It binds all signatures to a specific contract, chain, and version.
 *
 * @param domain - EIP-712 domain descriptor.
 * @returns 0x-prefixed 32-byte domain separator hash.
 */
export function computeDomainSeparator(domain: EIP712Domain): string {
  assertNonEmpty("domain.name", domain.name);
  assertNonZeroAddress("domain.verifyingContract", domain.verifyingContract);
  return ethers.TypedDataEncoder.hashDomain(domain);
}

/**
 * Compute the full EIP-712 digest (domainSeparator ++ structHash).
 *
 * This is the exact value passed to ecrecover for on-chain verification.
 *
 * @param domain - EIP-712 domain.
 * @param types  - Type definitions.
 * @param value  - Typed data value.
 * @returns 0x-prefixed 32-byte digest.
 */
export function computeDigest(
  domain: EIP712Domain,
  types: TypedDataTypes,
  value: Record<string, unknown>
): string {
  return ethers.TypedDataEncoder.hash(domain, types, value);
}

/**
 * Compute only the struct hash of a typed value (without domain).
 *
 * Useful when you need the inner hash before wrapping with a domain separator.
 *
 * @param types - Type definitions.
 * @param value - Typed data value.
 * @returns 0x-prefixed 32-byte struct hash.
 */
export function computeStructHash(
  types: TypedDataTypes,
  value: Record<string, unknown>
): string {
  if (Object.keys(types).length === 0) {
    throw new Error("[types] Must define at least one type");
  }
  const primaryType = Object.keys(types)[0];
  return ethers.TypedDataEncoder.hashStruct(primaryType, types, value);
}

/**
 * ABI-encode a typed data struct for inspection or off-chain hashing.
 *
 * @param types - Type definitions.
 * @param value - Typed data value.
 * @returns ABI-encoded bytes as 0x-prefixed hex.
 */
export function encodeTypedData(
  types: TypedDataTypes,
  value: Record<string, unknown>
): string {
  if (Object.keys(types).length === 0) {
    throw new Error("[types] Must define at least one type");
  }
  const primaryType = Object.keys(types)[0];
  return ethers.TypedDataEncoder.encode(primaryType, types, value);
}

/**
 * Get the type string for the primary type (used in EIP-7739 contentsType).
 *
 * Example: "Mail(address from,address to,string contents)"
 *
 * @param types - Type definitions.
 * @returns Human-readable EIP-712 type string.
 */
export function encodeTypeString(types: TypedDataTypes): string {
  if (Object.keys(types).length === 0) {
    throw new Error("[types] Must define at least one type");
  }
  const encoder = ethers.TypedDataEncoder.from(types);
  return encoder.encodeType(Object.keys(types)[0]);
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build a standard EIP-712 domain object.
 *
 * @param name               - Human-readable name of the signing domain.
 * @param version            - Version string (typically "1" or "2").
 * @param chainId            - EVM chain ID.
 * @param verifyingContract  - Address of the verifying contract.
 * @param salt               - Optional 32-byte hex salt for disambiguation.
 * @returns EIP712Domain object.
 * @throws ValidationError if any field fails validation.
 */
export function buildDomain(
  name: string,
  version: string,
  chainId: number,
  verifyingContract: string,
  salt?: string
): EIP712Domain {
  assertNonEmpty("name", name);
  assertNonEmpty("version", version);
  assertChainId("chainId", chainId);
  assertNonZeroAddress("verifyingContract", verifyingContract);
  if (salt !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) {
      throw new Error("[salt] Must be a 0x-prefixed 32-byte hex string if provided");
    }
  }
  const domain: EIP712Domain = { name, version, chainId, verifyingContract };
  if (salt !== undefined) domain.salt = salt;
  return domain;
}
