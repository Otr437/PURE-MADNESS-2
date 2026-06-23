/**
 * EIP-7702: Set EOA Account Code — v1.0.0
 *
 * Allows an EOA to temporarily delegate its execution context to a smart
 * contract implementation. The EOA signs an authorization tuple; a type-4
 * transaction carries the authorizationList and sets the EOA's code to
 * the EIP-7702 delegation designator (0xef0100 ++ implementationAddress).
 *
 * Introduced in the Pectra upgrade (mainnet May 2025).
 *
 * Security properties:
 * - The authorization is per-nonce. An authorization signed with nonce N is
 *   invalidated once the EOA's nonce advances past N.
 * - A chainId of 0 makes the authorization valid on ALL chains — only use
 *   this intentionally; prefer the target chain's ID.
 * - The delegation can be revoked by signing a new authorization pointing
 *   to address(0), which removes the code designation.
 * - Verify delegations before trusting an EOA has smart-account behavior:
 *   call getDelegatedImplementation() and check the result.
 *
 * @see https://eips.ethereum.org/EIPS/eip-7702
 */

import { ethers } from "ethers";
import {
  assertNonZeroAddress,
  assertAddress,
  assertChainId,
  assertBigIntRange,
} from "./validate.js";
import { ProviderError, ValidationError, SignatureError } from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** EIP-7702 transaction type identifier. */
export const EIP7702_TX_TYPE = 4;

/** Magic byte prefix for the EIP-7702 authorization signing hash. */
export const EIP7702_MAGIC_BYTE = "0x05";

/** EIP-7702 delegation designator prefix in code (follows 0xef0100). */
export const DELEGATION_PREFIX = "0xef0100";

/** Maximum uint64 value — used for nonce range validation. */
const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1);

// ─── Types ───────────────────────────────────────────────────────────────────

/** An unsigned EIP-7702 authorization tuple. */
export interface EIP7702Authorization {
  /** Chain ID this authorization is valid on. Use 0 for all chains (use with care). */
  chainId: bigint;
  /** The contract implementation address to delegate to. */
  address: string;
  /** The EOA's nonce at the time of signing. */
  nonce: bigint;
}

/** A signed EIP-7702 authorization tuple, ready for inclusion in a type-4 tx. */
export interface SignedEIP7702Authorization extends EIP7702Authorization {
  /** Recovery bit: 0 or 1. */
  yParity: number;
  /** r component of the ECDSA signature. */
  r: string;
  /** s component of the ECDSA signature. */
  s: string;
}

/** A type-4 (EIP-7702) transaction object. */
export interface EIP7702Transaction {
  type: 4;
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string | null;
  value: bigint;
  data: string;
  accessList: AccessListEntry[];
  authorizationList: SignedEIP7702Authorization[];
}

/** EIP-2930-style access list entry. */
export interface AccessListEntry {
  address: string;
  storageKeys: string[];
}

/** A call in a batch execution payload. */
export interface BatchCall {
  to: string;
  value: bigint;
  data: string;
}

// ─── Authorization Hash ───────────────────────────────────────────────────────

/**
 * Compute the signing hash for an EIP-7702 authorization tuple.
 *
 * Hash = keccak256(0x05 || rlp([chain_id, address, nonce]))
 *
 * The 0x05 magic byte is the EIP-7702 type prefix, separate from the
 * EIP-191 (0x19) and EIP-712 (0x01) prefixes, preventing cross-protocol replay.
 *
 * @param auth - The unsigned authorization tuple.
 * @returns 32-byte keccak256 hash as 0x-prefixed hex.
 * @throws ValidationError if address is invalid or nonce exceeds uint64.
 */
export function computeAuthorizationHash(auth: EIP7702Authorization): string {
  assertAddress("auth.address", auth.address);
  assertBigIntRange("auth.nonce", auth.nonce, BigInt(0), MAX_UINT64);

  const chainIdHex =
    auth.chainId === BigInt(0) ? "0x" : ethers.toBeHex(auth.chainId);
  const nonceHex =
    auth.nonce === BigInt(0) ? "0x" : ethers.toBeHex(auth.nonce);

  const rlpEncoded = ethers.encodeRlp([
    chainIdHex,
    auth.address,
    nonceHex,
  ]);
  const withMagic = ethers.concat([EIP7702_MAGIC_BYTE, rlpEncoded]);
  return ethers.keccak256(withMagic);
}

// ─── Signing ──────────────────────────────────────────────────────────────────

/**
 * Sign an EIP-7702 authorization tuple with the EOA's private key.
 *
 * The EOA authorizes its code to be set to the delegation designator pointing
 * at the given implementation address. The authorization is nonce-bound and
 * will be invalidated if the EOA's nonce advances before the tx is included.
 *
 * @param signer - The EOA's ethers.Wallet (must hold the private key directly).
 * @param auth   - The authorization tuple to sign.
 * @returns Signed authorization with yParity, r, s populated.
 * @throws ValidationError if auth fields are invalid.
 * @throws ProviderError   if signing fails.
 */
export async function signAuthorization(
  signer: ethers.Wallet,
  auth: EIP7702Authorization
): Promise<SignedEIP7702Authorization> {
  assertAddress("auth.address", auth.address);
  assertBigIntRange("auth.nonce", auth.nonce, BigInt(0), MAX_UINT64);

  const hash = computeAuthorizationHash(auth);
  let sig: ethers.Signature;
  try {
    sig = signer.signingKey.sign(ethers.getBytes(hash));
  } catch (err) {
    throw new ProviderError("EIP7702.signAuthorization", err);
  }

  return {
    ...auth,
    yParity: sig.yParity,
    r: sig.r,
    s: sig.s,
  };
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Recover the EOA address from a signed authorization.
 *
 * @param signedAuth - The signed authorization tuple.
 * @returns Checksummed EOA address.
 * @throws SignatureError if recovery fails.
 */
export function recoverAuthorizationSigner(
  signedAuth: SignedEIP7702Authorization
): string {
  const hash = computeAuthorizationHash(signedAuth);
  try {
    const sig = ethers.Signature.from({
      yParity: signedAuth.yParity,
      r: signedAuth.r,
      s: signedAuth.s,
    });
    return ethers.recoverAddress(hash, sig);
  } catch (err) {
    throw new SignatureError(
      `EIP7702.recoverAuthorizationSigner failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Verify that a signed authorization was produced by the expected EOA.
 *
 * @param signedAuth     - The signed authorization.
 * @param expectedSigner - The expected EOA address.
 * @returns true if recovered address matches expectedSigner.
 */
export function verifyAuthorization(
  signedAuth: SignedEIP7702Authorization,
  expectedSigner: string
): boolean {
  assertNonZeroAddress("expectedSigner", expectedSigner);
  const recovered = recoverAuthorizationSigner(signedAuth);
  return recovered.toLowerCase() === expectedSigner.toLowerCase();
}

// ─── Transaction Builder ───────────────────────────────────────────────────────

/**
 * Construct a type-4 (EIP-7702) transaction object.
 *
 * The authorizationList may contain authorizations from multiple EOAs,
 * enabling batch delegation in a single transaction.
 *
 * @param params - Transaction parameters.
 * @returns EIP7702Transaction ready for signing and submission.
 * @throws ValidationError if gas params or addresses are invalid.
 */
export function buildEIP7702Transaction(params: {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string | null;
  value?: bigint;
  data?: string;
  authorizationList: SignedEIP7702Authorization[];
  accessList?: AccessListEntry[];
}): EIP7702Transaction {
  assertChainId("chainId", params.chainId);
  if (params.authorizationList.length === 0) {
    throw new ValidationError(
      "authorizationList",
      "Must contain at least one authorization"
    );
  }
  if (params.maxFeePerGas < params.maxPriorityFeePerGas) {
    throw new ValidationError(
      "maxFeePerGas",
      "maxFeePerGas must be >= maxPriorityFeePerGas"
    );
  }
  if (params.to !== null) {
    assertNonZeroAddress("to", params.to);
  }

  return {
    type: EIP7702_TX_TYPE,
    chainId: params.chainId,
    nonce: params.nonce,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    maxFeePerGas: params.maxFeePerGas,
    gasLimit: params.gasLimit,
    to: params.to,
    value: params.value ?? BigInt(0),
    data: params.data ?? "0x",
    accessList: params.accessList ?? [],
    authorizationList: params.authorizationList,
  };
}

// ─── callData Encoders ────────────────────────────────────────────────────────

/**
 * Encode a batch of calls as calldata for an EIP-7702 delegated EOA.
 *
 * Assumes the implementation exposes:
 *   execute(Call[] calls) where Call = (address to, uint256 value, bytes data)
 *
 * @param calls - Array of calls to batch.
 * @returns ABI-encoded execute calldata.
 * @throws ValidationError if calls array is empty.
 */
export function encodeBatchExecute(calls: BatchCall[]): string {
  if (calls.length === 0) {
    throw new ValidationError("calls", "Batch must contain at least one call");
  }
  calls.forEach((c, i) => assertNonZeroAddress(`calls[${i}].to`, c.to));

  const iface = new ethers.Interface([
    "function execute((address to, uint256 value, bytes data)[] calls)",
  ]);
  return iface.encodeFunctionData("execute", [calls]);
}

/**
 * Encode a single call as calldata for an EIP-7702 delegated EOA.
 *
 * @param to    - Destination address.
 * @param value - ETH value in wei.
 * @param data  - Encoded function call data.
 * @returns ABI-encoded execute calldata.
 */
export function encodeSingleExecute(
  to: string,
  value: bigint,
  data: string
): string {
  assertNonZeroAddress("to", to);
  return encodeBatchExecute([{ to, value, data }]);
}

// ─── On-Chain Inspection ──────────────────────────────────────────────────────

/**
 * Determine if a given EOA address currently has an EIP-7702 delegation active,
 * and if so, return the implementation address it delegates to.
 *
 * A delegated EOA has code starting with 0xef0100 followed by the 20-byte
 * implementation address (total: 23 bytes / 46 hex chars after 0x).
 *
 * @param provider   - ethers Provider.
 * @param eoaAddress - Address to inspect.
 * @returns Implementation address if delegated, null if plain EOA or unrelated code.
 * @throws ValidationError if eoaAddress is invalid.
 * @throws ProviderError   if getCode fails.
 */
export async function getDelegatedImplementation(
  provider: ethers.Provider,
  eoaAddress: string
): Promise<string | null> {
  assertNonZeroAddress("eoaAddress", eoaAddress);
  let code: string;
  try {
    code = await provider.getCode(eoaAddress);
  } catch (err) {
    throw new ProviderError("EIP7702.getDelegatedImplementation", err);
  }

  if (!code.toLowerCase().startsWith(DELEGATION_PREFIX.toLowerCase())) {
    return null;
  }

  // DELEGATION_PREFIX = "0xef0100" = 8 chars after "0x" (3 bytes)
  // Implementation address = next 40 hex chars (20 bytes)
  const implHex = "0x" + code.slice(DELEGATION_PREFIX.length, DELEGATION_PREFIX.length + 40);
  if (implHex.length !== 42) return null;

  try {
    return ethers.getAddress(implHex);
  } catch {
    return null;
  }
}

/**
 * Check whether an EOA is currently delegated (has EIP-7702 active).
 *
 * @param provider   - ethers Provider.
 * @param eoaAddress - Address to check.
 * @returns true if the EOA has an active EIP-7702 delegation.
 */
export async function isDelegated(
  provider: ethers.Provider,
  eoaAddress: string
): Promise<boolean> {
  const impl = await getDelegatedImplementation(provider, eoaAddress);
  return impl !== null;
}
