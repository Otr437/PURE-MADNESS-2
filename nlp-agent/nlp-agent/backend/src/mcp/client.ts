/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2026 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-03-07 12:21:24
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  EB83842997C820E3A7136C310676E5293C2B8E466A623696153C28A1674C91F3
SHA-512:  AB7E6F4A08E44B0863C8E5164F614BAF42F78AC9F6A5855A3E10E48D7B9C2210A16A94EEE6769AC118D280D27637AAC77D92DCAD9DF5EF6227E757B9E9CCC204
MD5:      ABE97A32168150C814325410CD237AC8
File Size: 5573 bytes

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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { MCPTool, ToolCall } from '../types/index.js'
import { createApproval, waitForApproval } from '../store/approvals.js'
import { audit, logger } from '../utils/logger.js'
import { v4 as uuidv4 } from 'uuid'

const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS) || 30000
const MCP_RETRY_ATTEMPTS = 3
const MCP_RETRY_DELAY_MS = 1000

let mcpClient: Client | null = null
let connecting = false
let connectionAttempts = 0

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function connectMCPClient(): Promise<Client> {
  const serverUrl = process.env.MCP_SERVER_URL
  const token = process.env.MCP_AUTH_TOKEN
  if (!serverUrl) throw new Error('MCP_SERVER_URL not configured')

  const transport = new StreamableHTTPClientTransport(
    new URL(serverUrl),
    { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } }
  )

  const client = new Client(
    { name: 'nlp-agent', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  client.onclose = () => {
    logger.warn('MCP connection closed, will reconnect on next use')
    mcpClient = null
  }

  client.onerror = (err) => {
    logger.error('MCP client error', { error: String(err) })
    mcpClient = null
  }

  await client.connect(transport)
  audit('MCP_CLIENT_CONNECTED', { serverUrl, attempt: connectionAttempts })
  return client
}

async function getMCPClient(): Promise<Client> {
  if (mcpClient) return mcpClient
  if (connecting) {
    await sleep(500)
    if (mcpClient) return mcpClient
    throw new Error('MCP connection in progress')
  }

  connecting = true
  let lastErr: Error | null = null

  for (let attempt = 1; attempt <= MCP_RETRY_ATTEMPTS; attempt++) {
    try {
      connectionAttempts++
      mcpClient = await connectMCPClient()
      connecting = false
      return mcpClient
    } catch (err) {
      lastErr = err as Error
      logger.warn(`MCP connect attempt ${attempt} failed`, { error: String(err) })
      if (attempt < MCP_RETRY_ATTEMPTS) await sleep(MCP_RETRY_DELAY_MS * attempt)
    }
  }

  connecting = false
  throw new Error(`MCP connection failed after ${MCP_RETRY_ATTEMPTS} attempts: ${lastErr?.message}`)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ])
}

export async function getMCPTools(): Promise<MCPTool[]> {
  try {
    const client = await getMCPClient()
    const response = await withTimeout(client.listTools(), MCP_TIMEOUT_MS, 'listTools')
    const tools: MCPTool[] = response.tools.map(t => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema as Record<string, unknown>,
      requiresApproval: true,
      riskLevel: 'medium' as const
    }))
    audit('MCP_TOOLS_FETCHED', { count: tools.length })
    return tools
  } catch (err) {
    mcpClient = null
    logger.error('Failed to fetch MCP tools', { error: String(err) })
    throw err
  }
}

export async function executeMCPTool(
  sessionId: string,
  toolName: string,
  parameters: Record<string, unknown>,
  context: string
): Promise<{ result: unknown; toolCall: ToolCall }> {
  const toolCall: ToolCall = {
    id: uuidv4(),
    tool: toolName,
    parameters,
    executedAt: new Date().toISOString()
  }

  const approvalTimeoutMs = Number(process.env.APPROVAL_TIMEOUT_MS) || 300000
  const approval = createApproval(sessionId, toolName, `Execute MCP tool: ${toolName}`, parameters, context, 'medium')
  toolCall.approvalId = approval.id
  audit('MCP_TOOL_AWAITING_APPROVAL', { sessionId, toolName, approvalId: approval.id })

  let approved: boolean
  try {
    approved = await waitForApproval(approval.id, approvalTimeoutMs)
  } catch (err) {
    audit('MCP_TOOL_APPROVAL_TIMEOUT', { sessionId, toolName, approvalId: approval.id })
    toolCall.error = String(err)
    toolCall.completedAt = new Date().toISOString()
    throw new Error(`Approval timeout for tool: ${toolName}`)
  }

  if (!approved) {
    audit('MCP_TOOL_DENIED', { sessionId, toolName, approvalId: approval.id })
    toolCall.error = 'Denied by admin'
    toolCall.completedAt = new Date().toISOString()
    throw new Error(`Admin denied execution of: ${toolName}`)
  }

  try {
    audit('MCP_TOOL_EXECUTING', { sessionId, toolName, approvalId: approval.id })
    const client = await getMCPClient()
    const response = await withTimeout(
      client.callTool({ name: toolName, arguments: parameters }),
      MCP_TIMEOUT_MS,
      `callTool:${toolName}`
    )
    toolCall.result = response.content
    toolCall.completedAt = new Date().toISOString()
    audit('MCP_TOOL_SUCCESS', { sessionId, toolName, callId: toolCall.id })
    return { result: response.content, toolCall }
  } catch (err) {
    mcpClient = null
    toolCall.error = String(err)
    toolCall.completedAt = new Date().toISOString()
    audit('MCP_TOOL_FAILED', { sessionId, toolName, error: String(err) })
    throw err
  }
}

export async function pingMCP(): Promise<boolean> {
  try {
    await getMCPClient()
    return true
  } catch {
    return false
  }
}

export async function disconnectMCP(): Promise<void> {
  if (mcpClient) {
    await mcpClient.close()
    mcpClient = null
    audit('MCP_CLIENT_DISCONNECTED', {})
  }
}

