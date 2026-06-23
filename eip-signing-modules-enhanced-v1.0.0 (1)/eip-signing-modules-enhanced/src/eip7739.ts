/**
 * EIP-7739: Readable Typed Signatures for Smart Accounts — v1.0.0
 *
 * Prevents cross-account signature replay attacks by binding EIP-712 typed
 * data to a specific smart account address using nested EIP-712 wrapping.
 *
 * Two wrapper types are defined:
 * - TypedDataSign  — wraps an existing EIP-712 struct
 * - PersonalSign   — wraps a plain personal_sign message
 *
 * Both use the smart account's own EIP-712 domain as the outer domain,
 * making the signature invalid for any other account address.
 *
 * Security properties:
 * - Prevents replay: a permit signed for AccountA cannot be submitted to AccountB.
 * - Wallet-readable: EIP-712 aware wallets display the inner struct in clear text.
 * - Backward-compatible with EIP-712 verifiers that only check the outer digest.
 * - Required for ERC-4337 smart accounts that expose isValidSignature().
 *
 * @see https://eips.ethereum.org/EIPS/eip-7739
 */

import { ethers } from "ethers";
import {
  assertNonZeroAddress,
  assertNonEmpty,
  assertChainId,
  assertECDSASignature,
} from "./validate.js";
import { ProviderError, ValidationError } from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** TypedDataSign wrapper type fields. */
export const TYPED_DATA_SIGN_FIELDS: ethers.TypedDataField[] = [
  { name: "contents", type: "bytes32" },
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
  { name: "extensions", type: "uint256[]" },
];

/** PersonalSign wrapper type fields. */
export const PERSONAL_SIGN_FIELDS: ethers.TypedDataField[] = [
  { name: "prefixed", type: "bytes32" },
];

/** EIP-712 type map for TypedDataSign. */
export const TYPED_DATA_SIGN_TYPES: Record<string, ethers.TypedDataField[]> = {
  TypedDataSign: TYPED_DATA_SIGN_FIELDS,
};

/** EIP-712 type map for PersonalSign. */
export const PERSONAL_SIGN_TYPES: Record<string, ethers.TypedDataField[]> = {
  PersonalSign: PERSONAL_SIGN_FIELDS,
};

// ─── Types ───────────────────────────────────────────────────────────────────

/** The smart account's EIP-712 domain (used as the outer binding domain). */
export interface EIP7739AccountDomain {
  name: string;
  version: string;
  chainId: number;
  /** The smart account's own address — this is the anti-replay binding. */
  verifyingContract: string;
  salt?: string;
}

/** Result from signWithEIP7739. */
export interface EIP7739SignResult {
  accountDomain: EIP7739AccountDomain;
  /** keccak256 of the inner app typed data struct. */
  contentsHash: string;
  /** EIP-712 type string of the primary inner type, e.g. "Mail(address from,...)" */
  contentsType: string;
  /** The outer EIP-712 digest that was signed. */
  outerDigest: string;
  /** 65-byte ECDSA signature. */
  signature: string;
  /** Checksummed signer address. */
  signer: string;
}

/** Result from signPersonalWithEIP7739. */
export interface EIP7739PersonalSignResult {
  accountDomain: EIP7739AccountDomain;
  /** EIP-191 prefixed hash of the original message. */
  prefixedHash: string;
  /** The outer EIP-712 digest that was signed. */
  outerDigest: string;
  /** 65-byte ECDSA signature. */
  signature: string;
  /** Checksummed signer address. */
  signer: string;
}

/** Result from verify functions. */
export interface EIP7739VerifyResult {
  valid: boolean;
  recoveredAddress: string;
  expectedSigner: string;
  outerDigest: string;
}

// ─── Domain Builders ──────────────────────────────────────────────────────────

/**
 * Build the EIP-7739 account domain for a smart account.
 *
 * The verifyingContract MUST be the smart account's address — this is what
 * prevents replay across different accounts.
 *
 * @param accountAddress - The smart account address (the replay-prevention binding).
 * @param chainId        - Chain ID of the network.
 * @param name           - Domain name (default "ERC7739", match what the account uses).
 * @param version        - Domain version (default "1").
 * @returns EIP7739AccountDomain.
 * @throws ValidationError if accountAddress is zero or chainId is invalid.
 */
export function buildAccountDomain(
  accountAddress: string,
  chainId: number,
  name: string = "ERC7739",
  version: string = "1"
): EIP7739AccountDomain {
  assertNonZeroAddress("accountAddress", accountAddress);
  assertChainId("chainId", chainId);
  assertNonEmpty("name", name);
  assertNonEmpty("version", version);
  return { name, version, chainId, verifyingContract: accountAddress };
}

// ─── Hash Utilities ───────────────────────────────────────────────────────────

/**
 * Compute the contentsHash: the struct hash of the inner app-level typed data.
 *
 * This is the EIP-712 hashStruct of the original typed data the dApp wants signed.
 * It is embedded as the `contents` field in the TypedDataSign wrapper.
 *
 * @param types - The inner app's type definitions.
 * @param value - The inner app's typed data value.
 * @returns bytes32 struct hash as 0x-prefixed hex.
 */
export function computeContentsHash(
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, unknown>
): string {
  if (Object.keys(types).length === 0) {
    throw new ValidationError("types", "Must define at least one type");
  }
  const primaryType = Object.keys(types)[0];
  return ethers.TypedDataEncoder.hashStruct(primaryType, types, value);
}

/**
 * Derive the contentsType string embedded in the TypedDataSign wrapper.
 *
 * Format: "TypeName(field1Type field1Name,...)" — the standard EIP-712 type encoding.
 * Example: "Mail(address from,address to,string contents)"
 *
 * @param types - The inner app's type definitions.
 * @returns EIP-712 type string for the primary type.
 */
export function encodeContentsType(
  types: Record<string, ethers.TypedDataField[]>
): string {
  if (Object.keys(types).length === 0) {
    throw new ValidationError("types", "Must define at least one type");
  }
  const encoder = ethers.TypedDataEncoder.from(types);
  return encoder.encodeType(Object.keys(types)[0]);
}

// ─── Signing ──────────────────────────────────────────────────────────────────

/**
 * Sign EIP-712 typed data using the EIP-7739 account-bound wrapper.
 *
 * The smart account's domain is used as the outer EIP-712 domain.
 * The app's typed data is nested as `contents` inside TypedDataSign.
 * The resulting signature is account-specific and cannot be replayed
 * against a different smart account address.
 *
 * @param signer        - Wallet signer (owner of the smart account).
 * @param accountDomain - The smart account's EIP-712 domain.
 * @param appDomain     - The application's EIP-712 domain (inner).
 * @param types         - The app's type definitions.
 * @param value         - The app's typed data value.
 * @returns Full signing result with contentsHash, contentsType, outerDigest.
 * @throws ValidationError if domain fields are invalid.
 * @throws ProviderError   if signing fails.
 */
export async function signWithEIP7739(
  signer: ethers.Wallet,
  accountDomain: EIP7739AccountDomain,
  appDomain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, unknown>
): Promise<EIP7739SignResult> {
  assertNonZeroAddress("accountDomain.verifyingContract", accountDomain.verifyingContract);
  assertChainId("accountDomain.chainId", accountDomain.chainId);
  if (Object.keys(types).length === 0) {
    throw new ValidationError("types", "Must define at least one type");
  }

  const contentsHash = computeContentsHash(types, value);
  const contentsType = encodeContentsType(types);

  const wrapperValue: Record<string, unknown> = {
    contents: contentsHash,
    name: appDomain.name ?? "",
    version: appDomain.version ?? "1",
    chainId: appDomain.chainId ?? accountDomain.chainId,
    verifyingContract: appDomain.verifyingContract ?? ethers.ZeroAddress,
    salt: appDomain.salt ?? ethers.ZeroHash,
    extensions: [],
  };

  const outerDigest = ethers.TypedDataEncoder.hash(
    accountDomain,
    TYPED_DATA_SIGN_TYPES,
    wrapperValue
  );

  let signature: string;
  let signerAddress: string;
  try {
    [signature, signerAddress] = await Promise.all([
      signer.signTypedData(accountDomain, TYPED_DATA_SIGN_TYPES, wrapperValue),
      signer.getAddress(),
    ]);
  } catch (err) {
    throw new ProviderError("EIP7739.signWithEIP7739", err);
  }

  return {
    accountDomain,
    contentsHash,
    contentsType,
    outerDigest,
    signature,
    signer: signerAddress,
  };
}

/**
 * Sign a plain message using the EIP-7739 PersonalSign wrapper.
 *
 * Prevents replay of personal_sign messages across different smart accounts
 * by binding the EIP-191 prefixed hash to the account's domain.
 *
 * @param signer        - Wallet signer.
 * @param accountDomain - The smart account's EIP-712 domain.
 * @param message       - The original plaintext message.
 * @returns Personal sign result with prefixedHash and outerDigest.
 * @throws ValidationError if message is empty.
 * @throws ProviderError   if signing fails.
 */
export async function signPersonalWithEIP7739(
  signer: ethers.Wallet,
  accountDomain: EIP7739AccountDomain,
  message: string
): Promise<EIP7739PersonalSignResult> {
  assertNonEmpty("message", message);
  assertNonZeroAddress("accountDomain.verifyingContract", accountDomain.verifyingContract);

  const prefixedHash = ethers.hashMessage(message);
  const wrapperValue = { prefixed: prefixedHash };

  const outerDigest = ethers.TypedDataEncoder.hash(
    accountDomain,
    PERSONAL_SIGN_TYPES,
    wrapperValue
  );

  let signature: string;
  let signerAddress: string;
  try {
    [signature, signerAddress] = await Promise.all([
      signer.signTypedData(accountDomain, PERSONAL_SIGN_TYPES, wrapperValue),
      signer.getAddress(),
    ]);
  } catch (err) {
    throw new ProviderError("EIP7739.signPersonalWithEIP7739", err);
  }

  return { accountDomain, prefixedHash, outerDigest, signature, signer: signerAddress };
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify an EIP-7739 wrapped typed data signature off-chain.
 *
 * Reconstructs the outer TypedDataSign digest and recovers the signer.
 *
 * @param accountDomain  - The smart account's EIP-712 domain.
 * @param appDomain      - The application's EIP-712 domain (inner).
 * @param types          - The inner type definitions.
 * @param value          - The inner typed data value.
 * @param signature      - The EIP-7739 wrapped signature.
 * @param expectedSigner - Expected checksummed signer address.
 * @returns Verify result.
 * @throws ValidationError if expectedSigner is invalid.
 * @throws ProviderError   if ecrecover fails.
 */
export function verifyEIP7739TypedData(
  accountDomain: EIP7739AccountDomain,
  appDomain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, unknown>,
  signature: string,
  expectedSigner: string
): EIP7739VerifyResult {
  assertNonZeroAddress("expectedSigner", expectedSigner);
  assertECDSASignature("signature", signature);

  const contentsHash = computeContentsHash(types, value);
  const wrapperValue: Record<string, unknown> = {
    contents: contentsHash,
    name: appDomain.name ?? "",
    version: appDomain.version ?? "1",
    chainId: appDomain.chainId ?? accountDomain.chainId,
    verifyingContract: appDomain.verifyingContract ?? ethers.ZeroAddress,
    salt: appDomain.salt ?? ethers.ZeroHash,
    extensions: [],
  };

  const outerDigest = ethers.TypedDataEncoder.hash(
    accountDomain,
    TYPED_DATA_SIGN_TYPES,
    wrapperValue
  );

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyTypedData(
      accountDomain,
      TYPED_DATA_SIGN_TYPES,
      wrapperValue,
      signature
    );
  } catch (err) {
    throw new ProviderError("EIP7739.verifyEIP7739TypedData", err);
  }

  return {
    valid: recoveredAddress.toLowerCase() === expectedSigner.toLowerCase(),
    recoveredAddress,
    expectedSigner,
    outerDigest,
  };
}

/**
 * Verify an EIP-7739 PersonalSign wrapped signature off-chain.
 *
 * @param accountDomain  - The smart account's EIP-712 domain.
 * @param message        - The original plaintext message.
 * @param signature      - The EIP-7739 PersonalSign wrapped signature.
 * @param expectedSigner - Expected checksummed signer address.
 * @returns Verify result.
 */
export function verifyEIP7739PersonalSign(
  accountDomain: EIP7739AccountDomain,
  message: string,
  signature: string,
  expectedSigner: string
): EIP7739VerifyResult {
  assertNonEmpty("message", message);
  assertNonZeroAddress("expectedSigner", expectedSigner);
  assertECDSASignature("signature", signature);

  const prefixedHash = ethers.hashMessage(message);
  const wrapperValue = { prefixed: prefixedHash };

  const outerDigest = ethers.TypedDataEncoder.hash(
    accountDomain,
    PERSONAL_SIGN_TYPES,
    wrapperValue
  );

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.verifyTypedData(
      accountDomain,
      PERSONAL_SIGN_TYPES,
      wrapperValue,
      signature
    );
  } catch (err) {
    throw new ProviderError("EIP7739.verifyEIP7739PersonalSign", err);
  }

  return {
    valid: recoveredAddress.toLowerCase() === expectedSigner.toLowerCase(),
    recoveredAddress,
    expectedSigner,
    outerDigest,
  };
}
