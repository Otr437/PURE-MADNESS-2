/**
 * EIP-7579: Minimal Modular Smart Accounts — v1.0.0
 *
 * Standard interfaces for interoperable modular smart account implementations.
 * Defines four module types:
 *   1 — Validator   (validates UserOps and signatures)
 *   2 — Executor    (executes calls on behalf of the account)
 *   3 — Fallback    (handles unknown function selectors)
 *   4 — Hook        (pre/post execution hooks)
 *
 * Execution modes are encoded as bytes32 with a defined layout:
 *   [0]    callType  (0x00 = single, 0x01 = batch, 0xfe = static, 0xff = delegate)
 *   [1]    execType  (0x00 = revert on failure, 0x01 = try-mode)
 *   [2-3]  unused
 *   [4-35] mode-specific data
 *
 * @see https://eips.ethereum.org/EIPS/eip-7579
 */

import { ethers } from "ethers";
import {
  assertNonZeroAddress,
  assertBigIntRange,
} from "./validate.js";
import { ProviderError, ValidationError } from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Module type identifier for validator modules. */
export const MODULE_TYPE_VALIDATOR = BigInt(1);
/** Module type identifier for executor modules. */
export const MODULE_TYPE_EXECUTOR = BigInt(2);
/** Module type identifier for fallback modules. */
export const MODULE_TYPE_FALLBACK = BigInt(3);
/** Module type identifier for hook modules. */
export const MODULE_TYPE_HOOK = BigInt(4);

/** Maximum valid module type ID. */
const MAX_MODULE_TYPE = BigInt(4);

/**
 * Execution mode: single call, revert on failure.
 * callType=0x00, execType=0x00
 */
export const EXEC_MODE_SINGLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Execution mode: batch calls, revert on any failure.
 * callType=0x01, execType=0x00
 */
export const EXEC_MODE_BATCH =
  "0x0100000000000000000000000000000000000000000000000000000000000000";

/**
 * Execution mode: single call, try-mode (continue on failure).
 * callType=0x00, execType=0x01
 */
export const EXEC_MODE_SINGLE_TRY =
  "0x0000000100000000000000000000000000000000000000000000000000000000";

/**
 * Execution mode: batch calls, try-mode (continue on individual failures).
 * callType=0x01, execType=0x01
 */
export const EXEC_MODE_BATCH_TRY =
  "0x0100000100000000000000000000000000000000000000000000000000000000";

/** EIP-1271 magic value for a valid signature (from validator modules). */
export const SIG_VALIDATION_SUCCESS = "0x1626ba7e";
/** Validation failure return value from validator modules. */
export const SIG_VALIDATION_FAILED = "0xffffffff";

/** ABI for the EIP-7579 IMSA (Modular Smart Account) interface. */
const IMSA_ABI: string[] = [
  "function execute(bytes32 mode, bytes calldata executionCalldata) external payable",
  "function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata) external payable returns (bytes[] memory returnData)",
  "function accountId() external view returns (string memory accountImplementationId)",
  "function supportsExecutionMode(bytes32 encodedMode) external view returns (bool)",
  "function supportsModule(uint256 moduleTypeId) external view returns (bool)",
  "function installModule(uint256 moduleTypeId, address module, bytes calldata initData) external payable",
  "function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData) external payable",
  "function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext) external view returns (bool)",
];

/** ABI for the EIP-7579 IValidator module interface. */
const IVALIDATOR_ABI: string[] = [
  "function validateUserOp(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp, bytes32 userOpHash) external returns (uint256 validationData)",
  "function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata signature) external view returns (bytes4 sigValidationResult)",
  "function onInstall(bytes calldata data) external",
  "function onUninstall(bytes calldata data) external",
  "function isModuleType(uint256 moduleTypeId) external view returns (bool)",
];

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single execution unit. */
export interface EIP7579Execution {
  target: string;
  value: bigint;
  callData: string;
}

/** Decoded execution mode fields. */
export interface DecodedExecMode {
  /** 0x00 single | 0x01 batch | 0xfe static | 0xff delegate */
  callType: number;
  /** 0x00 revert-on-fail | 0x01 try-mode */
  execType: number;
  /** Remaining 30 bytes of mode data. */
  modeData: string;
}

// ─── Contract Accessors ───────────────────────────────────────────────────────

/**
 * Get an EIP-7579 IMSA contract instance.
 *
 * @param address            - Smart account address.
 * @param signerOrProvider   - Signer for state-changing calls or Provider for reads.
 * @returns ethers.Contract bound to the IMSA ABI.
 */
export function getModularAccount(
  address: string,
  signerOrProvider: ethers.Signer | ethers.Provider
): ethers.Contract {
  assertNonZeroAddress("address", address);
  return new ethers.Contract(address, IMSA_ABI, signerOrProvider);
}

/**
 * Get an EIP-7579 IValidator module contract instance.
 *
 * @param address          - Validator module address.
 * @param signerOrProvider - Signer or Provider.
 * @returns ethers.Contract bound to the IValidator ABI.
 */
export function getValidatorModule(
  address: string,
  signerOrProvider: ethers.Signer | ethers.Provider
): ethers.Contract {
  assertNonZeroAddress("address", address);
  return new ethers.Contract(address, IVALIDATOR_ABI, signerOrProvider);
}

// ─── callData Encoders ────────────────────────────────────────────────────────

/**
 * Encode a single execution for use as executionCalldata in execute().
 *
 * Format: abi.encode(target, value, callData)
 *
 * @param exec - Execution parameters.
 * @returns ABI-encoded bytes.
 * @throws ValidationError if target is zero address.
 */
export function encodeSingleExecution(exec: EIP7579Execution): string {
  assertNonZeroAddress("exec.target", exec.target);
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "bytes"],
    [exec.target, exec.value, exec.callData]
  );
}

/**
 * Encode a batch of executions for use as executionCalldata in execute().
 *
 * Format: abi.encode(tuple(address,uint256,bytes)[])
 *
 * @param execs - Array of execution parameters.
 * @returns ABI-encoded bytes.
 * @throws ValidationError if execs is empty.
 */
export function encodeBatchExecution(execs: EIP7579Execution[]): string {
  if (execs.length === 0) {
    throw new ValidationError("execs", "Batch must contain at least one execution");
  }
  execs.forEach((e, i) => assertNonZeroAddress(`execs[${i}].target`, e.target));
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(address target, uint256 value, bytes callData)[]"],
    [execs]
  );
}

// ─── Execution Mode Utilities ─────────────────────────────────────────────────

/**
 * Decode an execution mode bytes32 into its constituent fields.
 *
 * @param mode - 0x-prefixed 32-byte execution mode.
 * @returns Decoded mode fields.
 */
export function decodeExecMode(mode: string): DecodedExecMode {
  if (!/^0x[0-9a-fA-F]{64}$/.test(mode)) {
    throw new ValidationError("mode", "Must be a 0x-prefixed 32-byte hex string");
  }
  const bytes = ethers.getBytes(mode);
  return {
    callType: bytes[0],
    execType: bytes[1],
    modeData: ethers.hexlify(bytes.slice(2)),
  };
}

/**
 * Encode custom execution mode bytes from callType and execType.
 *
 * @param callType - Call type byte (0x00 single, 0x01 batch, 0xfe static, 0xff delegate).
 * @param execType - Execution type byte (0x00 revert, 0x01 try).
 * @param modeData - Optional 30-byte mode-specific data (default: all zeros).
 * @returns 0x-prefixed 32-byte execution mode.
 */
export function encodeExecMode(
  callType: number,
  execType: number,
  modeData?: string
): string {
  if (callType < 0 || callType > 0xff) {
    throw new ValidationError("callType", "Must be a single byte (0–255)");
  }
  if (execType < 0 || execType > 0xff) {
    throw new ValidationError("execType", "Must be a single byte (0–255)");
  }
  const prefix = new Uint8Array([callType, execType, 0x00, 0x00]);
  const data = modeData
    ? ethers.getBytes(modeData).slice(0, 28)
    : new Uint8Array(28);
  return ethers.hexlify(ethers.concat([prefix, data]));
}

// ─── Module Management ────────────────────────────────────────────────────────

/**
 * Check whether the account supports a given execution mode.
 *
 * @param provider       - ethers Provider.
 * @param accountAddress - Smart account address.
 * @param mode           - Execution mode bytes32.
 * @returns true if the mode is supported.
 * @throws ProviderError if the call fails.
 */
export async function supportsExecutionMode(
  provider: ethers.Provider,
  accountAddress: string,
  mode: string
): Promise<boolean> {
  assertNonZeroAddress("accountAddress", accountAddress);
  const account = getModularAccount(accountAddress, provider);
  try {
    return await account.supportsExecutionMode(mode);
  } catch (err) {
    throw new ProviderError("EIP7579.supportsExecutionMode", err);
  }
}

/**
 * Check whether the account supports a given module type.
 *
 * @param provider       - ethers Provider.
 * @param accountAddress - Smart account address.
 * @param moduleTypeId   - Module type ID (1–4).
 * @returns true if the module type is supported.
 * @throws ValidationError if moduleTypeId is out of range.
 * @throws ProviderError   if the call fails.
 */
export async function supportsModuleType(
  provider: ethers.Provider,
  accountAddress: string,
  moduleTypeId: bigint
): Promise<boolean> {
  assertNonZeroAddress("accountAddress", accountAddress);
  assertBigIntRange("moduleTypeId", moduleTypeId, BigInt(1), MAX_MODULE_TYPE);
  const account = getModularAccount(accountAddress, provider);
  try {
    return await account.supportsModule(moduleTypeId);
  } catch (err) {
    throw new ProviderError("EIP7579.supportsModuleType", err);
  }
}

/**
 * Check whether a specific module is installed on the account.
 *
 * @param provider          - ethers Provider.
 * @param accountAddress    - Smart account address.
 * @param moduleTypeId      - Module type ID (1–4).
 * @param moduleAddress     - Module contract address.
 * @param additionalContext - Optional context bytes (default "0x").
 * @returns true if the module is installed.
 * @throws ProviderError if the call fails.
 */
export async function isModuleInstalled(
  provider: ethers.Provider,
  accountAddress: string,
  moduleTypeId: bigint,
  moduleAddress: string,
  additionalContext: string = "0x"
): Promise<boolean> {
  assertNonZeroAddress("accountAddress", accountAddress);
  assertNonZeroAddress("moduleAddress", moduleAddress);
  assertBigIntRange("moduleTypeId", moduleTypeId, BigInt(1), MAX_MODULE_TYPE);
  const account = getModularAccount(accountAddress, provider);
  try {
    return await account.isModuleInstalled(moduleTypeId, moduleAddress, additionalContext);
  } catch (err) {
    throw new ProviderError("EIP7579.isModuleInstalled", err);
  }
}

/**
 * Install a module on a modular account.
 *
 * @param signer         - Account owner signer.
 * @param accountAddress - Smart account address.
 * @param moduleTypeId   - Module type ID (1–4).
 * @param moduleAddress  - Module contract address.
 * @param initData       - Initialization data for onInstall() (default "0x").
 * @returns Transaction response.
 * @throws ValidationError if moduleTypeId is out of range.
 * @throws ProviderError   if the transaction fails.
 */
export async function installModule(
  signer: ethers.Signer,
  accountAddress: string,
  moduleTypeId: bigint,
  moduleAddress: string,
  initData: string = "0x"
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("accountAddress", accountAddress);
  assertNonZeroAddress("moduleAddress", moduleAddress);
  assertBigIntRange("moduleTypeId", moduleTypeId, BigInt(1), MAX_MODULE_TYPE);
  const account = getModularAccount(accountAddress, signer);
  try {
    return await account.installModule(moduleTypeId, moduleAddress, initData);
  } catch (err) {
    throw new ProviderError("EIP7579.installModule", err);
  }
}

/**
 * Uninstall a module from a modular account.
 *
 * @param signer         - Account owner signer.
 * @param accountAddress - Smart account address.
 * @param moduleTypeId   - Module type ID (1–4).
 * @param moduleAddress  - Module contract address.
 * @param deInitData     - De-initialization data for onUninstall() (default "0x").
 * @returns Transaction response.
 * @throws ProviderError if the transaction fails.
 */
export async function uninstallModule(
  signer: ethers.Signer,
  accountAddress: string,
  moduleTypeId: bigint,
  moduleAddress: string,
  deInitData: string = "0x"
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("accountAddress", accountAddress);
  assertNonZeroAddress("moduleAddress", moduleAddress);
  assertBigIntRange("moduleTypeId", moduleTypeId, BigInt(1), MAX_MODULE_TYPE);
  const account = getModularAccount(accountAddress, signer);
  try {
    return await account.uninstallModule(moduleTypeId, moduleAddress, deInitData);
  } catch (err) {
    throw new ProviderError("EIP7579.uninstallModule", err);
  }
}

// ─── Execution ────────────────────────────────────────────────────────────────

/**
 * Execute a single call through a modular account.
 *
 * @param signer         - Account owner or executor signer.
 * @param accountAddress - Smart account address.
 * @param execution      - The call to execute.
 * @param tryMode        - If true, uses try-mode (does not revert on failure).
 * @returns Transaction response.
 * @throws ProviderError if the transaction fails.
 */
export async function executeSingle(
  signer: ethers.Signer,
  accountAddress: string,
  execution: EIP7579Execution,
  tryMode: boolean = false
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("accountAddress", accountAddress);
  const mode = tryMode ? EXEC_MODE_SINGLE_TRY : EXEC_MODE_SINGLE;
  const calldata = encodeSingleExecution(execution);
  const account = getModularAccount(accountAddress, signer);
  try {
    return await account.execute(mode, calldata);
  } catch (err) {
    throw new ProviderError("EIP7579.executeSingle", err);
  }
}

/**
 * Execute a batch of calls through a modular account.
 *
 * @param signer         - Account owner or executor signer.
 * @param accountAddress - Smart account address.
 * @param executions     - Array of calls to execute.
 * @param tryMode        - If true, uses try-mode (continues on individual failures).
 * @returns Transaction response.
 * @throws ValidationError if executions is empty.
 * @throws ProviderError   if the transaction fails.
 */
export async function executeBatch(
  signer: ethers.Signer,
  accountAddress: string,
  executions: EIP7579Execution[],
  tryMode: boolean = false
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("accountAddress", accountAddress);
  if (executions.length === 0) {
    throw new ValidationError("executions", "Batch must contain at least one execution");
  }
  const mode = tryMode ? EXEC_MODE_BATCH_TRY : EXEC_MODE_BATCH;
  const calldata = encodeBatchExecution(executions);
  const account = getModularAccount(accountAddress, signer);
  try {
    return await account.execute(mode, calldata);
  } catch (err) {
    throw new ProviderError("EIP7579.executeBatch", err);
  }
}

/**
 * Fetch the account implementation ID string.
 *
 * Format: "vendor.accountName.semver" (e.g. "rhinestone.safe7579.v1.0.0")
 *
 * @param provider       - ethers Provider.
 * @param accountAddress - Smart account address.
 * @returns Account implementation identifier string.
 * @throws ProviderError if the call fails.
 */
export async function getAccountId(
  provider: ethers.Provider,
  accountAddress: string
): Promise<string> {
  assertNonZeroAddress("accountAddress", accountAddress);
  const account = getModularAccount(accountAddress, provider);
  try {
    return await account.accountId();
  } catch (err) {
    throw new ProviderError("EIP7579.getAccountId", err);
  }
}
