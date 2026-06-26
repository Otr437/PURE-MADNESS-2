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
SHA-256:  622F0437B31C915CEFF0552D8DB6169F5ACF33DE81AEAD586B9AA55AFBE3D73D
SHA-512:  BA84206190E2CA128613FD2031ABA536C8A77763C09B931EE00DB503A75AF2829D400AF5699F3D655C942DFCE1F6DC4A63F859DF92AE8169D336C0082971F1E5
MD5:      86A7A7D9BB649455C88DA68091D3E737
File Size: 689 bytes

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
import { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'

const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' }
  ]
})

prisma.$on('error', (e) => {
  logger.error('Prisma error', { message: e.message, target: e.target })
})

prisma.$on('warn', (e) => {
  logger.warn('Prisma warning', { message: e.message, target: e.target })
})

export async function connectDB(): Promise<void> {
  await prisma.$connect()
  logger.info('Database connected')
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect()
  logger.info('Database disconnected')
}

export { prisma }

