/**
 * Typed error hierarchy for eip-signing-modules.
 * Every thrown error is an instance of a named class — never a bare Error string.
 * Callers can instanceof-check to distinguish error categories without string parsing.
 */

/** Base class for all eip-signing-modules errors. */
export class EIPSigningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EIPSigningError";
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }
}

/** Thrown when a function argument fails validation (type, range, format). */
export class ValidationError extends EIPSigningError {
  readonly field: string;
  constructor(field: string, reason: string) {
    super("VALIDATION_ERROR", `[${field}] ${reason}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

/** Thrown when a provider or contract call fails. */
export class ProviderError extends EIPSigningError {
  readonly originalCause: unknown;
  constructor(operation: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super("PROVIDER_ERROR", `${operation} failed: ${msg}`);
    this.name = "ProviderError";
    this.originalCause = cause;
  }
}

/** Thrown when a signature is structurally invalid (wrong length, wrong format). */
export class SignatureError extends EIPSigningError {
  constructor(reason: string) {
    super("SIGNATURE_ERROR", reason);
    this.name = "SignatureError";
  }
}

/** Thrown when a recovered signer does not match the expected address. */
export class SignerMismatchError extends EIPSigningError {
  readonly expected: string;
  readonly recovered: string;
  constructor(expected: string, recovered: string) {
    super(
      "SIGNER_MISMATCH",
      `Expected signer ${expected}, recovered ${recovered}`
    );
    this.name = "SignerMismatchError";
    this.expected = expected;
    this.recovered = recovered;
  }
}

/** Thrown when an EIP-1271 magic value check fails. */
export class ContractSignatureError extends EIPSigningError {
  readonly magicValue: string;
  constructor(contractAddress: string, magicValue: string) {
    super(
      "CONTRACT_SIGNATURE_INVALID",
      `EIP-1271 isValidSignature on ${contractAddress} returned ${magicValue}, expected 0x1626ba7e`
    );
    this.name = "ContractSignatureError";
    this.magicValue = magicValue;
  }
}

/** Thrown when a permit or authorization has expired. */
export class DeadlineExpiredError extends EIPSigningError {
  readonly deadline: bigint;
  readonly now: bigint;
  constructor(deadline: bigint, now: bigint) {
    super(
      "DEADLINE_EXPIRED",
      `Deadline ${deadline} has passed (current time: ${now})`
    );
    this.name = "DeadlineExpiredError";
    this.deadline = deadline;
    this.now = now;
  }
}

/** Thrown when a signing scheme adapter is not registered in EIP-8141. */
export class UnknownSchemeError extends EIPSigningError {
  readonly schemeId: number;
  constructor(schemeId: number) {
    super(
      "UNKNOWN_SCHEME",
      `No signing scheme adapter registered for scheme 0x${schemeId.toString(16)}. Register one via SigningSchemeRegistry.register().`
    );
    this.name = "UnknownSchemeError";
    this.schemeId = schemeId;
  }
}

/** Thrown when an EIP-6492 magic suffix is absent but expected. */
export class NotEIP6492Error extends EIPSigningError {
  constructor() {
    super("NOT_EIP6492", "Signature does not carry the EIP-6492 magic suffix (0x6492...6492)");
    this.name = "NotEIP6492Error";
  }
}

/** Thrown when an address fails checksum or format validation. */
export class InvalidAddressError extends EIPSigningError {
  readonly address: string;
  constructor(field: string, address: string) {
    super("INVALID_ADDRESS", `[${field}] "${address}" is not a valid checksummed Ethereum address`);
    this.name = "InvalidAddressError";
    this.address = address;
  }
}

/** Thrown when a bytes32 / hex string fails format validation. */
export class InvalidHexError extends EIPSigningError {
  readonly value: string;
  constructor(field: string, value: string, expectedBytes?: number) {
    const suffix = expectedBytes ? ` (expected ${expectedBytes}-byte hex)` : "";
    super("INVALID_HEX", `[${field}] "${value}" is not valid hex${suffix}`);
    this.name = "InvalidHexError";
    this.value = value;
  }
}
