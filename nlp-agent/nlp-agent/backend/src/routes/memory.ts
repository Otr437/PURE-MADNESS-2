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
SHA-256:  F7FB1065CAC47AEE327A3006C4A6B0BBA3D622895DD6BA4BE1266B795C04C346
SHA-512:  379359BDE102879B7F35E4DDAD1FD59E61D431B99C290F787E968DCE4F83CE48DDC4552D471F0CC277476A4FF27A2A66CCCE2B114F1122187B2130088C74D66D
MD5:      E459B780EE3D0D0B043F38066FB19ECD
File Size: 3471 bytes

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
import { requireAuth } from '../middleware/auth.js'
import { prisma } from '../db/client.js'
import { audit } from '../utils/logger.js'
import type { AgentId } from '@prisma/client'

const AgentIdValues = ['CLAUDE', 'OPENAI', 'DEEPSEEK'] as const

const SetMemorySchema = z.object({
  agentId: z.enum(AgentIdValues),
  key: z.string().min(1).max(256),
  value: z.string().max(65536),
  sessionId: z.string().optional(),
  expiresInSeconds: z.number().int().min(1).optional()
})

const GetMemorySchema = z.object({
  agentId: z.enum(AgentIdValues),
  key: z.string().min(1).max(256)
})

export async function memoryRoute(app: FastifyInstance): Promise<void> {
  // Set a memory entry for an agent
  app.post('/memory', {
    preHandler: [requireAuth],
    handler: async (req, reply) => {
      let body: z.infer<typeof SetMemorySchema>
      try { body = SetMemorySchema.parse(req.body) }
      catch (err) { return reply.code(400).send({ error: 'Invalid body', details: String(err) }) }

      const expiresAt = body.expiresInSeconds
        ? new Date(Date.now() + body.expiresInSeconds * 1000)
        : undefined

      const memory = await prisma.agentMemory.upsert({
        where: { agentId_key: { agentId: body.agentId as AgentId, key: body.key } },
        update: { value: body.value, sessionId: body.sessionId, expiresAt, updatedAt: new Date() },
        create: {
          agentId: body.agentId as AgentId,
          key: body.key,
          value: body.value,
          sessionId: body.sessionId,
          expiresAt
        }
      })

      audit('MEMORY_SET', { agentId: body.agentId, key: body.key })
      return reply.code(200).send({ id: memory.id, agentId: memory.agentId, key: memory.key, updatedAt: memory.updatedAt })
    }
  })

  // Get a memory entry
  app.get<{ Params: { agentId: string; key: string } }>('/memory/:agentId/:key', {
    preHandler: [requireAuth],
    handler: async (req, reply) => {
      const memory = await prisma.agentMemory.findUnique({
        where: { agentId_key: { agentId: req.params.agentId as AgentId, key: req.params.key } }
      })

      if (!memory) return reply.code(404).send({ error: 'Memory entry not found' })
      if (memory.expiresAt && memory.expiresAt < new Date()) {
        await prisma.agentMemory.delete({ where: { id: memory.id } })
        return reply.code(404).send({ error: 'Memory entry expired' })
      }

      return reply.code(200).send(memory)
    }
  })

  // List all memory entries for an agent
  app.get<{ Params: { agentId: string } }>('/memory/:agentId', {
    preHandler: [requireAuth],
    handler: async (req, reply) => {
      const memories = await prisma.agentMemory.findMany({
        where: {
          agentId: req.params.agentId as AgentId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        },
        orderBy: { updatedAt: 'desc' }
      })
      return reply.code(200).send({ memories })
    }
  })

  // Delete a memory entry
  app.delete<{ Params: { agentId: string; key: string } }>('/memory/:agentId/:key', {
    preHandler: [requireAuth],
    handler: async (req, reply) => {
      await prisma.agentMemory.deleteMany({
        where: { agentId: req.params.agentId as AgentId, key: req.params.key }
      })
      audit('MEMORY_DELETED', { agentId: req.params.agentId, key: req.params.key })
      return reply.code(200).send({ success: true })
    }
  })
}

