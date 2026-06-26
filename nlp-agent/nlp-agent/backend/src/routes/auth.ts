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
SHA-256:  A6B08FCE304BFE9B647231A8F141F55E84E9A67FD90A834FE336D1F21F16AD50
SHA-512:  9D73FF05C0608AE3B08EC58C323EDCF9D81290A87254C0AAB7D71153306CB4026635DBE4E2918D5D5EB85770AC1BED3EAB3EE53BB9E993FE6B581206F2EE3C15
MD5:      BEDFC857F3384A20CEE18F6A37BCA49C
File Size: 3776 bytes

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
import bcrypt from 'bcrypt'
import { prisma } from '../db/client.js'
import { signAccessToken, createRefreshToken, rotateRefreshToken, revokeRefreshToken, verifyAccessToken } from '../utils/jwt.js'
import { audit, logger } from '../utils/logger.js'

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256)
})

const RefreshSchema = z.object({
  refreshToken: z.string().min(1)
})

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/'
}

export async function authRoute(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', {
    handler: async (req, reply) => {
      let body: z.infer<typeof LoginSchema>
      try {
        body = LoginSchema.parse(req.body)
      } catch (err) {
        return reply.code(400).send({ error: 'Invalid request', details: String(err) })
      }

      const admin = await prisma.admin.findUnique({ where: { username: body.username } })

      // Always run bcrypt even if user not found to prevent timing attacks
      const hash = admin?.passwordHash ?? '$2b$12$invalidhashfortimingnnnnnnnnnnnnnnnnnnnnnnn'
      const valid = await bcrypt.compare(body.password, hash)

      if (!admin || !valid) {
        audit('LOGIN_FAILED', { username: body.username, ip: req.ip })
        return reply.code(401).send({ error: 'Invalid credentials' })
      }

      const accessToken = await signAccessToken(admin)
      const refreshToken = await createRefreshToken(admin.id)

      await prisma.admin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } })
      audit('LOGIN_SUCCESS', { adminId: admin.id, username: admin.username, ip: req.ip })

      reply.setCookie('refreshToken', refreshToken, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 })
      return reply.code(200).send({ accessToken, role: admin.role, username: admin.username })
    }
  })

  app.post('/auth/refresh', {
    handler: async (req, reply) => {
      const cookieToken = req.cookies?.refreshToken
      let bodyToken: string | undefined

      try {
        const body = RefreshSchema.parse(req.body)
        bodyToken = body.refreshToken
      } catch { /* body may be empty */ }

      const token = cookieToken || bodyToken
      if (!token) return reply.code(401).send({ error: 'No refresh token provided' })

      const result = await rotateRefreshToken(token)
      if (!result) {
        reply.clearCookie('refreshToken')
        return reply.code(401).send({ error: 'Invalid or expired refresh token' })
      }

      reply.setCookie('refreshToken', result.refreshToken, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 })
      return reply.code(200).send({ accessToken: result.accessToken })
    }
  })

  app.post('/auth/logout', {
    handler: async (req, reply) => {
      const token = req.cookies?.refreshToken
      if (token) await revokeRefreshToken(token)
      reply.clearCookie('refreshToken')
      return reply.code(200).send({ success: true })
    }
  })

  app.get('/auth/me', {
    handler: async (req, reply) => {
      const authHeader = req.headers.authorization
      if (!authHeader?.startsWith('Bearer ')) return reply.code(401).send({ error: 'No token' })
      try {
        const payload = await verifyAccessToken(authHeader.slice(7))
        const admin = await prisma.admin.findUnique({ where: { id: payload.adminId }, select: { id: true, username: true, role: true, lastLoginAt: true } })
        if (!admin) return reply.code(401).send({ error: 'Admin not found' })
        return reply.code(200).send(admin)
      } catch {
        return reply.code(401).send({ error: 'Invalid token' })
      }
    }
  })
}

