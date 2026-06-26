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
SHA-256:  64A1CF375360A1957456074BB176CD2C3FECDA6EE832BACF007651AA9A9846DE
SHA-512:  3B518F4763ADF7F83C160A29A65B6C9D553DA3BD9D36E3EEABC90DCF653AF1CC2A0EBB6D27CD5B29B782DE4DD4A64A96C8778FDDA9F8BFFAA9A7DED8FA173FEB
MD5:      6EA42157B77F8F5984C3169DBFF59E24
File Size: 6008 bytes

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
import Anthropic from '@anthropic-ai/sdk'
import type { Message, CollaborationResponse, AgentContribution, ToolCall } from '../types/index.js'
import { runClaude } from './claude.js'
import { runOpenAI } from './openai.js'
import { runDeepSeek } from './deepseek.js'
import { getMCPTools, executeMCPTool } from '../mcp/client.js'
import { getPending } from '../store/approvals.js'
import { audit, logger } from '../utils/logger.js'

const synthClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MAX_TOOL_CALLS_PER_SESSION = 20

// Handles nested JSON objects in tool requests — not just flat ones
function extractToolRequests(text: string): Array<{ toolName: string; params: Record<string, unknown> }> {
  const requests: Array<{ toolName: string; params: Record<string, unknown> }> = []
  const regex = /TOOL_REQUEST:\s*(\S+)\s*PARAMS:\s*(\{)/g
  let match

  while ((match = regex.exec(text)) !== null) {
    const toolName = match[1]
    const startIdx = match.index + match[0].length - 1
    let depth = 0
    let i = startIdx
    let jsonStr = ''

    while (i < text.length) {
      const ch = text[i]
      if (ch === '{') depth++
      if (ch === '}') depth--
      jsonStr += ch
      if (depth === 0) break
      i++
    }

    try {
      const params = JSON.parse(jsonStr)
      if (typeof params === 'object' && params !== null) {
        requests.push({ toolName, params })
      }
    } catch {
      logger.warn('Could not parse tool request JSON', { toolName, raw: jsonStr.slice(0, 100) })
    }
  }

  return requests
}

async function executeToolRequests(
  sessionId: string,
  contributions: AgentContribution[],
  existingToolCallCount: number
): Promise<ToolCall[]> {
  const allToolCalls: ToolCall[] = []
  const seen = new Set<string>()
  let callCount = existingToolCallCount

  for (const contribution of contributions) {
    if (!contribution.content) continue
    const requests = extractToolRequests(contribution.content)

    for (const req of requests) {
      if (callCount >= MAX_TOOL_CALLS_PER_SESSION) {
        logger.warn('Max tool calls per session reached', { sessionId, max: MAX_TOOL_CALLS_PER_SESSION })
        break
      }

      const key = `${req.toolName}:${JSON.stringify(req.params)}`
      if (seen.has(key)) continue
      seen.add(key)
      callCount++

      try {
        const context = `Requested by ${contribution.provider} in session ${sessionId}`
        const { toolCall } = await executeMCPTool(sessionId, req.toolName, req.params, context)
        allToolCalls.push(toolCall)
      } catch (err) {
        logger.warn('Tool execution skipped', { tool: req.toolName, reason: String(err) })
      }
    }
  }

  return allToolCalls
}

async function synthesize(
  messages: Message[],
  contributions: AgentContribution[],
  toolCalls: ToolCall[],
  sessionId: string
): Promise<string> {
  const available = contributions.filter(c => c.content && !c.error)

  // Circuit breaker — if all 3 models failed, return a clear error
  if (available.length === 0) {
    logger.error('All three agents failed', { sessionId })
    throw new Error('All AI providers failed to respond. Check your API keys and connectivity.')
  }

  const toolSummary = toolCalls.length > 0
    ? `\n\nTools executed:\n${toolCalls.map(t => `- ${t.tool}: ${JSON.stringify(t.result)}`).join('\n')}`
    : ''

  const contribText = contributions.map(c => {
    const label = c.provider === 'claude' ? 'Claude' : c.provider === 'openai' ? 'GPT-4o' : 'DeepSeek'
    return `${label}:\n${c.error ? `[Error: ${c.error}]` : c.content}`
  }).join('\n\n---\n\n')

  const prompt = `You are synthesizing outputs from ${available.length} AI systems into one complete, accurate response.

${contribText}
${toolSummary}

Original user request: ${messages[messages.length - 1]?.content}

Synthesize these into one complete, accurate, helpful response. Take the best reasoning and facts from each. Do not mention this synthesis process.`

  const response = await synthClient.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  })

  const synthesized = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')

  audit('SYNTHESIS_COMPLETE', { sessionId, tokens: response.usage.input_tokens + response.usage.output_tokens })
  return synthesized
}

export async function collaborate(
  messages: Message[],
  sessionId: string
): Promise<CollaborationResponse> {
  audit('COLLABORATION_START', { sessionId, messageCount: messages.length })

  let toolDescriptions = 'No MCP tools available'
  try {
    const tools = await getMCPTools()
    if (tools.length > 0) {
      toolDescriptions = tools.map(t => `- ${t.name}: ${t.description}`).join('\n')
    }
  } catch (err) {
    logger.warn('Could not fetch MCP tools, proceeding without', { error: String(err) })
  }

  const [claudeResult, openaiResult, deepseekResult] = await Promise.all([
    runClaude(messages, toolDescriptions, sessionId),
    runOpenAI(messages, toolDescriptions, sessionId),
    runDeepSeek(messages, toolDescriptions, sessionId)
  ])

  const contributions = [claudeResult, openaiResult, deepseekResult]
  const toolCalls = await executeToolRequests(sessionId, contributions, 0)
  const synthesized = await synthesize(messages, contributions, toolCalls, sessionId)

  const response: CollaborationResponse = {
    sessionId,
    contributions: {
      claude: claudeResult.content,
      openai: openaiResult.content,
      deepseek: deepseekResult.content
    },
    synthesized,
    toolsUsed: toolCalls,
    pendingApprovals: getPending().filter(a => a.sessionId === sessionId),
    timestamp: new Date().toISOString()
  }

  audit('COLLABORATION_COMPLETE', {
    sessionId,
    toolsUsed: toolCalls.length,
    pendingApprovals: response.pendingApprovals.length,
    modelsSucceeded: contributions.filter(c => !c.error).length
  })

  return response
}

