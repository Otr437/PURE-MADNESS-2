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
SHA-256:  431718BD51152D4F78BB8D3A18ACD1F7649888B20FAC04396917C1326AE2806E
SHA-512:  F6A65583EF6F0189EDF4968EA3D466AAF818B5052D8D0C284BDF3C94C877F6B5DCC9C22F15A7A33815BDF99D16F6AB1F6108E7FCF83EDDE8A1D8DB69B5D03F89
MD5:      AE160D6D66FA261009AE95A8C4E186C8
File Size: 3674 bytes

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
import type { FastifyRequest, FastifyReply } from 'fastify'
import { timingSafeEqual, createHash } from 'crypto'
import { verifyAccessToken } from '../utils/jwt.js'
import { audit, logger } from '../utils/logger.js'

const failedAttempts = new Map<string, { count: number; resetAt: number }>()
const MAX_FAILED_ATTEMPTS = 10
const LOCKOUT_MS = 15 * 60 * 1000

function isLockedOut(ip: string): boolean {
  const entry = failedAttempts.get(ip)
  if (!entry) return false
  if (Date.now() > entry.resetAt) { failedAttempts.delete(ip); return false }
  return entry.count >= MAX_FAILED_ATTEMPTS
}

function recordFailure(ip: string): void {
  const entry = failedAttempts.get(ip) || { count: 0, resetAt: Date.now() + LOCKOUT_MS }
  entry.count++
  if (entry.count === 1) entry.resetAt = Date.now() + LOCKOUT_MS
  failedAttempts.set(ip, entry)
}

function clearFailures(ip: string): void {
  failedAttempts.delete(ip)
}

function safeCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Bearer token required' }) as unknown as void
  }
  try {
    const payload = await verifyAccessToken(authHeader.slice(7))
    ;(req as FastifyRequest & { admin: typeof payload }).admin = payload
  } catch {
    recordFailure(req.ip)
    audit('JWT_AUTH_FAILED', { ip: req.ip, path: req.url })
    return reply.code(401).send({ error: 'Invalid or expired token' }) as unknown as void
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isLockedOut(req.ip)) {
    audit('ADMIN_LOCKOUT', { ip: req.ip, path: req.url })
    return reply.code(429).send({ error: 'Too many failed attempts. Try again in 15 minutes.' }) as unknown as void
  }

  const token = req.headers['x-admin-token'] as string | undefined
  const secret = process.env.ADMIN_SECRET

  if (!secret) {
    logger.error('ADMIN_SECRET not configured')
    return reply.code(500).send({ error: 'Server misconfigured' }) as unknown as void
  }

  if (!token || !safeCompare(token, secret)) {
    recordFailure(req.ip)
    audit('UNAUTHORIZED_ADMIN_ACCESS', { ip: req.ip, path: req.url, method: req.method })
    return reply.code(401).send({ error: 'Unauthorized' }) as unknown as void
  }

  clearFailures(req.ip)
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = req.headers['x-session-id'] as string | undefined
  if (!sessionId || sessionId.trim().length < 8 || sessionId.length > 128) {
    return reply.code(400).send({ error: 'Valid x-session-id header required (8-128 chars)' }) as unknown as void
  }
}

export function validateEnv(): void {
  const required = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'ADMIN_SECRET',
    'JWT_SECRET',
    'DATABASE_URL',
    'WALLET_MASTER_SECRET'
  ]
  const missing = required.filter(k => !process.env[k] || process.env[k]!.trim() === '')
  if (missing.length > 0) throw new Error(`Missing required env vars: ${missing.join(', ')}`)
  if (process.env.ADMIN_SECRET!.length < 32) throw new Error('ADMIN_SECRET must be at least 32 characters')
  if (process.env.JWT_SECRET!.length < 32) throw new Error('JWT_SECRET must be at least 32 characters')
  if (process.env.WALLET_MASTER_SECRET!.length < 32) throw new Error('WALLET_MASTER_SECRET must be at least 32 characters')
}

