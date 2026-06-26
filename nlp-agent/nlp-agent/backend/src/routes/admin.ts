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
SHA-256:  E2BF3A207E5C0F66A06B898848F9844AA8B94591C3AF25CD93A4622D81446863
SHA-512:  41C0F3DB6211AC61A74129D46454566ABDEB6BE8F924A38772D36B5C45CF7AC6D1DC7414EEDF2FFE12C79274CE4BE1C1FBDBB96C19BC77781CD94DFFAB247BAF
MD5:      4B0A8B216BB073D15B76904388A0D2E2
File Size: 2634 bytes

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
import { existsSync, readdirSync, readFileSync } from 'fs'
import path from 'path'
import { requireAdmin } from '../middleware/auth.js'
import { pingMCP, getMCPTools } from '../mcp/client.js'
import { getAll } from '../store/approvals.js'
import { audit } from '../utils/logger.js'

function readRecentAuditLogs(maxLines = 500): unknown[] {
  const logDir = path.join(process.env.LOG_DIR || './logs', 'audit')
  if (!existsSync(logDir)) return []

  const files = readdirSync(logDir)
    .filter(f => f.endsWith('.log'))
    .sort()
    .reverse()
    .slice(0, 3)

  const lines: unknown[] = []
  for (const file of files) {
    const content = readFileSync(path.join(logDir, file), 'utf-8')
    const parsed = content.split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
    lines.push(...parsed)
    if (lines.length >= maxLines) break
  }

  return lines.slice(0, maxLines)
}

export async function adminRoute(app: FastifyInstance): Promise<void> {
  app.get('/admin/health', {
    preHandler: [requireAdmin],
    handler: async (_req, reply) => {
      const mcpOnline = await pingMCP()
      const providers = {
        claude: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        deepseek: !!process.env.DEEPSEEK_API_KEY
      }
      audit('ADMIN_HEALTH_CHECK', { mcpOnline, providers })
      return reply.code(200).send({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mcp: { online: mcpOnline, url: process.env.MCP_SERVER_URL },
        providers
      })
    }
  })

  app.get('/admin/tools', {
    preHandler: [requireAdmin],
    handler: async (_req, reply) => {
      try {
        const tools = await getMCPTools()
        return reply.code(200).send({ tools })
      } catch (err) {
        return reply.code(503).send({ error: 'MCP server unavailable', message: String(err) })
      }
    }
  })

  app.get('/admin/audit', {
    preHandler: [requireAdmin],
    handler: async (_req, reply) => {
      const { approvals, total } = getAll(200, 0)
      const recentLogs = readRecentAuditLogs(500)
      return reply.code(200).send({
        approvals: {
          records: approvals,
          total,
          summary: {
            pending: approvals.filter(a => a.status === 'pending').length,
            approved: approvals.filter(a => a.status === 'approved').length,
            denied: approvals.filter(a => a.status === 'denied').length
          }
        },
        recentAuditLog: recentLogs
      })
    }
  })
}

