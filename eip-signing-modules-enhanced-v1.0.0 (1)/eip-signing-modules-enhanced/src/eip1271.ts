/**
 * EIP-1271: Standard Signature Validation Method for Contracts — v1.0.0
 *
 * Allows smart contract wallets to validate signatures by implementing:
 *   isValidSignature(bytes32 hash, bytes calldata signature) → bytes4
 *
 * Magic value indicating a valid signature: 0x1626ba7e
 * Any other value (including revert) indicates invalid.
 *
 * Security properties:
 * - Always call isValidSignature via staticCall — never a state-changing call.
 * - Verify the contract is deployed before calling; undeployed addresses return "0x".
 * - For counterfactual (not-yet-deployed) accounts, use EIP-6492 instead.
 *
 * @see https://eips.ethereum.org/EIPS/eip-1271
 */

import { ethers } from "ethers";
import {
  assertNonZeroAddress,
  assertBytes32,
  assertECDSASignature,
  assertNonEmpty,
} from "./validate.js";
import {
  ProviderError,
  ContractSignatureError,
  InvalidAddressError,
} from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Magic return value from isValidSignature() indicating a valid signature. */
export const EIP1271_MAGIC_VALUE = "0x1626ba7e";

/** Return value indicating an invalid signature (also returned on revert). */
export const EIP1271_INVALID_VALUE = "0xffffffff";

/** ABI fragment for the EIP-1271 interface. */
const EIP1271_ABI: string[] = [
  "function isValidSignature(bytes32 _hash, bytes calldata _signature) external view returns (bytes4 magicValue)",
];

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of isValidSignature check. */
export interface EIP1271CheckResult {
  /** True when the contract returned the EIP-1271 magic value. */
  valid: boolean;
  /** Raw bytes4 value returned by the contract. */
  magicValue: string;
  /** The contract address that was queried. */
  contractAddress: string;
  /** The hash that was checked. */
  hash: string;
}

/** Result of universal signature verification (EOA + contract + counterfactual). */
export interface UniversalVerifyResult extends EIP1271CheckResult {
  /** Whether the signer was an EOA, a deployed contract, or determined by contract call. */
  signerType: "eoa" | "contract";
}

// ─── Core Validation ──────────────────────────────────────────────────────────

/**
 * Call isValidSignature on a smart contract wallet.
 *
 * Uses staticCall to prevent any state mutation. Reverts are caught and
 * treated as an invalid signature rather than propagated as exceptions.
 *
 * @param provider        - ethers Provider connected to the correct network.
 * @param contractAddress - Smart contract wallet address.
 * @param hash            - 32-byte hash that was signed (bytes32).
 * @param signature       - The raw signature bytes to validate.
 * @returns Check result with validity flag and raw magic value.
 * @throws ValidationError if contractAddress is zero or hash is not bytes32.
 * @throws ProviderError   if the static call fails for a non-revert reason.
 */
export async function isValidSignature(
  provider: ethers.Provider,
  contractAddress: string,
  hash: string,
  signature: string
): Promise<EIP1271CheckResult> {
  assertNonZeroAddress("contractAddress", contractAddress);
  assertBytes32("hash", hash);
  // Signature can be any bytes length for EIP-1271 (smart accounts may use non-ECDSA)

  const contract = new ethers.Contract(contractAddress, EIP1271_ABI, provider);

  let magicValue: string;
  try {
    magicValue = await contract.isValidSignature.staticCall(hash, signature);
  } catch (err) {
    // Revert = invalid signature, not a system error
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("revert") ||
      message.includes("CALL_EXCEPTION") ||
      message.includes("execution reverted")
    ) {
      return {
        valid: false,
        magicValue: EIP1271_INVALID_VALUE,
        contractAddress,
        hash,
      };
    }
    throw new ProviderError("EIP1271.isValidSignature", err);
  }

  return {
    valid: magicValue.toLowerCase() === EIP1271_MAGIC_VALUE.toLowerCase(),
    magicValue,
    contractAddress,
    hash,
  };
}

/**
 * Validate an EIP-191 personal message signature against a contract.
 *
 * Hashes the message with the EIP-191 prefix then calls isValidSignature.
 *
 * @param provider        - ethers Provider.
 * @param contractAddress - Smart contract wallet address.
 * @param message         - The plaintext message that was signed.
 * @param signature       - The signature bytes to validate.
 * @returns Check result.
 * @throws ValidationError if message is empty or contractAddress is invalid.
 */
export async function isValidMessageSignature(
  provider: ethers.Provider,
  contractAddress: string,
  message: string,
  signature: string
): Promise<EIP1271CheckResult> {
  assertNonEmpty("message", message);
  assertNonZeroAddress("contractAddress", contractAddress);
  const hash = ethers.hashMessage(message);
  return isValidSignature(provider, contractAddress, hash, signature);
}

/**
 * Validate an EIP-712 typed data signature against a contract.
 *
 * Computes the EIP-712 digest then calls isValidSignature.
 *
 * @param provider        - ethers Provider.
 * @param contractAddress - Smart contract wallet address.
 * @param domain          - EIP-712 domain used to produce the signature.
 * @param types           - EIP-712 type definitions.
 * @param value           - The typed data value that was signed.
 * @param signature       - The signature bytes to validate.
 * @returns Check result.
 */
export async function isValidTypedDataSignature(
  provider: ethers.Provider,
  contractAddress: string,
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, unknown>,
  signature: string
): Promise<EIP1271CheckResult> {
  assertNonZeroAddress("contractAddress", contractAddress);
  const hash = ethers.TypedDataEncoder.hash(domain, types, value);
  return isValidSignature(provider, contractAddress, hash, signature);
}

// ─── Account Type Detection ───────────────────────────────────────────────────

/**
 * Determine whether an address is a deployed contract or an EOA.
 *
 * Returns true if code at the address is non-empty. Note: an EIP-7702
 * delegated EOA will also return true (code = "0xef0100...").
 *
 * @param provider - ethers Provider.
 * @param address  - Checksummed Ethereum address.
 * @returns true if contract, false if EOA.
 * @throws InvalidAddressError if address is not valid.
 * @throws ProviderError       if the getCode call fails.
 */
export async function isContract(
  provider: ethers.Provider,
  address: string
): Promise<boolean> {
  assertNonZeroAddress("address", address);
  let code: string;
  try {
    code = await provider.getCode(address);
  } catch (err) {
    throw new ProviderError("EIP1271.isContract", err);
  }
  return code !== "0x" && code !== "0x0";
}

// ─── Universal Verifier ───────────────────────────────────────────────────────

/**
 * Universal signature verifier: auto-detects EOA vs deployed contract.
 *
 * - EOA addresses: verifies via ecrecover (EIP-191 personal_sign prefix).
 * - Deployed contracts: delegates to EIP-1271 isValidSignature.
 *
 * For counterfactual (not-yet-deployed) accounts, use EIP-6492 instead.
 *
 * @param provider        - ethers Provider connected to the correct network.
 * @param signerAddress   - Address of the signer (EOA or contract).
 * @param message         - The original plaintext message.
 * @param signature       - The signature to verify.
 * @returns Universal verify result including signerType.
 * @throws ValidationError if any argument is invalid.
 * @throws ProviderError   if provider calls fail.
 */
export async function verifyUniversal(
  provider: ethers.Provider,
  signerAddress: string,
  message: string,
  signature: string
): Promise<UniversalVerifyResult> {
  assertNonZeroAddress("signerAddress", signerAddress);
  assertNonEmpty("message", message);
  assertECDSASignature("signature", signature);

  const hash = ethers.hashMessage(message);
  const contractSigner = await isContract(provider, signerAddress);

  if (contractSigner) {
    const result = await isValidMessageSignature(
      provider,
      signerAddress,
      message,
      signature
    );
    return { ...result, signerType: "contract" };
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (err) {
    throw new ProviderError("EIP1271.verifyUniversal.ecrecover", err);
  }

  const valid = recovered.toLowerCase() === signerAddress.toLowerCase();
  return {
    valid,
    magicValue: valid ? EIP1271_MAGIC_VALUE : EIP1271_INVALID_VALUE,
    contractAddress: signerAddress,
    hash,
    signerType: "eoa",
  };
}

/**
 * Assert that a signature is valid — throws ContractSignatureError if not.
 *
 * Convenience wrapper for use in validation pipelines that prefer exceptions
 * over boolean result checks.
 *
 * @param provider        - ethers Provider.
 * @param contractAddress - Smart contract wallet address.
 * @param hash            - 32-byte hash (bytes32).
 * @param signature       - Signature bytes.
 * @throws ContractSignatureError if the signature is invalid.
 * @throws ProviderError          if the call fails.
 */
export async function assertValidSignature(
  provider: ethers.Provider,
  contractAddress: string,
  hash: string,
  signature: string
): Promise<void> {
  const result = await isValidSignature(
    provider,
    contractAddress,
    hash,
    signature
  );
  if (!result.valid) {
    throw new ContractSignatureError(contractAddress, result.magicValue);
  }
}
