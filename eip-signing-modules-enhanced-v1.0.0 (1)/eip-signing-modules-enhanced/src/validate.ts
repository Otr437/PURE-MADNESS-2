/**
 * Shared validation utilities used across all EIP modules.
 * All validators throw typed errors from errors.ts — never bare Error strings.
 */

import { ethers } from "ethers";
import {
  ValidationError,
  InvalidAddressError,
  InvalidHexError,
  SignatureError,
} from "./errors.js";

/**
 * Assert that a value is a valid checksummed Ethereum address.
 * Throws InvalidAddressError on failure.
 */
export function assertAddress(field: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidAddressError(field, value);
  }
  try {
    ethers.getAddress(value);
  } catch {
    throw new InvalidAddressError(field, value);
  }
}

/**
 * Assert that a value is not the zero address (0x000...000).
 * Throws ValidationError on failure.
 */
export function assertNonZeroAddress(field: string, value: string): void {
  assertAddress(field, value);
  if (value.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    throw new ValidationError(field, "Address must not be the zero address");
  }
}

/**
 * Assert that a value is a valid 0x-prefixed hex string.
 * If byteLength is supplied, also checks exact byte count.
 */
export function assertHex(
  field: string,
  value: string,
  byteLength?: number
): void {
  if (typeof value !== "string") {
    throw new InvalidHexError(field, String(value), byteLength);
  }
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new InvalidHexError(field, value, byteLength);
  }
  if (byteLength !== undefined) {
    const actualBytes = (value.length - 2) / 2;
    if (actualBytes !== byteLength) {
      throw new InvalidHexError(field, value, byteLength);
    }
  }
}

/**
 * Assert that a value is a valid bytes32 hex string (0x + 64 hex chars).
 */
export function assertBytes32(field: string, value: string): void {
  assertHex(field, value, 32);
}

/**
 * Assert that a bigint is >= 0 and <= maxValue (inclusive).
 */
export function assertBigIntRange(
  field: string,
  value: bigint,
  min: bigint,
  max: bigint
): void {
  if (typeof value !== "bigint") {
    throw new ValidationError(field, `Expected bigint, got ${typeof value}`);
  }
  if (value < min || value > max) {
    throw new ValidationError(
      field,
      `Value ${value} out of range [${min}, ${max}]`
    );
  }
}

/**
 * Assert that a bigint is strictly positive (> 0).
 */
export function assertPositiveBigInt(field: string, value: bigint): void {
  if (typeof value !== "bigint" || value <= BigInt(0)) {
    throw new ValidationError(field, `Value must be a positive bigint, got ${value}`);
  }
}

/**
 * Assert that a signature string is structurally valid:
 * - 0x-prefixed
 * - 65 bytes (130 hex chars) for ECDSA compact form, or longer for EIP-6492 wrapped
 * - v byte in {27, 28} or {0, 1} for compact
 */
export function assertECDSASignature(field: string, signature: string): void {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new SignatureError(`[${field}] Signature must be a 0x-prefixed hex string`);
  }
  const bytes = (signature.length - 2) / 2;
  if (bytes < 65) {
    throw new SignatureError(
      `[${field}] ECDSA signature must be at least 65 bytes, got ${bytes}`
    );
  }
}

/**
 * Assert that a deadline (unix timestamp bigint) has not expired.
 * Throws DeadlineExpiredError from errors.ts if expired.
 * Imported lazily to avoid circular dependency.
 */
export function assertDeadlineNotExpired(
  field: string,
  deadline: bigint
): void {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now) {
    throw new ValidationError(
      field,
      `Deadline ${deadline} has already passed (current unix time: ${now})`
    );
  }
}

/**
 * Assert that a chainId is a valid positive integer.
 */
export function assertChainId(field: string, chainId: number | bigint): void {
  const val = typeof chainId === "bigint" ? chainId : BigInt(chainId);
  if (val <= BigInt(0)) {
    throw new ValidationError(field, `chainId must be positive, got ${val}`);
  }
}

/**
 * Assert that a string is non-empty.
 */
export function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(field, "Value must be a non-empty string");
  }
}

/**
 * Assert that an array is non-empty.
 */
export function assertNonEmptyArray(field: string, arr: unknown[]): void {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new ValidationError(field, "Array must not be empty");
  }
}

/**
 * Assert that two arrays have the same length.
 */
export function assertSameLength(
  field: string,
  a: unknown[],
  b: unknown[],
  labelA = "first array",
  labelB = "second array"
): void {
  if (a.length !== b.length) {
    throw new ValidationError(
      field,
      `${labelA} (length ${a.length}) and ${labelB} (length ${b.length}) must have the same length`
    );
  }
}
