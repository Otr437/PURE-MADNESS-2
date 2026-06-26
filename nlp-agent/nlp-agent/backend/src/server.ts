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
SHA-256:  028B455C57C77197D66A13D4AA4288A221E7D29C9FAFE4D60188E5D29D7EDF2E
SHA-512:  F496BD3948888A70B374605E32DDDA97FD5E9DF833E7FCABAD892614FF878E01793BBC6A9B2922A503786BCB8A19158AACDA3D019EBA4421AEBB073FF41469A5
MD5:      E5534175B1B5CBB4F5EE0DDD293BAC6B
File Size: 3797 bytes

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
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import cookie from '@fastify/cookie'
import csrfProtection from '@fastify/csrf-protection'
import { chatRoute } from './routes/chat.js'
import { approvalRoute } from './routes/approval.js'
import { adminRoute } from './routes/admin.js'
import { authRoute } from './routes/auth.js'
import { walletRoute } from './routes/wallet.js'
import { memoryRoute } from './routes/memory.js'
import { validateEnv } from './middleware/auth.js'
import { disconnectMCP } from './mcp/client.js'
import { connectDB, disconnectDB } from './db/client.js'
import { logger, audit } from './utils/logger.js'

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) })
  process.exit(1)
})

validateEnv()

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 60
const RATE_LIMIT_WINDOW = process.env.RATE_LIMIT_WINDOW || '1 minute'

const app = Fastify({ logger: false, trustProxy: true })

await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
})

await app.register(cors, {
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token', 'x-session-id', 'x-csrf-token'],
  credentials: true
})

await app.register(rateLimit, {
  max: RATE_LIMIT_MAX,
  timeWindow: RATE_LIMIT_WINDOW,
  errorResponseBuilder: () => ({ error: 'Rate limit exceeded', message: 'Too many requests' })
})

await app.register(cookie, { secret: process.env.JWT_SECRET })
await app.register(csrfProtection, {
  cookieOpts: {
    signed: true,
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production'
  }
})

// Routes
await app.register(authRoute, { prefix: '/api' })
await app.register(chatRoute, { prefix: '/api' })
await app.register(approvalRoute, { prefix: '/api' })
await app.register(adminRoute, { prefix: '/api' })
await app.register(walletRoute, { prefix: '/api' })
await app.register(memoryRoute, { prefix: '/api' })

// Public health
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

// CSRF token
app.get('/api/csrf-token', async (_req, reply) => {
  const token = reply.generateCsrf()
  return reply.code(200).send({ token })
})

app.setErrorHandler((err, req, reply) => {
  logger.error('Unhandled error', { path: req.url, method: req.method, error: err.message, stack: err.stack })
  const statusCode = err.statusCode ?? 500
  reply.code(statusCode).send({ error: statusCode >= 500 ? 'Internal server error' : err.message })
})

const shutdown = async (signal: string) => {
  logger.info(`${signal} received, shutting down`)
  audit('SERVER_SHUTDOWN', { signal })
  await disconnectMCP()
  await disconnectDB()
  await app.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const PORT = Number(process.env.PORT) || 3001

await connectDB()

try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
  audit('SERVER_STARTED', { port: PORT, env: process.env.NODE_ENV })
  logger.info(`NLP Agent running on http://0.0.0.0:${PORT}`)
} catch (err) {
  logger.error('Failed to start server', { error: String(err) })
  process.exit(1)
}

