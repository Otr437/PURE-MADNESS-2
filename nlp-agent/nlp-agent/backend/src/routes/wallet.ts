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
SHA-256:  86C1EB0D84289B9B0C383A4E317D3821CC9B4F1DDD45108A525DD15B90811370
SHA-512:  1A0A1F958E4786D32477802987112C119A23F995157FBCD2CA6976661D365380D62A267E344856E964419E048B1C48871D457E5140B18B08C861993FCB05861D
MD5:      E2B756D89B9909CAA94BE134AD763AAD
File Size: 6225 bytes

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
import { getAgentBalance, updateWalletSettings, getTransactionHistory, requestSpend } from '../wallets/manager.js'
import { prisma } from '../db/client.js'
import { encrypt } from '../utils/crypto.js'
import { audit } from '../utils/logger.js'
import type { AgentId, Chain, ActivityType } from '@prisma/client'

const AgentIdValues = ['CLAUDE', 'OPENAI', 'DEEPSEEK'] as const
const ChainValues = ['ETH', 'BTC', 'ZEC', 'XMR'] as const
const ActivityTypeValues = ['SHOPPING', 'SWAPPING', 'INVESTING', 'TRANSFER', 'GAS_FEE', 'OTHER'] as const

const WalletSettingsSchema = z.object({
  agentId: z.enum(AgentIdValues),
  chain: z.enum(ChainValues),
  autonomousMode: z.boolean().optional(),
  spendLimitAuto: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  spendLimitMax: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  allowShopping: z.boolean().optional(),
  allowSwapping: z.boolean().optional(),
  allowInvesting: z.boolean().optional(),
  allowTransfers: z.boolean().optional()
})

const RegisterWalletSchema = z.object({
  agentId: z.enum(AgentIdValues),
  chain: z.enum(ChainValues),
  address: z.string().min(26).max(128),
  privateKey: z.string().min(32),
  seed: z.string().optional(),
  label: z.string().max(128).optional()
})

const SpendSchema = z.object({
  agentId: z.enum(AgentIdValues),
  sessionId: z.string().min(8).max(128),
  chain: z.enum(ChainValues),
  toAddress: z.string().min(26).max(128),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  activityType: z.enum(ActivityTypeValues),
  tokenContract: z.string().optional(),
  note: z.string().max(512).optional()
})

export async function walletRoute(app: FastifyInstance): Promise<void> {
  // Register a wallet for an agent — SUPERADMIN only
  app.post('/wallets/register', {
    preHandler: [requireAuth],
    handler: async (req, reply) => {
      const admin = (req as FastifyRequest & { admin: { role: string; adminId: string } }).admin
      if (admin.role !== 'SUPERADMIN') return reply.code(403).send({ error: 'SUPERADMIN required' })

      let body: z.infer<typeof RegisterWalletSchema>
      try { body = RegisterWalletSchema.parse(req.body) }
      catch (err) { return reply.code(400).send({ error: 'Invalid body', details: String(err) }) }

      const master = process.env.WALLET_MASTER_SECRET!
      const encryptedKey = encrypt(body.privateKey, master)
      const encryptedSeed = body.seed ? encrypt(body.seed, master) : undefined

      const wallet = await prisma.agentWallet.upsert({
        where: { agentId_chain: { agentId: body.agentId as AgentId, chain: body.chain as Chain } },
        update: { address: body.address, encryptedKey, encryptedSeed, label: body.label },
        create: {
          agentId: body.agentId as AgentId,
          chain: body.chain as Chain,
          address: body.address,
          encryptedKey,
          encryptedSeed,
          label: body.label,
          settings: { create: {} }
        }
      })

      audit('WALLET_REGISTERED', { agentId: body.agentId, chain: body.chain, address: body.address, adminId: admin.adminId })
      return reply.code(201).send({ id: wallet.id, agentId: wallet.agentId, chain: wallet.chain, address: wallet.address })
    }
  })

  // Get balance
  app.get<{ Params: { agentId: string; chain: string } }>('/wallets/:agentId/:chain/balance', {
    preHandler: [requireAuth],
    handler: async (req, reply) => {
      try {
        const balance = await getAgentBalance(req.params.agentId as AgentId, req.params.chain as Chain)
        return reply.code(200).send(balance)
      } catch (err) {
        return reply.code(500).send({ error: String(err) })
      }
    }
  })

  // Get transaction history
  app.get<{ Params: { agentId: string; chain: string } }>('/wallets/:agentId/:chain/transactions', {
    preHandler: [requireAuth],
    handler: async (req, reply) => {
      const history = await getTransactionHistory(req.params.agentId as AgentId, req.params.chain as Chain)
      return reply.code(200).send({ transactions: history })
    }
  })

  // Update wallet settings (toggles, spend limits)
  app.post('/wallets/settings', {
    preHandler: [requireAuth],
    handler: async (req, reply) => {
      const admin = (req as FastifyRequest & { admin: { adminId: string } }).admin
      let body: z.infer<typeof WalletSettingsSchema>
      try { body = WalletSettingsSchema.parse(req.body) }
      catch (err) { return reply.code(400).send({ error: 'Invalid body', details: String(err) }) }

      try {
        await updateWalletSettings(body.agentId as AgentId, body.chain as Chain, body, admin.adminId)
        return reply.code(200).send({ success: true })
      } catch (err) {
        return reply.code(500).send({ error: String(err) })
      }
    }
  })

  // Agent requests a spend (goes through spend limit / approval logic)
  app.post('/wallets/spend', {
    preHandler: [requireAuth],
    handler: async (req, reply) => {
      let body: z.infer<typeof SpendSchema>
      try { body = SpendSchema.parse(req.body) }
      catch (err) { return reply.code(400).send({ error: 'Invalid body', details: String(err) }) }

      try {
        const result = await requestSpend({
          agentId: body.agentId as AgentId,
          sessionId: body.sessionId,
          chain: body.chain as Chain,
          toAddress: body.toAddress,
          amount: body.amount,
          activityType: body.activityType as ActivityType,
          tokenContract: body.tokenContract,
          note: body.note
        })
        return reply.code(200).send(result)
      } catch (err) {
        return reply.code(500).send({ error: String(err) })
      }
    }
  })

  // List all agent wallets
  app.get('/wallets', {
    preHandler: [requireAuth],
    handler: async (_req, reply) => {
      const wallets = await prisma.agentWallet.findMany({
        select: { id: true, agentId: true, chain: true, address: true, label: true, createdAt: true, settings: true },
        orderBy: [{ agentId: 'asc' }, { chain: 'asc' }]
      })
      return reply.code(200).send({ wallets })
    }
  })
}

import type { FastifyRequest } from 'fastify'

