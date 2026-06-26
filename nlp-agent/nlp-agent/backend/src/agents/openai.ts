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
SHA-256:  CE88C61F86A380C773A3DCA2B4AB01693B0C859EE4977E8FFA075131E3A27C88
SHA-512:  865C0D2DF1A722F39D6397CA35F2E7F353120615A5B6FDB24BDD8591CFDCCCB8D63608D74239A91923E121E470C9571A524CA532F8FCD31E1385ACC45F5C1001
MD5:      32D30D027BAD47530DEC16FB991C525D
File Size: 3036 bytes

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
import OpenAI from 'openai'
import type { Message, AgentContribution } from '../types/index.js'
import { audit, logger } from '../utils/logger.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const MAX_HISTORY_CHARS = 80000
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

const SYSTEM = `You are GPT, one of three AI collaborators (Claude, GPT, DeepSeek) working together on the user's request.
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

export async function runOpenAI(
  messages: Message[],
  toolDescriptions: string,
  sessionId: string
): Promise<AgentContribution> {
  const start = Date.now()
  const truncated = truncateHistory(messages)
  let lastErr: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: `${SYSTEM}\n\nMCP Tools available:\n${toolDescriptions}` },
          ...truncated.map(m => ({ role: m.role, content: m.content }))
        ]
      })

      const content = response.choices[0]?.message?.content ?? ''
      const latencyMs = Date.now() - start
      audit('OPENAI_RESPONSE', {
        sessionId,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        latencyMs,
        truncated: truncated.length < messages.length
      })

      return {
        provider: 'openai',
        content,
        tokensUsed: (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0),
        latencyMs
      }
    } catch (err) {
      lastErr = err as Error
      const isRateLimit = lastErr.message.includes('429') || lastErr.message.toLowerCase().includes('rate')
      if (isRateLimit && attempt < MAX_RETRIES) {
        logger.warn(`OpenAI rate limited, retry ${attempt}/${MAX_RETRIES}`, { sessionId })
        await sleep(RETRY_DELAY_MS * attempt)
        continue
      }
      if (!isRateLimit) break
    }
  }

  const latencyMs = Date.now() - start
  logger.error('OpenAI agent failed', { sessionId, error: String(lastErr) })
  return { provider: 'openai', content: '', tokensUsed: 0, latencyMs, error: String(lastErr) }
}

