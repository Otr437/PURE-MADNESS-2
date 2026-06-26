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
SHA-256:  2E9E5BFC96E91A6A2FDEC7E88907B8B2B0D5E3130390CEE1976874DB6ABE044B
SHA-512:  3FB0F682EFBD4FAA20E58405A8C531330DE69F0D2DAB34747D3B383186DA1B3FA6F4065D4D99FA65209B93FEDCF25B5E8FE5D7641E126F9028F61A4C03D8A885
MD5:      C70E99A03376B03225B2CC2524ADF8C7
File Size: 2340 bytes

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
import { getPending, getAll, getById, resolve } from '../store/approvals.js'
import { requireAdmin } from '../middleware/auth.js'
import { audit } from '../utils/logger.js'

const ResolveSchema = z.object({
  approvalId: z.string().uuid(),
  approved: z.boolean()
})

const PaginationSchema = z.object({
  limit: z.coerce.number().min(1).max(500).default(50),
  offset: z.coerce.number().min(0).default(0)
})

export async function approvalRoute(app: FastifyInstance): Promise<void> {
  app.get('/approvals/pending', {
    preHandler: [requireAdmin],
    handler: async (_req, reply) => {
      return reply.code(200).send({ approvals: getPending() })
    }
  })

  app.get('/approvals', {
    preHandler: [requireAdmin],
    handler: async (req, reply) => {
      let query: z.infer<typeof PaginationSchema>
      try {
        query = PaginationSchema.parse(req.query)
      } catch {
        query = { limit: 50, offset: 0 }
      }
      const result = getAll(query.limit, query.offset)
      return reply.code(200).send(result)
    }
  })

  app.get<{ Params: { id: string } }>('/approvals/:id', {
    preHandler: [requireAdmin],
    handler: async (req, reply) => {
      const approval = getById(req.params.id)
      if (!approval) return reply.code(404).send({ error: 'Approval not found' })
      return reply.code(200).send(approval)
    }
  })

  app.post('/approvals/resolve', {
    preHandler: [requireAdmin],
    handler: async (req, reply) => {
      let body: z.infer<typeof ResolveSchema>
      try {
        body = ResolveSchema.parse(req.body)
      } catch (err) {
        return reply.code(400).send({ error: 'Invalid request body', details: String(err) })
      }

      const adminId = createHash('sha256').update(req.headers['x-admin-token'] as string).digest('hex').slice(0, 12)
      const resolved = resolve(body.approvalId, body.approved, adminId)

      if (!resolved) return reply.code(404).send({ error: 'Approval not found or already resolved' })

      audit('ADMIN_RESOLVED_APPROVAL', {
        approvalId: body.approvalId,
        approved: body.approved,
        adminId,
        tool: resolved.tool
      })

      return reply.code(200).send({ success: true, approval: resolved })
    }
  })
}

import { createHash } from 'crypto'

