/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2026 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-03-07 12:21:25
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  4C2CC8E538455BAC7C23197338AD8F403F3FAF6F4A490698C5A9BC319AC4D1DD
SHA-512:  F1B805FB75831A397ECA9AECCF03082A6C493406F98C8A46D904FD1E1A9DD81A13B68B0EB05C0DDE3CD686091FD199CE035EFDBE155475561AD74ADC4AEC52C1
MD5:      97F1B7242A0C2E923F2D19BF187A8A78
File Size: 3584 bytes

LICENSE:
PROPRIETARY LICENSE

Copyright (c) 2026 Leon Sage. All Rights Reserved.
Sage Audio LLC

This software is proprietary and confidential property of Leon Sage.
UNAUTHORIZED COPYING, MODIFICATION, DISTRIBUTION, OR USE IS STRICTLY PROHIBITED.

⚠️  ANTI-THEFT NOTICE:
This code is cryptographically signed and protected. Any
unauthorized modification, distribution, or removal of this
protection constitutes copyright infringement.
═══════════════════════════════════════════════════════════
*/
export type AIProvider = 'claude' | 'openai' | 'deepseek'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type ApprovalStatus = 'pending' | 'approved' | 'denied'

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  provider?: AIProvider
  timestamp: string
}

export interface ChatRequest {
  messages: Message[]
  sessionId: string
}

export interface CollaborationResponse {
  sessionId: string
  contributions: { claude: string; openai: string; deepseek: string }
  synthesized: string
  toolsUsed: ToolCall[]
  pendingApprovals: PendingApproval[]
  timestamp: string
}

export interface PendingApproval {
  id: string
  sessionId: string
  tool: string
  action: string
  parameters: Record<string, unknown>
  context: string
  riskLevel: RiskLevel
  createdAt: string
  status: ApprovalStatus
  resolvedAt?: string
  resolvedBy?: string
}

export interface ToolCall {
  id: string
  tool: string
  parameters: Record<string, unknown>
  result?: unknown
  error?: string
  approvalId?: string
  executedAt: string
  completedAt?: string
}

export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  requiresApproval: boolean
  riskLevel: RiskLevel
}

export interface MCPToolsResponse {
  tools: MCPTool[]
}

export interface MCPExecuteResponse {
  result: unknown
  executionTime: number
}

export interface AuditEntry {
  id: string
  sessionId: string
  event: string
  provider?: AIProvider
  tool?: string
  approvalId?: string
  approved?: boolean
  adminId?: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface AdminResolveRequest {
  approvalId: string
  approved: boolean
}

export interface SessionContext {
  sessionId: string
  createdAt: string
  messageCount: number
  totalTokensUsed: number
}

export type TransactionStatus = 'pending_approval' | 'approved' | 'denied' | 'processing' | 'completed' | 'failed'
export type TransactionType = 'credit' | 'debit' | 'transfer' | 'withdrawal' | 'deposit'
export type PaymentRail = 'stripe' | 'plaid_ach' | 'internal'

export interface AgentWallet {
  id: string
  agentId: AIProvider
  balance: number
  currency: string
  stripeCustomerId: string
  createdAt: string
  updatedAt: string
}

export interface Transaction {
  id: string
  fromAgentId?: AIProvider
  toAgentId?: AIProvider
  amount: number
  currency: string
  type: TransactionType
  rail: PaymentRail
  status: TransactionStatus
  description: string
  stripePaymentIntentId?: string
  plaidTransactionId?: string
  approvalId?: string
  approvedBy?: string
  createdAt: string
  completedAt?: string
  failureReason?: string
}

export interface BankAccount {
  id: string
  agentId: AIProvider
  plaidItemId: string
  plaidAccountId: string
  institutionName: string
  accountName: string
  accountType: string
  mask: string
  currentBalance: number
  availableBalance: number
  currency: string
  lastSynced: string
  createdAt: string
}

export interface AdminUser {
  id: string
  email: string
  passwordHash: string
  role: 'superadmin'
  createdAt: string
  lastLoginAt?: string
}

export interface JWTPayload {
  adminId: string
  email: string
  role: string
  iat: number
  exp: number
}

export interface RefreshToken {
  id: string
  adminId: string
  tokenHash: string
  expiresAt: string
  createdAt: string
  revokedAt?: string
}valId: string
  approved: boolean
}

export interface AgentContribution {
  provider: AIProvider
  content: string
  tokensUsed: number
  latencyMs: number
  error?: string
}

