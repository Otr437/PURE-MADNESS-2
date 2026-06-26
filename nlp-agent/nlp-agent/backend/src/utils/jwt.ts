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
SHA-256:  6E596B38C7A7E419B241DA79C937A653B7D824C1B5B5C5596DD34A5792504A5A
SHA-512:  FF6941D3564163A94099947BC8B815A1CA4791BCD57E567A59B7270EFA533442B74BD68E2E5D8828FCFBCE7A3112CCA48E26D928E355E5C6836AB0E2519D57E4
MD5:      9CA6C32C45A578E98FB5DC7588E409B5
File Size: 2722 bytes

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
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { prisma } from '../db/client.js'
import { audit, logger } from '../utils/logger.js'
import { randomBytes } from 'crypto'
import type { Admin, AdminRole } from '@prisma/client'

const ACCESS_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)
const ACCESS_EXPIRES = '15m'
const REFRESH_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface AdminTokenPayload extends JWTPayload {
  adminId: string
  username: string
  role: AdminRole
}

export async function signAccessToken(admin: Admin): Promise<string> {
  return new SignJWT({ adminId: admin.id, username: admin.username, role: admin.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_EXPIRES)
    .sign(ACCESS_SECRET)
}

export async function verifyAccessToken(token: string): Promise<AdminTokenPayload> {
  const { payload } = await jwtVerify(token, ACCESS_SECRET)
  return payload as AdminTokenPayload
}

export async function createRefreshToken(adminId: string): Promise<string> {
  const token = randomBytes(64).toString('hex')
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS)

  await prisma.refreshToken.create({ data: { token, adminId, expiresAt } })
  return token
}

export async function rotateRefreshToken(oldToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
  const record = await prisma.refreshToken.findUnique({
    where: { token: oldToken },
    include: { admin: true }
  })

  if (!record || record.revokedAt || record.expiresAt < new Date()) {
    if (record) {
      // Possible token theft — revoke all tokens for this admin
      await prisma.refreshToken.updateMany({
        where: { adminId: record.adminId, revokedAt: null },
        data: { revokedAt: new Date() }
      })
      audit('REFRESH_TOKEN_REUSE_DETECTED', { adminId: record.adminId })
    }
    return null
  }

  // Revoke old token
  await prisma.refreshToken.update({ where: { token: oldToken }, data: { revokedAt: new Date() } })

  // Issue new pair
  const accessToken = await signAccessToken(record.admin)
  const refreshToken = await createRefreshToken(record.adminId)

  audit('TOKEN_ROTATED', { adminId: record.adminId })
  return { accessToken, refreshToken }
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.update({ where: { token }, data: { revokedAt: new Date() } }).catch(() => {})
}

export async function revokeAllAdminTokens(adminId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { adminId, revokedAt: null },
    data: { revokedAt: new Date() }
  })
  audit('ALL_TOKENS_REVOKED', { adminId })
}

