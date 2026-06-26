/**
 * EIP-4337: Account Abstraction via Alt Mempool — v1.0.0
 *
 * UserOperations, bundlers, EntryPoint v0.7 interaction, paymaster data encoding.
 * All operations target the canonical EntryPoint v0.7 deployed at:
 *   0x0000000071727De22E5E9d8BAf0edAc6f37da032
 *
 * Security properties:
 * - Always fetch nonces from the EntryPoint — never derive them locally.
 * - preVerificationGas must account for calldata cost; underestimation causes
 *   bundler rejection without on-chain revert.
 * - Paymaster validity windows (validUntil/validAfter) should be short (≤1hr).
 * - signUserOperation signs the EntryPoint's getUserOpHash, not the raw UserOp.
 *
 * @see https://eips.ethereum.org/EIPS/eip-4337
 */

import { ethers } from "ethers";
import {
  assertNonZeroAddress,
  assertPositiveBigInt,
  assertNonEmpty,
  assertSameLength,
} from "./validate.js";
import { ProviderError, ValidationError } from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Canonical EntryPoint v0.7 address — same across all EVM chains. */
export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

/** Validation success indicator in validateUserOp return value. */
export const VALIDATION_SUCCESS = BigInt(0);

/** Bit mask for validAfter/validUntil packed into validateUserOp return. */
export const SIG_VALIDATION_FAILED = BigInt(1);

/** Minimum recommended preVerificationGas for a simple transfer. */
export const MIN_PRE_VERIFICATION_GAS = BigInt(21_000);

/** ABI fragments for the EntryPoint v0.7 contract. */
const ENTRY_POINT_ABI: string[] = [
  "function getUserOpHash(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp) view returns (bytes32)",
  "function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary) external",
  "function getNonce(address sender, uint192 key) view returns (uint256 nonce)",
  "function balanceOf(address account) view returns (uint256)",
  "function depositTo(address account) payable external",
  "function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external",
];

// ─── Types ───────────────────────────────────────────────────────────────────

/** EIP-4337 v0.7 UserOperation (packed format). */
export interface UserOperation {
  sender: string;
  nonce: bigint;
  /** ABI-encoded factory address + factory calldata, or "0x" for deployed accounts. */
  initCode: string;
  callData: string;
  /** bytes32: verificationGasLimit (upper 16 bytes) || callGasLimit (lower 16 bytes). */
  accountGasLimits: string;
  preVerificationGas: bigint;
  /** bytes32: maxPriorityFeePerGas (upper 16 bytes) || maxFeePerGas (lower 16 bytes). */
  gasFees: string;
  /** Paymaster address (20 bytes) + paymaster-specific data, or "0x". */
  paymasterAndData: string;
  signature: string;
}

/** Gas parameters for building a UserOperation. */
export interface UserOpGasParams {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  preVerificationGas?: bigint;
}

/** Unpacked accountGasLimits fields. */
export interface AccountGasLimits {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
}

/** Unpacked gasFees fields. */
export interface GasFees {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
}

/** A single call encoded for executeBatch. */
export interface BatchCall {
  to: string;
  value: bigint;
  data: string;
}

// ─── Packing / Unpacking ──────────────────────────────────────────────────────

/**
 * Pack verificationGasLimit and callGasLimit into the bytes32 accountGasLimits field.
 *
 * Layout: verificationGasLimit occupies the upper 16 bytes (bits 128–255),
 * callGasLimit occupies the lower 16 bytes (bits 0–127).
 *
 * @param verificationGasLimit - Gas limit for signature validation step.
 * @param callGasLimit         - Gas limit for the execution call.
 * @returns 0x-prefixed 32-byte hex string.
 * @throws ValidationError if either value exceeds uint128.
 */
export function packAccountGasLimits(
  verificationGasLimit: bigint,
  callGasLimit: bigint
): string {
  const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);
  if (verificationGasLimit > MAX_UINT128) {
    throw new ValidationError("verificationGasLimit", `Exceeds uint128 max (${MAX_UINT128})`);
  }
  if (callGasLimit > MAX_UINT128) {
    throw new ValidationError("callGasLimit", `Exceeds uint128 max (${MAX_UINT128})`);
  }
  const packed = (verificationGasLimit << BigInt(128)) | callGasLimit;
  return ethers.zeroPadValue(ethers.toBeHex(packed), 32);
}

/**
 * Pack maxPriorityFeePerGas and maxFeePerGas into the bytes32 gasFees field.
 *
 * @param maxPriorityFeePerGas - EIP-1559 priority fee per gas.
 * @param maxFeePerGas         - EIP-1559 max fee per gas.
 * @returns 0x-prefixed 32-byte hex string.
 * @throws ValidationError if either value exceeds uint128.
 */
export function packGasFees(
  maxPriorityFeePerGas: bigint,
  maxFeePerGas: bigint
): string {
  const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);
  if (maxPriorityFeePerGas > MAX_UINT128) {
    throw new ValidationError("maxPriorityFeePerGas", `Exceeds uint128 max (${MAX_UINT128})`);
  }
  if (maxFeePerGas > MAX_UINT128) {
    throw new ValidationError("maxFeePerGas", `Exceeds uint128 max (${MAX_UINT128})`);
  }
  const packed = (maxPriorityFeePerGas << BigInt(128)) | maxFeePerGas;
  return ethers.zeroPadValue(ethers.toBeHex(packed), 32);
}

/**
 * Unpack accountGasLimits bytes32 into verificationGasLimit and callGasLimit.
 *
 * @param accountGasLimits - 0x-prefixed 32-byte hex from a UserOperation.
 * @returns Unpacked gas limit fields.
 */
export function unpackAccountGasLimits(accountGasLimits: string): AccountGasLimits {
  const val = BigInt(accountGasLimits);
  const callGasLimit = val & ((BigInt(1) << BigInt(128)) - BigInt(1));
  const verificationGasLimit = val >> BigInt(128);
  return { verificationGasLimit, callGasLimit };
}

/**
 * Unpack gasFees bytes32 into maxPriorityFeePerGas and maxFeePerGas.
 *
 * @param gasFees - 0x-prefixed 32-byte hex from a UserOperation.
 * @returns Unpacked fee fields.
 */
export function unpackGasFees(gasFees: string): GasFees {
  const val = BigInt(gasFees);
  const maxFeePerGas = val & ((BigInt(1) << BigInt(128)) - BigInt(1));
  const maxPriorityFeePerGas = val >> BigInt(128);
  return { maxPriorityFeePerGas, maxFeePerGas };
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build a UserOperation (v0.7 packed format) ready for signing.
 *
 * signature is set to "0x" — call signUserOperation() after building.
 *
 * @param params - UserOperation parameters.
 * @returns Unsigned UserOperation with empty signature.
 * @throws ValidationError if sender is zero or gas params are invalid.
 */
export function buildUserOperation(params: {
  sender: string;
  nonce: bigint;
  callData: string;
  gasParams: UserOpGasParams;
  initCode?: string;
  paymasterAndData?: string;
}): UserOperation {
  assertNonZeroAddress("sender", params.sender);

  const {
    sender,
    nonce,
    callData,
    gasParams,
    initCode = "0x",
    paymasterAndData = "0x",
  } = params;

  return {
    sender,
    nonce,
    initCode,
    callData,
    accountGasLimits: packAccountGasLimits(
      gasParams.verificationGasLimit,
      gasParams.callGasLimit
    ),
    preVerificationGas: gasParams.preVerificationGas ?? MIN_PRE_VERIFICATION_GAS,
    gasFees: packGasFees(gasParams.maxPriorityFeePerGas, gasParams.maxFeePerGas),
    paymasterAndData,
    signature: "0x",
  };
}

// ─── EntryPoint Interaction ───────────────────────────────────────────────────

/**
 * Compute the UserOperation hash from the EntryPoint contract.
 *
 * This is the canonical hash that bundlers and accounts must agree on.
 * It includes the EntryPoint address and chainId to prevent cross-chain replay.
 *
 * @param provider           - ethers Provider.
 * @param userOp             - The UserOperation to hash.
 * @param entryPointAddress  - EntryPoint contract address.
 * @returns 32-byte UserOp hash as 0x-prefixed hex.
 * @throws ProviderError if the EntryPoint call fails.
 */
export async function getUserOpHash(
  provider: ethers.Provider,
  userOp: UserOperation,
  entryPointAddress: string = ENTRY_POINT_V07
): Promise<string> {
  assertNonZeroAddress("entryPointAddress", entryPointAddress);
  const entryPoint = new ethers.Contract(entryPointAddress, ENTRY_POINT_ABI, provider);
  try {
    return await entryPoint.getUserOpHash(userOp);
  } catch (err) {
    throw new ProviderError("EIP4337.getUserOpHash", err);
  }
}

/**
 * Sign a UserOperation using the provided signer.
 *
 * Fetches the hash from the EntryPoint then signs it with EIP-191 personal_sign.
 * Returns an updated UserOperation with the signature field populated.
 *
 * @param signer             - The account owner's signer.
 * @param userOp             - Unsigned UserOperation (signature must be "0x").
 * @param provider           - ethers Provider.
 * @param entryPointAddress  - EntryPoint contract address.
 * @returns UserOperation with signature populated.
 * @throws ProviderError if hash fetch or signing fails.
 */
export async function signUserOperation(
  signer: ethers.Signer,
  userOp: UserOperation,
  provider: ethers.Provider,
  entryPointAddress: string = ENTRY_POINT_V07
): Promise<UserOperation> {
  const hash = await getUserOpHash(provider, userOp, entryPointAddress);
  let signature: string;
  try {
    signature = await signer.signMessage(ethers.getBytes(hash));
  } catch (err) {
    throw new ProviderError("EIP4337.signUserOperation", err);
  }
  return { ...userOp, signature };
}

/**
 * Fetch the current nonce for a smart account from the EntryPoint.
 *
 * The key parameter enables 2D nonces for parallel UserOp lanes.
 * key=0 returns the standard sequential nonce.
 *
 * @param provider           - ethers Provider.
 * @param accountAddress     - Smart account address.
 * @param key                - 192-bit nonce key (default 0 for sequential).
 * @param entryPointAddress  - EntryPoint contract address.
 * @returns Current nonce as bigint.
 * @throws ProviderError if the call fails.
 */
export async function getAccountNonce(
  provider: ethers.Provider,
  accountAddress: string,
  key: bigint = BigInt(0),
  entryPointAddress: string = ENTRY_POINT_V07
): Promise<bigint> {
  assertNonZeroAddress("accountAddress", accountAddress);
  const entryPoint = new ethers.Contract(entryPointAddress, ENTRY_POINT_ABI, provider);
  try {
    return await entryPoint.getNonce(accountAddress, key);
  } catch (err) {
    throw new ProviderError("EIP4337.getAccountNonce", err);
  }
}

/**
 * Get the EntryPoint deposit balance for an account or paymaster.
 *
 * @param provider           - ethers Provider.
 * @param address            - Account or paymaster address.
 * @param entryPointAddress  - EntryPoint contract address.
 * @returns Deposited balance in wei.
 * @throws ProviderError if the call fails.
 */
export async function getEntryPointBalance(
  provider: ethers.Provider,
  address: string,
  entryPointAddress: string = ENTRY_POINT_V07
): Promise<bigint> {
  assertNonZeroAddress("address", address);
  const entryPoint = new ethers.Contract(entryPointAddress, ENTRY_POINT_ABI, provider);
  try {
    return await entryPoint.balanceOf(address);
  } catch (err) {
    throw new ProviderError("EIP4337.getEntryPointBalance", err);
  }
}

/**
 * Deposit ETH to the EntryPoint for a smart account or paymaster.
 *
 * @param signer             - Signer paying for the deposit.
 * @param forAddress         - Account or paymaster address receiving the deposit.
 * @param amount             - Amount in wei.
 * @param entryPointAddress  - EntryPoint contract address.
 * @returns Transaction response.
 * @throws ValidationError if amount is zero.
 * @throws ProviderError   if the transaction fails.
 */
export async function depositToEntryPoint(
  signer: ethers.Signer,
  forAddress: string,
  amount: bigint,
  entryPointAddress: string = ENTRY_POINT_V07
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("forAddress", forAddress);
  assertPositiveBigInt("amount", amount);
  const entryPoint = new ethers.Contract(entryPointAddress, ENTRY_POINT_ABI, signer);
  try {
    return await entryPoint.depositTo(forAddress, { value: amount });
  } catch (err) {
    throw new ProviderError("EIP4337.depositToEntryPoint", err);
  }
}

// ─── callData Encoders ────────────────────────────────────────────────────────

/**
 * Encode a single ETH/token transfer as ERC-4337 callData.
 *
 * Uses the standard execute(address, uint256, bytes) interface
 * common in SimpleAccount and most 4337-compatible accounts.
 *
 * @param target - Destination address.
 * @param value  - ETH value in wei (0 for token/contract calls).
 * @param data   - Encoded function call data, or "0x" for plain ETH transfer.
 * @returns ABI-encoded callData.
 * @throws ValidationError if target is zero address.
 */
export function encodeExecuteCall(
  target: string,
  value: bigint,
  data: string
): string {
  assertNonZeroAddress("target", target);
  const iface = new ethers.Interface([
    "function execute(address dest, uint256 value, bytes calldata func) external",
  ]);
  return iface.encodeFunctionData("execute", [target, value, data]);
}

/**
 * Encode a batch of calls as ERC-4337 callData.
 *
 * Uses the standard executeBatch(address[], uint256[], bytes[]) interface.
 * All three arrays must have the same length.
 *
 * @param calls - Array of {to, value, data} batch call descriptors.
 * @returns ABI-encoded callData.
 * @throws ValidationError if calls is empty.
 */
export function encodeExecuteBatch(calls: BatchCall[]): string {
  if (calls.length === 0) {
    throw new ValidationError("calls", "Batch must contain at least one call");
  }
  calls.forEach((c, i) => assertNonZeroAddress(`calls[${i}].to`, c.to));

  const iface = new ethers.Interface([
    "function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func) external",
  ]);
  return iface.encodeFunctionData("executeBatch", [
    calls.map((c) => c.to),
    calls.map((c) => c.value),
    calls.map((c) => c.data),
  ]);
}

// ─── Paymaster Helpers ────────────────────────────────────────────────────────

/**
 * Build paymasterAndData for a verifying paymaster.
 *
 * Layout (per ERC-4337 v0.7 paymaster spec):
 *   paymasterAddress (20 bytes)
 *   || paymasterVerificationGasLimit (16 bytes)
 *   || paymasterPostOpGasLimit (16 bytes)
 *   || validUntil (6 bytes)
 *   || validAfter (6 bytes)
 *   || paymasterSignature (variable)
 *
 * @param paymasterAddress              - Paymaster contract address.
 * @param paymasterVerificationGasLimit - Gas for paymaster validatePaymasterUserOp.
 * @param paymasterPostOpGasLimit       - Gas for paymaster postOp.
 * @param validUntil                    - Timestamp after which paymaster approval expires.
 * @param validAfter                    - Timestamp before which paymaster approval is invalid.
 * @param paymasterSignature            - Paymaster's ECDSA or custom signature.
 * @returns Concatenated paymasterAndData bytes.
 * @throws ValidationError if paymasterAddress is zero.
 */
export function buildVerifyingPaymasterData(
  paymasterAddress: string,
  paymasterVerificationGasLimit: bigint,
  paymasterPostOpGasLimit: bigint,
  validUntil: bigint,
  validAfter: bigint,
  paymasterSignature: string
): string {
  assertNonZeroAddress("paymasterAddress", paymasterAddress);
  const verGasHex = ethers.zeroPadValue(ethers.toBeHex(paymasterVerificationGasLimit), 16);
  const postOpGasHex = ethers.zeroPadValue(ethers.toBeHex(paymasterPostOpGasLimit), 16);
  const validUntilHex = ethers.zeroPadValue(ethers.toBeHex(validUntil), 6);
  const validAfterHex = ethers.zeroPadValue(ethers.toBeHex(validAfter), 6);
  return ethers.concat([
    paymasterAddress,
    verGasHex,
    postOpGasHex,
    validUntilHex,
    validAfterHex,
    paymasterSignature,
  ]);
}

/**
 * Encode initCode for deploying via a factory (used for account creation UserOps).
 *
 * initCode = factory address (20 bytes) + factory calldata
 *
 * @param factoryAddress  - Account factory contract address.
 * @param factoryCalldata - ABI-encoded factory function call.
 * @returns Concatenated initCode bytes.
 * @throws ValidationError if factoryAddress is zero.
 */
export function encodeInitCode(
  factoryAddress: string,
  factoryCalldata: string
): string {
  assertNonZeroAddress("factoryAddress", factoryAddress);
  return ethers.concat([factoryAddress, factoryCalldata]);
}
