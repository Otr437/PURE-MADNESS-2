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
SHA-256:  279708A7EA551D4B44B7A4354C4932B7F329AD094DBEFE2F1B9E0B0094855058
SHA-512:  34E1F3295EA280E9166DF39BD9090CFEBCEFB4FD59FB2C9C9867650E8FA1606DC2880422D437C7A4C7897A74788EBAEDFD3948A33BB5AC0C7C4D57BF9492933C
MD5:      933F938B037E96BFBC559A7F237FD89F
File Size: 3106 bytes

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

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1'
})

const MAX_HISTORY_CHARS = 80000
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000

const SYSTEM = `You are DeepSeek, one of three AI collaborators (Claude, GPT, DeepSeek) working together on the user's request.
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

export async function runDeepSeek(
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
        model: 'deepseek-chat',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: `${SYSTEM}\n\nMCP Tools available:\n${toolDescriptions}` },
          ...truncated.map(m => ({ role: m.role, content: m.content }))
        ]
      })

      const content = response.choices[0]?.message?.content ?? ''
      const latencyMs = Date.now() - start
      audit('DEEPSEEK_RESPONSE', {
        sessionId,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        latencyMs,
        truncated: truncated.length < messages.length
      })

      return {
        provider: 'deepseek',
        content,
        tokensUsed: (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0),
        latencyMs
      }
    } catch (err) {
      lastErr = err as Error
      const isRateLimit = lastErr.message.includes('429') || lastErr.message.toLowerCase().includes('rate')
      if (isRateLimit && attempt < MAX_RETRIES) {
        logger.warn(`DeepSeek rate limited, retry ${attempt}/${MAX_RETRIES}`, { sessionId })
        await sleep(RETRY_DELAY_MS * attempt)
        continue
      }
      if (!isRateLimit) break
    }
  }

  const latencyMs = Date.now() - start
  logger.error('DeepSeek agent failed', { sessionId, error: String(lastErr) })
  return { provider: 'deepseek', content: '', tokensUsed: 0, latencyMs, error: String(lastErr) }
}

