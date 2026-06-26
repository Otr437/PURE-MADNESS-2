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
SHA-256:  86FD6C3F2BC928959617874EBA52170A3CF8B7083A53DF3E68EC9EAFCDBB316C
SHA-512:  B036DBCB0D23F2EA2ADC7A848F746885C2FE12C0564FDBDABDEE6CF66D81D2BC047A3A6B199FCED4377E028942FB42AE0E61740A324677231C4921925A5BD04B
MD5:      665B00F15FC9B050CBCEEC31AE3C21E1
File Size: 2381 bytes

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
import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import path from 'path'

const logDir = process.env.LOG_DIR || './logs'
const logLevel = process.env.LOG_LEVEL || 'info'

const SENSITIVE_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY',
  'ADMIN_SECRET', 'JWT_SECRET', 'MCP_AUTH_TOKEN',
  'authorization', 'x-admin-token', 'password', 'token', 'secret', 'key'
])

function redact(obj: unknown, depth = 0): unknown {
  if (depth > 10) return '[deep]'
  if (typeof obj === 'string') {
    if (obj.startsWith('sk-') || obj.startsWith('sk-ant-')) return '[REDACTED]'
    return obj
  }
  if (Array.isArray(obj)) return obj.map(v => redact(v, depth + 1))
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1)
    }
    return out
  }
  return obj
}

const redactFormat = winston.format(info => {
  const { message, ...meta } = info
  return { ...info, message, ...redact(meta) as object }
})

export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        redactFormat(),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const m = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
          return `[${timestamp}] ${level}: ${message}${m}`
        })
      )
    }),
    new DailyRotateFile({
      dirname: path.join(logDir, 'audit'),
      filename: 'audit-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '50m',
      maxFiles: '90d'
    }),
    new DailyRotateFile({
      dirname: path.join(logDir, 'errors'),
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '50m',
      maxFiles: '90d',
      level: 'error'
    })
  ]
})

export function audit(event: string, data: Record<string, unknown> = {}): void {
  logger.info(event, { audit: true, ...redact(data) as Record<string, unknown> })
}


