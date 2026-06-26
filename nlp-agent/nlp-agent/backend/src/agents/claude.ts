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
SHA-256:  F22858ACB2833094B53D109B19683A66DFBA5DE9CBD5783DD44C8B2BF54EED59
SHA-512:  3042C43F35FB2F399C629C09B73CA36D2DF0D6146EC049707622EED83466B830FAA3BA017E1E4A197BB89753622925351276F1EEF6CCA32C86C557D82EF80697
MD5:      8DEA9C769BCA8A2086FB995B927F6401
File Size: 3129 bytes

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
import type { Message, AgentContribution } from '../types/index.js'
import { audit, logger } from '../utils/logger.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MAX_HISTORY_CHARS = 80000
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

const SYSTEM = `You are Claude, one of three AI collaborators (Claude, OpenAI GPT, DeepSeek) working together on the user's request.
Contribute your full analysis, reasoning, and perspective. Be thorough and complete.
You have access to MCP tools — when you determine a tool would help, state exactly: TOOL_REQUEST: <toolName> PARAMS: <valid_json_object>
Your job is to collaborate, not to solo solve. Bring your best thinking.`

function truncateHistory(messages: Message[]): Message[] {
  let total = 0
  const result: Message[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    total += messages[i].content.length
    if (total > MAX_HISTORY_CHARS && result.length > 0) break
    result.unshift(messages[i])
  }
  if (result.length === 0 && messages.length > 0) result.push(messages[messages.length - 1])
  return result
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export async function runClaude(
  messages: Message[],
  toolDescriptions: string,
  sessionId: string
): Promise<AgentContribution> {
  const start = Date.now()
  const truncated = truncateHistory(messages)
  let lastErr: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 4096,
        system: `${SYSTEM}\n\nMCP Tools available on this system:\n${toolDescriptions}`,
        messages: truncated.map(m => ({
          role: m.role === 'system' ? 'user' : m.role as 'user' | 'assistant',
          content: m.content
        }))
      })

      const content = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n')

      const latencyMs = Date.now() - start
      audit('CLAUDE_RESPONSE', {
        sessionId,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs,
        truncated: truncated.length < messages.length
      })

      return { provider: 'claude', content, tokensUsed: response.usage.input_tokens + response.usage.output_tokens, latencyMs }
    } catch (err) {
      lastErr = err as Error
      const isRateLimit = lastErr.message.includes('429') || lastErr.message.toLowerCase().includes('rate')
      if (isRateLimit && attempt < MAX_RETRIES) {
        logger.warn(`Claude rate limited, retry ${attempt}/${MAX_RETRIES}`, { sessionId })
        await sleep(RETRY_DELAY_MS * attempt)
        continue
      }
      if (!isRateLimit) break
    }
  }

  const latencyMs = Date.now() - start
  logger.error('Claude agent failed', { sessionId, error: String(lastErr) })
  return { provider: 'claude', content: '', tokensUsed: 0, latencyMs, error: String(lastErr) }
}

