/**
 * EIP-2612: Permit Extension for EIP-20 Signed Approvals — v1.0.0
 *
 * Gasless ERC-20 approvals via off-chain EIP-712 signatures.
 * The permit() call is submitted by the spender or a relayer — the owner
 * never needs to hold ETH for the approval transaction.
 *
 * Security properties:
 * - Always set a short deadline. A permit with deadline = MaxUint256 is a
 *   permanent approval that can be front-run or replayed indefinitely.
 * - Nonces are per-owner and increment on every permit() call, preventing replay.
 * - Verify the permit signature off-chain before submitting to avoid wasted gas.
 * - The spender cannot exceed the approved value even with a valid permit.
 *
 * @see https://eips.ethereum.org/EIPS/eip-2612
 */

import { ethers } from "ethers";
import {
  assertNonZeroAddress,
  assertPositiveBigInt,
  assertChainId,
  assertDeadlineNotExpired,
} from "./validate.js";
import { ProviderError, DeadlineExpiredError, ValidationError } from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Seconds in one hour. */
export const ONE_HOUR_SECONDS = 3_600;
/** Seconds in one day. */
export const ONE_DAY_SECONDS = 86_400;
/** Seconds in one week. */
export const ONE_WEEK_SECONDS = 604_800;

/** Maximum recommended permit duration. Beyond this, warn callers. */
export const MAX_RECOMMENDED_DEADLINE_SECONDS = ONE_WEEK_SECONDS;

/** EIP-2612 Permit struct type definition. */
export const PERMIT_TYPES: Record<string, ethers.TypedDataField[]> = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/** ABI fragments for interacting with an ERC-20 permit-compatible token. */
const ERC20_PERMIT_ABI: string[] = [
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ─── Types ───────────────────────────────────────────────────────────────────

/** ERC-20 permit domain (used as the EIP-712 domain). */
export interface ERC20PermitDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/** Parameters for a permit request. */
export interface PermitParams {
  owner: string;
  spender: string;
  /** Amount in token's smallest unit (wei-equivalent). */
  value: bigint;
  /** Owner's current nonce from the token contract. */
  nonce: bigint;
  /** Unix timestamp deadline. Permit reverts on-chain after this time. */
  deadline: bigint;
}

/** A signed permit, ready to submit via permit(). */
export interface SignedPermit extends PermitParams {
  /** Full 65-byte compact signature (r||s||v). */
  signature: string;
  v: number;
  r: string;
  s: string;
  domain: ERC20PermitDomain;
  /** EIP-712 digest that was signed. */
  digest: string;
}

// ─── On-Chain Reads ───────────────────────────────────────────────────────────

/**
 * Fetch the EIP-2612 permit nonce for an owner from the token contract.
 *
 * The nonce must be included in the signed permit to prevent replay attacks.
 * It increments by 1 on every successful permit() call.
 *
 * @param provider     - ethers Provider.
 * @param tokenAddress - ERC-20 token contract address.
 * @param owner        - Token owner address.
 * @returns Current nonce as bigint.
 * @throws ValidationError if addresses are invalid.
 * @throws ProviderError   if the call fails.
 */
export async function getPermitNonce(
  provider: ethers.Provider,
  tokenAddress: string,
  owner: string
): Promise<bigint> {
  assertNonZeroAddress("tokenAddress", tokenAddress);
  assertNonZeroAddress("owner", owner);
  const token = new ethers.Contract(tokenAddress, ERC20_PERMIT_ABI, provider);
  try {
    return await token.nonces(owner);
  } catch (err) {
    throw new ProviderError(`EIP2612.getPermitNonce(${tokenAddress})`, err);
  }
}

/**
 * Build the EIP-712 permit domain by reading name and version from the token.
 *
 * Falls back to version "1" if the token does not expose a version() function
 * (many older tokens omit it). The fallback matches Uniswap V2 behavior.
 *
 * @param provider     - ethers Provider.
 * @param tokenAddress - ERC-20 token contract address.
 * @param chainId      - Chain ID of the network.
 * @returns ERC20PermitDomain ready for EIP-712 signing.
 * @throws ValidationError if tokenAddress is invalid.
 * @throws ProviderError   if name() call fails (token is likely not permit-compatible).
 */
export async function buildPermitDomain(
  provider: ethers.Provider,
  tokenAddress: string,
  chainId: number
): Promise<ERC20PermitDomain> {
  assertNonZeroAddress("tokenAddress", tokenAddress);
  assertChainId("chainId", chainId);

  const token = new ethers.Contract(tokenAddress, ERC20_PERMIT_ABI, provider);

  let name: string;
  try {
    name = await token.name();
  } catch (err) {
    throw new ProviderError(
      `EIP2612.buildPermitDomain: token at ${tokenAddress} does not expose name()`,
      err
    );
  }

  let version: string;
  try {
    version = await token.version();
  } catch {
    version = "1"; // standard fallback per EIP-2612
  }

  return { name, version, chainId, verifyingContract: tokenAddress };
}

/**
 * Read the on-chain DOMAIN_SEPARATOR from the token.
 *
 * Useful for verifying that the domain derived off-chain matches
 * what the token will use during permit() validation.
 *
 * @param provider     - ethers Provider.
 * @param tokenAddress - ERC-20 token contract address.
 * @returns On-chain domain separator as bytes32 hex.
 * @throws ProviderError if the call fails.
 */
export async function getOnChainDomainSeparator(
  provider: ethers.Provider,
  tokenAddress: string
): Promise<string> {
  assertNonZeroAddress("tokenAddress", tokenAddress);
  const token = new ethers.Contract(tokenAddress, ERC20_PERMIT_ABI, provider);
  try {
    return await token.DOMAIN_SEPARATOR();
  } catch (err) {
    throw new ProviderError(`EIP2612.getOnChainDomainSeparator(${tokenAddress})`, err);
  }
}

// ─── Signing ─────────────────────────────────────────────────────────────────

/**
 * Sign an ERC-20 permit off-chain.
 *
 * The resulting SignedPermit can be submitted via submitPermit() by any caller
 * — typically the spender or a meta-transaction relayer.
 *
 * @param signer       - The token owner's wallet (must hold the private key).
 * @param tokenAddress - ERC-20 token contract address.
 * @param spender      - Address being approved to spend.
 * @param amount       - Amount in the token's smallest unit.
 * @param deadline     - Unix timestamp after which permit() reverts.
 * @param chainId      - Chain ID of the network.
 * @returns Fully signed permit including v, r, s, and the EIP-712 digest.
 * @throws ValidationError    if any address is zero or amount is non-positive.
 * @throws DeadlineExpiredError if deadline is already in the past.
 * @throws ProviderError      if nonce fetch or signing fails.
 */
export async function signPermit(
  signer: ethers.Wallet,
  tokenAddress: string,
  spender: string,
  amount: bigint,
  deadline: bigint,
  chainId: number
): Promise<SignedPermit> {
  assertNonZeroAddress("tokenAddress", tokenAddress);
  assertNonZeroAddress("spender", spender);
  assertPositiveBigInt("amount", amount);
  assertChainId("chainId", chainId);

  const nowUnix = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= nowUnix) {
    throw new DeadlineExpiredError(deadline, nowUnix);
  }

  if (!signer.provider) {
    throw new ValidationError(
      "signer",
      "Signer must be connected to a provider to fetch the permit nonce"
    );
  }

  const owner = await signer.getAddress();
  const [nonce, domain] = await Promise.all([
    getPermitNonce(signer.provider, tokenAddress, owner),
    buildPermitDomain(signer.provider, tokenAddress, chainId),
  ]);

  const permitValue = { owner, spender, value: amount, nonce, deadline };

  let signature: string;
  try {
    signature = await signer.signTypedData(domain, PERMIT_TYPES, permitValue);
  } catch (err) {
    throw new ProviderError("EIP2612.signPermit", err);
  }

  const { v, r, s } = ethers.Signature.from(signature);
  const digest = ethers.TypedDataEncoder.hash(domain, PERMIT_TYPES, permitValue);

  return { owner, spender, value: amount, nonce, deadline, signature, v, r, s, domain, digest };
}

// ─── Submission ───────────────────────────────────────────────────────────────

/**
 * Submit a signed permit on-chain via the token's permit() function.
 *
 * Can be called by the spender, a relayer, or any address — the owner does
 * not need to submit. Validates the deadline has not expired before sending.
 *
 * @param signerOrProvider - Signer (to pay gas) or Provider for gas estimation.
 * @param tokenAddress     - ERC-20 token contract address.
 * @param permit           - The signed permit from signPermit().
 * @returns Transaction response.
 * @throws DeadlineExpiredError if the permit has expired.
 * @throws ProviderError        if the transaction fails.
 */
export async function submitPermit(
  signerOrProvider: ethers.Signer | ethers.Provider,
  tokenAddress: string,
  permit: SignedPermit
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("tokenAddress", tokenAddress);

  const nowUnix = BigInt(Math.floor(Date.now() / 1000));
  if (permit.deadline <= nowUnix) {
    throw new DeadlineExpiredError(permit.deadline, nowUnix);
  }

  const token = new ethers.Contract(tokenAddress, ERC20_PERMIT_ABI, signerOrProvider);
  try {
    return await token.permit(
      permit.owner,
      permit.spender,
      permit.value,
      permit.deadline,
      permit.v,
      permit.r,
      permit.s
    );
  } catch (err) {
    throw new ProviderError("EIP2612.submitPermit", err);
  }
}

// ─── Off-Chain Verification ───────────────────────────────────────────────────

/**
 * Verify a permit signature off-chain without submitting.
 *
 * Reconstructs the EIP-712 digest and recovers the signer via ecrecover.
 * Use this before submitPermit() to catch invalid signatures early.
 *
 * @param permit        - The signed permit.
 * @param expectedOwner - The expected token owner address.
 * @returns true if the signature was produced by expectedOwner.
 */
export function verifyPermitSignature(
  permit: SignedPermit,
  expectedOwner: string
): boolean {
  assertNonZeroAddress("expectedOwner", expectedOwner);
  const { domain, owner, spender, value, nonce, deadline, signature } = permit;
  const permitValue = { owner, spender, value, nonce, deadline };
  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(domain, PERMIT_TYPES, permitValue, signature);
  } catch (err) {
    throw new ProviderError("EIP2612.verifyPermitSignature", err);
  }
  return recovered.toLowerCase() === expectedOwner.toLowerCase();
}

// ─── Deadline Helpers ─────────────────────────────────────────────────────────

/**
 * Build a deadline N seconds from now.
 *
 * @param secondsFromNow - Number of seconds until expiry.
 * @returns Unix timestamp as bigint.
 * @throws ValidationError if secondsFromNow is not a positive integer.
 */
export function deadlineFromNow(secondsFromNow: number): bigint {
  if (!Number.isInteger(secondsFromNow) || secondsFromNow <= 0) {
    throw new ValidationError("secondsFromNow", "Must be a positive integer");
  }
  return BigInt(Math.floor(Date.now() / 1000) + secondsFromNow);
}

/**
 * Build a 1-hour deadline from now.
 *
 * @returns Unix timestamp 3600 seconds in the future.
 */
export function oneHourDeadline(): bigint {
  return deadlineFromNow(ONE_HOUR_SECONDS);
}

/**
 * Build a 1-day deadline from now.
 *
 * @returns Unix timestamp 86400 seconds in the future.
 */
export function oneDayDeadline(): bigint {
  return deadlineFromNow(ONE_DAY_SECONDS);
}
