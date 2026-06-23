// ─── CVE types ───────────────────────────────────────────────────────────────

export interface CVSSScore {
  baseScore: number;
  baseSeverity: string;
  vectorString: string;
}

export interface CISAKEVEntry {
  exploitAdd: string;
  actionDue: string;
  requiredAction: string;
  vulnerabilityName: string;
}

export interface ParsedCVE {
  id: string;
  sourceIdentifier: string;
  published: string;
  lastModified: string;
  vulnStatus: string;
  cvssV3?: CVSSScore;
  cvssV2?: CVSSScore;
  cwe?: string[];
  description: string;
  references: string[];
  cisaKEV?: CISAKEVEntry;
  affectedProducts?: string[];
}

export interface CVEMonitorState {
  lastUpdate: string;
  totalCVEs: number;
  criticalCVEs: ParsedCVE[];
  cisaKEV: ParsedCVE[];
  recentExploits: ParsedCVE[];
  updateInterval: number;
  isRunning: boolean;
  statistics: {
    totalFetched: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    exploitedCount: number;
  };
}

export interface CVESearchQuery {
  cveId?: string;
  keyword?: string;
  severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  exploited?: boolean;
  limit?: number;
}

// ─── OAuth types ──────────────────────────────────────────────────────────────

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  scopes: string[];
  grant_types: string[];
  is_public: boolean;
}

export interface OAuthToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  created_at: number;
}

export interface AuthCodeData {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: number;
}

// ─── Agent types ──────────────────────────────────────────────────────────────

export type AgentStatus = "idle" | "running" | "paused" | "terminated";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type PermissionType =
  | "file_access"
  | "network"
  | "system_command"
  | "financial"
  | "installation";
export type TransactionType =
  | "trade"
  | "transfer"
  | "stake"
  | "swap"
  | "provide_liquidity";

export interface AgentPermission {
  type: PermissionType;
  scope: string;
  granted: boolean;
}

export interface AgentWallet {
  chain: string;
  address: string;
  purpose: string;
  encryptedPrivateKey?: string;
  gasAllowance?: string;
}

export interface AgentBudget {
  tradingLimit?: number;
  gasLimit?: number;
  apiCostLimit?: number;
  currency?: string;
}

export interface AgentTask {
  id: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  assignedBy: string;
  assignedAt: string;
  status: "pending" | "in-progress" | "complete" | "blocked";
  requirements?: Record<string, unknown>;
}

export interface Agent {
  id: string;
  template: string;
  role: string;
  capabilities: string[];
  skills: string[];
  permissions: AgentPermission[];
  status: AgentStatus;
  createdBy: string;
  createdAt: string;
  budget?: AgentBudget;
  wallets: AgentWallet[];
  tasks: AgentTask[];
  reports: AgentReport[];
  isBackgroundAgent: boolean;
}

export interface AgentReport {
  id: string;
  agentId: string;
  reportType: "progress" | "completion" | "blocker" | "finding" | "financial";
  summary: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface ApprovalRequest {
  id: string;
  agentId: string;
  requestType:
    | "install_tool"
    | "execute_command"
    | "financial_transaction"
    | "api_access";
  description: string;
  riskLevel: RiskLevel;
  details?: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  notes?: string;
}

export interface ExecutionLogEntry {
  timestamp: string;
  actor: string;
  action: string;
  target?: string;
  details: string | object;
  severity: "info" | "warn" | "error" | "critical";
  encrypted: boolean;
}

export interface AgentTemplate {
  role: string;
  capabilities: string[];
  skills: string[];
  permissions: AgentPermission[];
  isBackgroundAgent?: boolean;
}

export type AgentTemplateKey =
  | "cve-monitor"
  | "jr-ceo"
  | "crypto-trader"
  | "stock-trader"
  | "defi-manager"
  | "nft-agent"
  | "mev-bot"
  | "market-maker"
  | "smart-contract-auditor"
  | "poc-exploit-dev"
  | "contract-fuzzer"
  | "reentrancy-hunter"
  | "defi-protocol-analyzer"
  | "pentester"
  | "web3-pentester"
  | "zero-day-hunter"
  | "ransomware-analyst"
  | "api-fuzzer"
  | "defense-analyst"
  | "soc-analyst"
  | "threat-intel"
  | "honeypot-manager"
  | "blockchain-analyst"
  | "wallet-tracker"
  | "rugpull-detector"
  | "bridge-monitor"
  | "web-scraper"
  | "osint-investigator"
  | "dark-web-monitor"
  | "credential-hunter"
  | "ml-model-builder"
  | "llm-security-tester"
  | "ai-agent-monitor"
  | "builder"
  | "devops"
  | "code-reviewer"
  | "bug-bounty-hunter"
  | "researcher"
  | "social-media"
  | "influencer-tracker"
  | "legal-compliance"
  | "incident-responder"
  | "red-team-commander"
  | "blue-team-defender"
  | "crypto-forensics"
  | "exploit-aggregator"
  | "sandwich-bot"
  | "liquidation-bot"
  | "token-sniper"
  | "governance-monitor";
