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
SHA-256:  CB17411A597A5891B1154BEE991F20ABEEF29D6A9513773B65E87D0E610DD233
SHA-512:  DC2D348ABF29404149B826714014BA89419187EB16EE13A96FEC0F5248BCB176720824D84F797AC3671F422A72EA874B491936F49EE6F24558438834AE1571B4
MD5:      D6CCD20004AFBB1B3461D795A4C7E070
File Size: 1843 bytes

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
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { collaborate } from '../agents/collaborator.js'
import { requireSession } from '../middleware/auth.js'
import { audit } from '../utils/logger.js'

const MAX_MESSAGES = 100
const MAX_CONTENT_LENGTH = 32000

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH).transform(s => s.trim()),
  timestamp: z.string().optional()
})

const ChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES),
  sessionId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'sessionId must be alphanumeric')
})

export async function chatRoute(app: FastifyInstance): Promise<void> {
  app.post('/chat', {
    preHandler: [requireSession],
    handler: async (req, reply) => {
      let body: z.infer<typeof ChatRequestSchema>
      try {
        body = ChatRequestSchema.parse(req.body)
      } catch (err) {
        return reply.code(400).send({ error: 'Invalid request body', details: String(err) })
      }

      const { messages, sessionId } = body
      const normalized = messages.map(m => ({
        ...m,
        timestamp: m.timestamp ?? new Date().toISOString()
      }))

      audit('CHAT_REQUEST', { sessionId, messageCount: messages.length, ip: req.ip })

      try {
        const response = await collaborate(normalized, sessionId)
        audit('CHAT_RESPONSE', {
          sessionId,
          toolsUsed: response.toolsUsed.length,
          pendingApprovals: response.pendingApprovals.length
        })
        return reply.code(200).send(response)
      } catch (err) {
        audit('CHAT_ERROR', { sessionId, error: String(err) })
        return reply.code(500).send({ error: 'Collaboration failed', message: String(err) })
      }
    }
  })
}

