/**
 * EIP-6900: Modular Smart Contract Accounts and Plugins — v1.0.0
 *
 * Defines a standard for upgradable, plugin-based smart contract accounts.
 * Plugins extend account functionality by adding:
 * - userOp validation functions
 * - runtime validation functions
 * - execution functions
 * - pre/post execution hooks
 *
 * Security properties:
 * - manifestHash is verified on install to prevent plugin tampering.
 * - Plugin dependencies are declared in the manifest; the account enforces them.
 * - executeBatch atomically executes all calls; a single failure reverts all.
 * - executeFromPlugin is restricted to selectors declared in the manifest.
 * - Always verify the plugin manifest before installing on production accounts.
 *
 * @see https://eips.ethereum.org/EIPS/eip-6900
 */

import { ethers } from "ethers";
import { assertNonZeroAddress, assertBytes32, assertNonEmpty } from "./validate.js";
import { ProviderError, ValidationError } from "./errors.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** ABI for the EIP-6900 IModularAccount interface. */
const IACCOUNT_ABI: string[] = [
  "function installPlugin(address plugin, bytes32 manifestHash, bytes calldata pluginInitData, tuple(address plugin, uint8 functionId)[] calldata dependencies) external",
  "function uninstallPlugin(address plugin, bytes calldata config, bytes calldata pluginUninstallData) external",
  "function execute(address target, uint256 value, bytes calldata data) external payable returns (bytes memory)",
  "function executeBatch(tuple(address target, uint256 value, bytes data)[] calldata calls) external payable returns (bytes[] memory)",
  "function executeFromPlugin(bytes calldata data) external payable returns (bytes memory)",
  "function executeFromPluginExternal(address target, uint256 value, bytes calldata data) external payable returns (bytes memory)",
  "function accountId() external view returns (string memory)",
];

/** ABI for the EIP-6900 IPlugin interface. */
const IPLUGIN_ABI: string[] = [
  "function onInstall(bytes calldata data) external",
  "function onUninstall(bytes calldata data) external",
  "function pluginManifest() external pure returns (tuple(bytes4[] interfaceIds, bytes4[] dependencyInterfaceIds, bytes4[] executionFunctions, bytes4[] permittedExecutionSelectors, bool permitAnyExternalAddress, bool canSpendNativeToken, tuple(address externalAddress, bool permitAnySelector, bytes4[] selectors)[] permittedExternalCalls, tuple(bytes4 selector, tuple(uint8 functionType, uint8 functionId, uint256 dependencyIndex) associatedFunction)[] userOpValidationFunctions, tuple(bytes4 selector, tuple(uint8 functionType, uint8 functionId, uint256 dependencyIndex) associatedFunction)[] runtimeValidationFunctions, tuple(bytes4 selector, tuple(uint8 functionType, uint8 functionId, uint256 dependencyIndex) associatedFunction)[] preUserOpValidationHooks, tuple(bytes4 selector, tuple(uint8 functionType, uint8 functionId, uint256 dependencyIndex) associatedFunction)[] preRuntimeValidationHooks, tuple(bytes4 selector, tuple(uint8 functionType, uint8 functionId, uint256 dependencyIndex) preExecHook, tuple(uint8 functionType, uint8 functionId, uint256 dependencyIndex) postExecHook)[] executionHooks))",
  "function pluginMetadata() external pure returns (tuple(string name, string version, string author, tuple(string functionSignature, string permissionDescription)[] permissionDescriptors))",
];

// ─── Types ───────────────────────────────────────────────────────────────────

/** A plugin dependency reference. */
export interface PluginDependency {
  /** Address of the required dependency plugin. */
  plugin: string;
  /** Function ID within the dependency plugin. */
  functionId: number;
}

/** A single call in a batch execution. */
export interface BatchCall {
  target: string;
  value: bigint;
  data: string;
}

// ─── Contract Accessors ───────────────────────────────────────────────────────

/**
 * Get a reference to an EIP-6900 modular account contract.
 *
 * @param address          - Modular account address.
 * @param signerOrProvider - Signer for state-changing calls, Provider for reads.
 * @returns ethers.Contract bound to IModularAccount ABI.
 */
export function getModularAccount(
  address: string,
  signerOrProvider: ethers.Signer | ethers.Provider
): ethers.Contract {
  assertNonZeroAddress("address", address);
  return new ethers.Contract(address, IACCOUNT_ABI, signerOrProvider);
}

/**
 * Get a reference to an EIP-6900 plugin contract.
 *
 * @param address  - Plugin contract address.
 * @param provider - ethers Provider.
 * @returns ethers.Contract bound to IPlugin ABI.
 */
export function getPlugin(
  address: string,
  provider: ethers.Provider
): ethers.Contract {
  assertNonZeroAddress("address", address);
  return new ethers.Contract(address, IPLUGIN_ABI, provider);
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

/**
 * Compute the manifest hash from ABI-encoded manifest bytes.
 *
 * The account verifies this hash against pluginManifest() during installPlugin()
 * to ensure the plugin on-chain matches what was audited off-chain.
 *
 * @param manifestAbiEncoded - ABI-encoded plugin manifest bytes.
 * @returns keccak256 manifest hash as 0x-prefixed bytes32.
 * @throws ValidationError if manifestAbiEncoded is empty.
 */
export function computeManifestHash(manifestAbiEncoded: string): string {
  assertNonEmpty("manifestAbiEncoded", manifestAbiEncoded);
  if (!/^0x[0-9a-fA-F]+$/.test(manifestAbiEncoded)) {
    throw new ValidationError(
      "manifestAbiEncoded",
      "Must be a 0x-prefixed hex string of the ABI-encoded manifest"
    );
  }
  return ethers.keccak256(ethers.getBytes(manifestAbiEncoded));
}

/**
 * Fetch and decode the plugin manifest from a deployed plugin.
 *
 * @param provider      - ethers Provider.
 * @param pluginAddress - Plugin contract address.
 * @returns Decoded plugin manifest struct.
 * @throws ProviderError if the call fails.
 */
export async function getPluginManifest(
  provider: ethers.Provider,
  pluginAddress: string
): Promise<unknown> {
  assertNonZeroAddress("pluginAddress", pluginAddress);
  const plugin = getPlugin(pluginAddress, provider);
  try {
    return await plugin.pluginManifest();
  } catch (err) {
    throw new ProviderError(`EIP6900.getPluginManifest(${pluginAddress})`, err);
  }
}

/**
 * Fetch plugin metadata (name, version, author, permission descriptors).
 *
 * @param provider      - ethers Provider.
 * @param pluginAddress - Plugin contract address.
 * @returns Plugin metadata struct.
 * @throws ProviderError if the call fails.
 */
export async function getPluginMetadata(
  provider: ethers.Provider,
  pluginAddress: string
): Promise<{ name: string; version: string; author: string }> {
  assertNonZeroAddress("pluginAddress", pluginAddress);
  const plugin = getPlugin(pluginAddress, provider);
  try {
    return await plugin.pluginMetadata();
  } catch (err) {
    throw new ProviderError(`EIP6900.getPluginMetadata(${pluginAddress})`, err);
  }
}

// ─── Plugin Lifecycle ─────────────────────────────────────────────────────────

/**
 * Install a plugin on an EIP-6900 modular account.
 *
 * The manifestHash is verified by the account against pluginManifest() to
 * ensure the installed plugin matches the expected implementation.
 *
 * @param signer         - Account owner or authorized signer.
 * @param accountAddress - The modular account address.
 * @param pluginAddress  - The plugin contract address.
 * @param manifestHash   - keccak256 of the ABI-encoded plugin manifest.
 * @param initData       - Initialization data for onInstall() (default "0x").
 * @param dependencies   - Array of required plugin dependencies.
 * @returns Transaction response.
 * @throws ValidationError if manifestHash is not bytes32.
 * @throws ProviderError   if the transaction fails.
 */
export async function installPlugin(
  signer: ethers.Signer,
  accountAddress: string,
  pluginAddress: string,
  manifestHash: string,
  initData: string = "0x",
  dependencies: PluginDependency[] = []
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("accountAddress", accountAddress);
  assertNonZeroAddress("pluginAddress", pluginAddress);
  assertBytes32("manifestHash", manifestHash);
  dependencies.forEach((d, i) =>
    assertNonZeroAddress(`dependencies[${i}].plugin`, d.plugin)
  );

  const account = getModularAccount(accountAddress, signer);
  try {
    return await account.installPlugin(
      pluginAddress,
      manifestHash,
      initData,
      dependencies
    );
  } catch (err) {
    throw new ProviderError("EIP6900.installPlugin", err);
  }
}

/**
 * Uninstall a plugin from an EIP-6900 modular account.
 *
 * @param signer         - Account owner or authorized signer.
 * @param accountAddress - The modular account address.
 * @param pluginAddress  - The plugin contract address to uninstall.
 * @param config         - Configuration bytes passed to uninstall logic (default "0x").
 * @param uninstallData  - Data for onUninstall() (default "0x").
 * @returns Transaction response.
 * @throws ProviderError if the transaction fails.
 */
export async function uninstallPlugin(
  signer: ethers.Signer,
  accountAddress: string,
  pluginAddress: string,
  config: string = "0x",
  uninstallData: string = "0x"
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("accountAddress", accountAddress);
  assertNonZeroAddress("pluginAddress", pluginAddress);
  const account = getModularAccount(accountAddress, signer);
  try {
    return await account.uninstallPlugin(pluginAddress, config, uninstallData);
  } catch (err) {
    throw new ProviderError("EIP6900.uninstallPlugin", err);
  }
}

// ─── Execution ────────────────────────────────────────────────────────────────

/**
 * Execute a single call through the modular account.
 *
 * @param signer         - Account owner signer.
 * @param accountAddress - Modular account address.
 * @param target         - Destination address.
 * @param value          - ETH value in wei.
 * @param data           - Calldata.
 * @returns Transaction response.
 * @throws ValidationError if target is zero address.
 * @throws ProviderError   if the transaction fails.
 */
export async function executeSingle(
  signer: ethers.Signer,
  accountAddress: string,
  target: string,
  value: bigint,
  data: string
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("accountAddress", accountAddress);
  assertNonZeroAddress("target", target);
  const account = getModularAccount(accountAddress, signer);
  try {
    return await account.execute(target, value, data);
  } catch (err) {
    throw new ProviderError("EIP6900.executeSingle", err);
  }
}

/**
 * Execute a batch of calls atomically through the modular account.
 *
 * A failure in any single call reverts the entire batch.
 *
 * @param signer         - Account owner signer.
 * @param accountAddress - Modular account address.
 * @param calls          - Array of {target, value, data} calls.
 * @returns Transaction response.
 * @throws ValidationError if calls is empty.
 * @throws ProviderError   if the transaction fails.
 */
export async function executeBatch(
  signer: ethers.Signer,
  accountAddress: string,
  calls: BatchCall[]
): Promise<ethers.TransactionResponse> {
  assertNonZeroAddress("accountAddress", accountAddress);
  if (calls.length === 0) {
    throw new ValidationError("calls", "Batch must contain at least one call");
  }
  calls.forEach((c, i) => assertNonZeroAddress(`calls[${i}].target`, c.target));
  const account = getModularAccount(accountAddress, signer);
  try {
    return await account.executeBatch(calls);
  } catch (err) {
    throw new ProviderError("EIP6900.executeBatch", err);
  }
}

/**
 * Fetch the account implementation identifier.
 *
 * @param provider       - ethers Provider.
 * @param accountAddress - Modular account address.
 * @returns Implementation identifier string.
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
    throw new ProviderError("EIP6900.getAccountId", err);
  }
}

/**
 * Encode calldata for a plugin's executeFromPlugin call to the parent account.
 *
 * Plugins use this to trigger execution on behalf of the account for selectors
 * declared as permittedExecutionSelectors in their manifest.
 *
 * @param target - Destination address.
 * @param value  - ETH value in wei.
 * @param data   - Calldata.
 * @returns ABI-encoded execute calldata.
 */
export function encodePluginExecutionData(
  target: string,
  value: bigint,
  data: string
): string {
  assertNonZeroAddress("target", target);
  const iface = new ethers.Interface([
    "function execute(address target, uint256 value, bytes calldata data) external payable returns (bytes memory)",
  ]);
  return iface.encodeFunctionData("execute", [target, value, data]);
}
