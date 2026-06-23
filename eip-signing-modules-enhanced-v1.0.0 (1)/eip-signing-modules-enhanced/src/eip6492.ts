/**
 * EIP-6492: Signature Validation for Predeploy Contracts — v1.0.0
 *
 * Validates signatures from smart contract wallets that have not yet been
 * deployed (counterfactual accounts). The outer signature wraps:
 *   abi.encode(factory, factoryCalldata, innerSig) + magicSuffix
 *
 * Magic suffix (32 bytes):
 *   0x6492649264926492649264926492649264926492649264926492649264926492
 *
 * Security properties:
 * - The magic suffix is 32 repeating bytes of 0x6492 — chosen to be
 *   astronomically unlikely to appear in a valid ECDSA signature tail.
 * - Validation must use the UniversalSigValidator contract via staticCall —
 *   the validator transiently deploys the account and checks isValidSignature.
 * - The account is NOT permanently deployed by this check.
 * - Never use a mutable call for validation — staticCall only.
 *
 * @see https://eips.ethereum.org/EIPS/eip-6492
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
  NotEIP6492Error,
  ValidationError,
} from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * EIP-6492 magic suffix — 32 bytes appended after the ABI-encoded wrapper.
 * Presence of these bytes signals that the outer format is EIP-6492.
 */
export const EIP6492_MAGIC_SUFFIX =
  "0x6492649264926492649264926492649264926492649264926492649264926492";

/** Canonical UniversalSigValidator deployment address (EIP-6492 §8). */
export const UNIVERSAL_SIG_VALIDATOR_ADDRESS =
  "0x60C8bE12F4f1eC76d1df05E3FF66CAdE5e8Dba2";

/** ABI for the EIP-6492 UniversalSigValidator contract. */
const UNIVERSAL_VALIDATOR_ABI: string[] = [
  "function isValidSig(address _signer, bytes32 _hash, bytes calldata _signature) external returns (bool)",
];

/** ABI for EIP-1271 isValidSignature (used for deployed accounts). */
const EIP1271_ABI: string[] = [
  "function isValidSignature(bytes32 _hash, bytes calldata _signature) external view returns (bytes4 magicValue)",
];

/** EIP-1271 magic value for a valid signature. */
const EIP1271_MAGIC_VALUE = "0x1626ba7e";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Components of an unwrapped EIP-6492 signature. */
export interface EIP6492Components {
  /** Factory contract address that deploys the account. */
  factory: string;
  /** Calldata passed to the factory to deploy the account. */
  factoryCalldata: string;
  /** Inner signature from the smart account (post-deployment). */
  innerSignature: string;
}

/** Result of a universal validation call. */
export interface UniversalValidationResult {
  valid: boolean;
  /** "eoa" | "deployed-contract" | "counterfactual" */
  accountType: "eoa" | "deployed-contract" | "counterfactual";
}

// ─── Wrapping / Unwrapping ────────────────────────────────────────────────────

/**
 * Wrap an inner signature with EIP-6492 factory deployment data.
 *
 * The result can be passed to any EIP-6492-aware validator to verify
 * signatures from accounts that haven't been deployed yet.
 *
 * Format: abi.encode(factory, factoryCalldata, innerSig) ++ magicSuffix
 *
 * @param factory          - Factory contract address.
 * @param factoryCalldata  - ABI-encoded factory function call for deployment.
 * @param innerSignature   - The inner signature from the smart account's signer.
 * @returns EIP-6492 wrapped signature as 0x-prefixed hex.
 * @throws ValidationError if factory is zero address.
 */
export function wrapWithEIP6492(
  factory: string,
  factoryCalldata: string,
  innerSignature: string
): string {
  assertNonZeroAddress("factory", factory);
  if (typeof factoryCalldata !== "string" || !/^0x/.test(factoryCalldata)) {
    throw new ValidationError("factoryCalldata", "Must be a 0x-prefixed hex string");
  }
  if (typeof innerSignature !== "string" || !/^0x/.test(innerSignature)) {
    throw new ValidationError("innerSignature", "Must be a 0x-prefixed hex string");
  }

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes", "bytes"],
    [factory, factoryCalldata, innerSignature]
  );
  return ethers.concat([encoded, EIP6492_MAGIC_SUFFIX]);
}

/**
 * Detect whether a signature carries the EIP-6492 magic suffix.
 *
 * @param signature - Any signature string (0x-prefixed hex).
 * @returns true if the last 32 bytes match the EIP-6492 magic suffix.
 */
export function isEIP6492Signature(signature: string): boolean {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]*$/.test(signature)) {
    return false;
  }
  const sigBytes = ethers.getBytes(signature);
  if (sigBytes.length < 32) return false;
  const tail = ethers.hexlify(sigBytes.slice(sigBytes.length - 32));
  return tail.toLowerCase() === EIP6492_MAGIC_SUFFIX.toLowerCase();
}

/**
 * Unwrap an EIP-6492 signature into its factory, factoryCalldata, and innerSignature.
 *
 * @param signature - A valid EIP-6492 wrapped signature.
 * @returns Unwrapped components.
 * @throws NotEIP6492Error if the signature does not carry the magic suffix.
 * @throws ProviderError   if ABI decoding fails (malformed wrapper).
 */
export function unwrapEIP6492(signature: string): EIP6492Components {
  if (!isEIP6492Signature(signature)) {
    throw new NotEIP6492Error();
  }

  const sigBytes = ethers.getBytes(signature);
  const withoutSuffix = sigBytes.slice(0, sigBytes.length - 32);

  let factory: string, factoryCalldata: string, innerSignature: string;
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["address", "bytes", "bytes"],
      withoutSuffix
    );
    factory = decoded[0] as string;
    factoryCalldata = decoded[1] as string;
    innerSignature = decoded[2] as string;
  } catch (err) {
    throw new ProviderError("EIP6492.unwrapEIP6492: ABI decode failed", err);
  }

  return { factory, factoryCalldata, innerSignature };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate an EIP-6492 signature using the UniversalSigValidator contract.
 *
 * The validator:
 * 1. Detects the magic suffix.
 * 2. Transiently deploys the account using the embedded factory calldata.
 * 3. Calls isValidSignature(hash, innerSig) on the (just-deployed) account.
 * 4. Reverts the transient deployment — the account is NOT persisted.
 *
 * Uses staticCall to ensure no state is mutated.
 *
 * @param provider                  - ethers Provider.
 * @param signerAddress             - The smart account's (counterfactual) address.
 * @param hash                      - The 32-byte hash that was signed (bytes32).
 * @param signature                 - The EIP-6492 wrapped signature.
 * @param universalValidatorAddress - Address of the deployed UniversalSigValidator.
 * @returns true if the signature is valid for the given hash.
 * @throws ValidationError if signerAddress is zero or hash is not bytes32.
 * @throws ProviderError   if the validator call fails unexpectedly.
 */
export async function validateEIP6492Signature(
  provider: ethers.Provider,
  signerAddress: string,
  hash: string,
  signature: string,
  universalValidatorAddress: string = UNIVERSAL_SIG_VALIDATOR_ADDRESS
): Promise<boolean> {
  assertNonZeroAddress("signerAddress", signerAddress);
  assertBytes32("hash", hash);
  assertNonZeroAddress("universalValidatorAddress", universalValidatorAddress);

  const validator = new ethers.Contract(
    universalValidatorAddress,
    UNIVERSAL_VALIDATOR_ABI,
    provider
  );

  try {
    return await validator.isValidSig.staticCall(signerAddress, hash, signature);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("revert") ||
      message.includes("CALL_EXCEPTION") ||
      message.includes("execution reverted")
    ) {
      return false;
    }
    throw new ProviderError("EIP6492.validateEIP6492Signature", err);
  }
}

/**
 * Universal validator: handles EOA, deployed contract, and counterfactual accounts.
 *
 * Decision tree:
 * 1. If signature carries EIP-6492 magic suffix → use UniversalSigValidator.
 * 2. Else if signerAddress has deployed code → EIP-1271 isValidSignature.
 * 3. Else → ecrecover (EOA).
 *
 * @param provider                  - ethers Provider.
 * @param signerAddress             - The signer's address.
 * @param message                   - The original plaintext message.
 * @param signature                 - Any signature (EIP-6492, plain ECDSA, or EIP-1271).
 * @param universalValidatorAddress - UniversalSigValidator address (optional override).
 * @returns Validation result with accountType discriminator.
 * @throws ValidationError if addresses are invalid.
 * @throws ProviderError   if any provider call fails.
 */
export async function validateUniversal(
  provider: ethers.Provider,
  signerAddress: string,
  message: string,
  signature: string,
  universalValidatorAddress: string = UNIVERSAL_SIG_VALIDATOR_ADDRESS
): Promise<UniversalValidationResult> {
  assertNonZeroAddress("signerAddress", signerAddress);
  assertNonEmpty("message", message);

  const hash = ethers.hashMessage(message);

  if (isEIP6492Signature(signature)) {
    const valid = await validateEIP6492Signature(
      provider,
      signerAddress,
      hash,
      signature,
      universalValidatorAddress
    );
    return { valid, accountType: "counterfactual" };
  }

  let code: string;
  try {
    code = await provider.getCode(signerAddress);
  } catch (err) {
    throw new ProviderError("EIP6492.validateUniversal.getCode", err);
  }

  const isDeployed = code !== "0x" && code !== "0x0";

  if (isDeployed) {
    const contract = new ethers.Contract(signerAddress, EIP1271_ABI, provider);
    let magicValue: string;
    try {
      magicValue = await contract.isValidSignature.staticCall(hash, signature);
    } catch {
      return { valid: false, accountType: "deployed-contract" };
    }
    return {
      valid: magicValue.toLowerCase() === EIP1271_MAGIC_VALUE.toLowerCase(),
      accountType: "deployed-contract",
    };
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch (err) {
    throw new ProviderError("EIP6492.validateUniversal.ecrecover", err);
  }
  return {
    valid: recovered.toLowerCase() === signerAddress.toLowerCase(),
    accountType: "eoa",
  };
}

// ─── Factory calldata Encoders ────────────────────────────────────────────────

/**
 * Encode createAccount calldata for the reference SimpleAccount factory (ERC-4337).
 *
 * @param ownerAddress - EOA address that controls the smart account.
 * @param salt         - Deployment salt (determines counterfactual address).
 * @returns ABI-encoded createAccount calldata.
 * @throws ValidationError if ownerAddress is zero.
 */
export function encodeSimpleAccountFactoryCalldata(
  ownerAddress: string,
  salt: bigint
): string {
  assertNonZeroAddress("ownerAddress", ownerAddress);
  const iface = new ethers.Interface([
    "function createAccount(address owner, uint256 salt) returns (address)",
  ]);
  return iface.encodeFunctionData("createAccount", [ownerAddress, salt]);
}

/**
 * Compute the counterfactual address of a SimpleAccount before deployment.
 *
 * Uses CREATE2 address derivation: keccak256(0xff ++ factory ++ salt ++ initcodeHash).
 *
 * @param factoryAddress - SimpleAccountFactory address.
 * @param ownerAddress   - EOA owner address.
 * @param salt           - Deployment salt.
 * @param initcodeHash   - keccak256 of the account's creation bytecode (from factory).
 * @returns Counterfactual account address.
 * @throws ValidationError if any address is zero.
 */
export function computeCounterfactualAddress(
  factoryAddress: string,
  ownerAddress: string,
  salt: bigint,
  initcodeHash: string
): string {
  assertNonZeroAddress("factoryAddress", factoryAddress);
  assertNonZeroAddress("ownerAddress", ownerAddress);
  assertBytes32("initcodeHash", initcodeHash);

  const saltBytes = ethers.zeroPadValue(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [ownerAddress, salt]
    ),
    32
  );

  return ethers.getCreate2Address(factoryAddress, saltBytes, initcodeHash);
}
