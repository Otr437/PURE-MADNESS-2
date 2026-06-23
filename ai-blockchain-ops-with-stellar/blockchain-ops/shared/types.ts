// ============================================================
// SHARED TYPES — AI Blockchain Operations System
// All modules import from here. Single source of truth.
// ============================================================

// ── Module 1 ──────────────────────────────────────────────────
export interface RelevanceRequest {
  content: string;
  contentType: 'code' | 'package' | 'prompt' | 'audit' | 'output' | 'solidity' | 'transaction';
  submittedAt: string;
  submittedBy: 'orchestrator' | 'auditor' | 'human' | 'mcp' | 'blockchain';
  taskId?: string;
  userId?: string;
  metadata?: Record<string, string>;
}
export interface RelevanceResult {
  approved: boolean;
  score: number;
  reason: string;
  flaggedIssues: string[];
  checkedAt: string;
  relevanceDate: string;
}

// ── Module 2 ──────────────────────────────────────────────────
export interface AuditRequest {
  content: string;
  contentType: 'code' | 'output' | 'recommendation' | 'solidity';
  auditDate: string;
  taskId: string;
  userId?: string;
}
export interface AuditResult {
  taskId: string;
  passed: boolean;
  auditedAt: string;
  auditDate: string;
  findings: AuditFinding[];
  recommendation: 'approve' | 'reject' | 'revise';
  summary: string;
}
export interface AuditFinding {
  severity: 'info' | 'warning' | 'critical';
  category: 'deprecated_package' | 'security' | 'relevance' | 'quality' | 'solidity_vulnerability';
  description: string;
  location?: string;
}

// ── Module 3 ──────────────────────────────────────────────────
export interface OrchestratorTask {
  taskId: string;
  instruction: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  requestedBy: 'human';
  requiresAudit: boolean;
  userId?: string;
  webhookUrl?: string;
  useMcp?: boolean;
  chainId?: number;
  walletAddress?: string;
}
export interface OrchestratorResult {
  taskId: string;
  status: 'completed' | 'failed' | 'rejected_by_gate' | 'rejected_by_audit';
  output: string;
  relevanceCheck?: RelevanceResult;
  auditResult?: AuditResult;
  completedAt: string;
  error?: string;
  durationMs?: number;
  userId?: string;
  relevanceScore?: number; // convenience field from relevanceCheck.score
  novaFallback?: boolean;  // true if Nova handled this task instead of Claude
}
export interface TaskHistoryEntry {
  taskId: string;
  instruction: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'completed' | 'failed' | 'rejected_by_gate' | 'rejected_by_audit';
  createdAt: string;
  completedAt: string;
  durationMs: number;
  relevanceScore: number;
  auditPassed?: boolean;
  auditRecommendation?: 'approve' | 'reject' | 'revise';
  userId?: string;
}

// ── Module 4 ──────────────────────────────────────────────────
export interface GatewayRequest {
  instruction: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  requiresAudit?: boolean;
  webhookUrl?: string;
  useMcp?: boolean;
  chainId?: number;
  walletAddress?: string;
}
export interface GatewayResponse {
  taskId: string;
  status: 'completed' | 'failed' | 'rejected_by_gate' | 'rejected_by_audit';
  output: string;
  relevanceCheck: RelevanceResult;
  auditResult?: AuditResult;
  completedAt: string;
  error?: string;
  durationMs?: number;
}

// ── Module 5: MCP ─────────────────────────────────────────────
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface McpToolCall {
  callId: string;
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  calledAt: string;
  completedAt?: string;
  durationMs?: number;
}
export interface McpCallRequest {
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
}
export interface McpCallResult {
  callId: string;
  success: boolean;
  output: string;
  durationMs: number;
  outputBytes?: number;
}

// ── Module 7: Auth ────────────────────────────────────────────
export type OAuthScope =
  | 'tasks:read' | 'tasks:write' | 'tasks:admin'
  | 'audit:read' | 'gate:read' | 'gate:admin'
  | 'mcp:use' | 'events:read' | 'admin:full' | 'admin'
  | 'blockchain:read' | 'blockchain:write' | 'blockchain:deploy' | 'blockchain:sign'
  | 'stellar:read' | 'stellar:write' | 'stellar:deploy' | 'stellar:sign' | 'stellar:clawback';

export interface AuthUser {
  userId: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'operator' | 'viewer';
  isActive: boolean;
  createdAt: string;
  lastLoginAt?: string;
}
export interface OAuthClient {
  clientId: string;
  clientSecretHash: string;
  name: string;
  scopes: OAuthScope[];
  redirectUris: string[];
  grantTypes: ('authorization_code' | 'client_credentials' | 'refresh_token')[];
  createdAt: string;
  isActive: boolean;
}
export interface OAuthToken {
  tokenId: string;
  accessTokenHash: string;
  refreshTokenHash?: string;
  clientId: string;
  userId?: string;
  scopes: OAuthScope[];
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}
export interface TokenIntrospectResult {
  active: boolean;
  clientId?: string;
  userId?: string;
  scopes?: OAuthScope[];
  expiresAt?: string;
  role?: string;
}

// ── Module 8: Secrets ─────────────────────────────────────────
export interface SecretRecord {
  secretId: string;
  name: string;
  encryptedValue: string;
  version: number;
  createdAt: string;
  rotatedAt: string;
  expiresAt?: string;
  service: string;
}
export interface SecretRotationLog {
  logId: string;
  secretId: string;
  secretName: string;
  oldVersion: number;
  newVersion: number;
  rotatedAt: string;
  rotatedBy: string;
}

// ── Module 9: Events ──────────────────────────────────────────
export type SystemEventType =
  | 'task.created' | 'task.completed' | 'task.failed'
  | 'task.rejected_by_gate' | 'task.rejected_by_audit'
  | 'gate.circuit_opened' | 'gate.circuit_closed' | 'gate.rejected'
  | 'auth.token_issued' | 'auth.token_revoked' | 'auth.login_failed'
  | 'auth.user_registered' | 'auth.password_changed' | 'auth.account_locked' | 'auth.lockout_cleared'
  | 'secret.created' | 'secret.updated' | 'secret.rotated' | 'secret.deleted'
  | 'secret.expiring_soon' | 'secret.expired' | 'secrets.master_key_rotated'
  | 'secret.integrity_violation'
  | 'system.degraded' | 'system.recovered'
  | 'mcp.tool_called' | 'mcp.tool_failed'
  | 'blockchain.tx_submitted' | 'blockchain.tx_confirmed' | 'blockchain.tx_failed'
  | 'blockchain.tx_reverted' | 'blockchain.tx_replaced' | 'blockchain.tx_cancelled'
  | 'blockchain.contract_deployed' | 'blockchain.contract_verified'
  | 'blockchain.gas_spike' | 'blockchain.gas_spike_blocked'
  | 'blockchain.wallet_connected' | 'blockchain.simulation_passed' | 'blockchain.simulation_failed'
  | 'nova.fallback_activated' | 'nova.call_complete' | 'nova.mode_changed'
  | 'voice.generated' | 'voice.alert_generated'
  | 'stellar.tx_confirmed' | 'stellar.tx_failed' | 'stellar.tx_submitted'
  | 'stellar.asset_issued' | 'stellar.clawback_executed'
  | 'stellar.contract_deployed' | 'stellar.contract_invoked'
  | 'stellar.multisig_configured' | 'stellar.account_created'
  | 'admin.user_deactivated' | 'admin.user_activated'
  | 'webhook.subscription_disabled';

export interface SystemEvent {
  eventId: string;
  type: string; // SystemEventType or any custom event type
  source: string;
  payload: Record<string, unknown>;
  emittedAt: string;
  taskId?: string;
  userId?: string;
}
export interface WebhookSubscription {
  subscriptionId: string;
  targetUrl: string;
  events: SystemEventType[];
  secret: string;
  createdAt: string;
  isActive: boolean;
  lastDeliveredAt?: string;
  failureCount: number;
}
export interface WebhookDelivery {
  deliveryId: string;
  subscriptionId: string;
  eventId: string;
  targetUrl: string;
  statusCode?: number;
  success: boolean;
  attemptedAt: string;
  responseMs?: number;
  error?: string;
}

// ── Module 11: Blockchain Engine ──────────────────────────────

export type SupportedChain =
  | 'ethereum' | 'base' | 'arbitrum' | 'optimism' | 'polygon'
  | 'bsc' | 'avalanche' | 'localhost' | 'sepolia' | 'base-sepolia'
  | 'stellar-mainnet' | 'stellar-testnet' | 'stellar-futurenet';

// ── Module 15: Stellar Engine ─────────────────────────────────

export type StellarNetworkName = 'mainnet' | 'testnet' | 'futurenet';

export interface StellarNetworkConfig {
  name: StellarNetworkName;
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  explorerUrl: string;
  isTestnet: boolean;
}

export interface StellarPaymentRequest {
  taskId: string;
  network: StellarNetworkName;
  destination: string;
  amount: string;
  asset: { code: string; issuer?: string };
  memo?: string;
  simulate?: boolean;
}

export interface StellarTxResult {
  taskId: string;
  network: StellarNetworkName;
  txHash?: string;
  status: 'simulated' | 'submitted' | 'confirmed' | 'failed';
  ledger?: number;
  feeCharged?: string;
  resultXdr?: string;
  explorerUrl?: string;
  submittedAt: string;
  confirmedAt?: string;
  error?: string;
}

export interface StellarContractRecord {
  contractId: string;
  name: string;
  network: StellarNetworkName;
  deployedAt: string;
  taskId?: string;
  wasmHash?: string;
}

export interface StellarAssetIssuanceRequest {
  taskId: string;
  network: StellarNetworkName;
  assetCode: string;
  issuerSecretKey: string;
  distributorSecretKey: string;
  amount: string;
  clawbackEnabled?: boolean;
  authorizationRequired?: boolean;
  authorizationRevocable?: boolean;
  homeDomain?: string;
}

export interface StellarKeyPair {
  publicKey: string;
  secretKey: string;
  warning: string;
}

export interface ChainConfig {
  chainId: number;
  name: SupportedChain;
  rpcUrl: string;
  explorerUrl: string;
  explorerApiUrl?: string;
  nativeCurrency: { symbol: string; decimals: number };
  isTestnet: boolean;
}

export interface GasEstimate {
  chainId: number;
  baseFeeGwei: string;
  maxPriorityFeeGwei: string;
  maxFeeGwei: string;
  estimatedCostEth: string;
  estimatedCostUsd?: string;
  confidence: 'low' | 'medium' | 'high';
  fetchedAt: string;
}

export interface WalletInfo {
  address: string;
  chainId: number;
  balanceEth: string;
  balanceWei: string;
  nonce: number;
  connectedAt: string;
  source: 'local_keystore' | 'private_key_env' | 'hardware' | 'injected';
}

export interface TransactionRequest {
  taskId: string;
  chainId: number;
  from: string;
  to?: string;
  value?: string;        // in wei (hex or decimal string)
  data?: string;         // hex encoded calldata
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: number;
  description: string;
  simulate?: boolean;
}

export interface TransactionResult {
  taskId: string;
  txHash?: string;
  status: 'simulated' | 'submitted' | 'confirmed' | 'failed' | 'reverted';
  blockNumber?: number;
  gasUsed?: string;
  effectiveGasPrice?: string;
  error?: string;
  simulationPassed?: boolean;
  simulationTrace?: string;
  submittedAt: string;
  confirmedAt?: string;
  explorerUrl?: string;
}

export interface CompileRequest {
  taskId: string;
  source: string;           // Solidity source code
  contractName: string;
  solidityVersion?: string; // e.g. "0.8.24"
  optimizer?: { enabled: boolean; runs: number };
  evmVersion?: string;
}

export interface CompileResult {
  taskId: string;
  success: boolean;
  contractName: string;
  abi?: unknown[];
  bytecode?: string;
  deployedBytecode?: string;
  errors?: string[];
  warnings?: string[];
  metadata?: string;
  compiledAt: string;
}

export interface DeployRequest {
  taskId: string;
  chainId: number;
  from: string;
  contractName: string;
  abi: unknown[];
  bytecode: string;
  constructorArgs?: unknown[];
  value?: string;
  gasLimit?: string;
  verify?: boolean;
  explorerApiKey?: string;
}

export interface DeployResult {
  taskId: string;
  success: boolean;
  contractAddress?: string;
  txHash?: string;
  blockNumber?: number;
  gasUsed?: string;
  abi?: unknown[];
  verified?: boolean;
  error?: string;
  deployedAt: string;
  explorerUrl?: string;
}

export interface ContractRecord {
  contractId: string;
  name: string;
  address: string;
  chainId: number;
  abi: unknown[];
  bytecode?: string;
  txHash?: string;
  deployedBy?: string;
  verified: boolean;
  deployedAt: string;
  taskId?: string;
}

export interface MemeTokenConfig {
  name: string;
  symbol: string;
  totalSupply: string;        // human-readable e.g. "1000000000"
  decimals: number;
  mintable: boolean;
  burnable: boolean;
  taxBuyPercent?: number;     // 0-25
  taxSellPercent?: number;    // 0-25
  taxWallet?: string;
  maxWalletPercent?: number;  // % of supply per wallet
  maxTxPercent?: number;      // % of supply per tx
  addLiquidity?: {
    dexRouter: string;        // router address
    ethAmount: string;        // ETH to pair with
    tokenPercent: number;     // % of supply for LP
    lockLpDays?: number;
  };
}

// ── Module 10: Admin ──────────────────────────────────────────
export interface AdminSystemStats {
  date: string;
  tasks: {
    total: number;
    completed: number;
    failed: number;
    rejectedByGate: number;
    rejectedByAudit: number;
    successRate: string;
    avgDurationMs: number;
    avgRelevanceScore: number;
  };
  services: Record<string, 'online' | 'offline' | 'degraded'>;
  activeUsers: number;
  activeTokens: number;
  secretsExpiringSoon: number;
  webhookSubscriptions: number;
  gateCircuitOpen: boolean;
  blockchain?: {
    deployedContracts: number;
    totalTransactions: number;
    activeChains: number[];
  };
}

// ── Shared ────────────────────────────────────────────────────
export interface HealthStatus {
  service: string;
  agent?: string;
  status: 'online' | 'degraded' | 'offline';
  date?: string;
  timestamp: string;
  dependencies?: Record<string, string>;
  uptime?: number;
  version?: string;
}
export interface AgentResponse {
  agentId: 'claude' | 'deepseek' | 'gemini';
  content: string;
  model: string;
  respondedAt: string;
  tokensUsed?: number;
}
