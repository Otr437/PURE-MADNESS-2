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
SHA-256:  C9522A9980AB30445C0C52AB7BAED9992B3CB505CE9E24393C68D67DCC4B6D8B
SHA-512:  5B1ACE1FAEA76F14D1867A72680FF33D2EFE935B6ADD3FAD17802EAA902B05961626BCF7434F64A9B6CE45CE6BA15FF2A52763538C5F4B9BDAE5F5D4B5DA140E
MD5:      1F6D15ED3836EAD76C2A9452FE7D990E
File Size: 9229 bytes

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
import { prisma } from '../db/client.js'
import { createApproval, waitForApproval } from '../store/approvals.js'
import { audit, logger } from '../utils/logger.js'
import { sendETH, sendERC20, getETHBalance, getERC20Balance } from './eth.js'
import { sendBTC, getBTCBalance } from './btc.js'
import { sendZEC, getZECBalance } from './zec.js'
import { sendXMR, getXMRBalance } from './xmr.js'
import type { AgentId, Chain, ActivityType } from '@prisma/client'
import { v4 as uuidv4 } from 'uuid'

export interface SpendRequest {
  agentId: AgentId
  sessionId: string
  chain: Chain
  toAddress: string
  amount: string
  activityType: ActivityType
  tokenContract?: string
  note?: string
}

export interface WalletBalance {
  agentId: AgentId
  chain: Chain
  address: string
  balance: string
  autonomousMode: boolean
  spendLimitAuto: string
  allowedActivities: string[]
}

export async function getAgentBalance(agentId: AgentId, chain: Chain): Promise<WalletBalance> {
  const wallet = await prisma.agentWallet.findUnique({
    where: { agentId_chain: { agentId, chain } },
    include: { settings: true }
  })

  if (!wallet) throw new Error(`No ${chain} wallet found for agent ${agentId}`)

  let balance = '0'
  switch (chain) {
    case 'ETH':
      balance = await getETHBalance(wallet.address)
      break
    case 'BTC':
      balance = await getBTCBalance(wallet.address)
      break
    case 'ZEC':
      balance = await getZECBalance(wallet.address)
      break
    case 'XMR':
      if (!wallet.encryptedSeed) throw new Error('XMR wallet requires seed')
      balance = await getXMRBalance(wallet.address, wallet.encryptedSeed)
      break
  }

  const settings = wallet.settings
  const allowedActivities: string[] = []
  if (settings?.allowShopping) allowedActivities.push('SHOPPING')
  if (settings?.allowSwapping) allowedActivities.push('SWAPPING')
  if (settings?.allowInvesting) allowedActivities.push('INVESTING')
  if (settings?.allowTransfers) allowedActivities.push('TRANSFER')

  return {
    agentId,
    chain,
    address: wallet.address,
    balance,
    autonomousMode: settings?.autonomousMode ?? false,
    spendLimitAuto: settings?.spendLimitAuto ?? '0',
    allowedActivities
  }
}

export async function requestSpend(req: SpendRequest): Promise<{
  approved: boolean
  txHash?: string
  approvalId?: string
  denied?: boolean
  reason?: string
}> {
  const { agentId, sessionId, chain, toAddress, amount, activityType, tokenContract, note } = req

  const wallet = await prisma.agentWallet.findUnique({
    where: { agentId_chain: { agentId, chain } },
    include: { settings: true }
  })

  if (!wallet) throw new Error(`No ${chain} wallet found for agent ${agentId}`)

  const settings = wallet.settings

  // Check activity is allowed
  const activityAllowed = (
    (activityType === 'SHOPPING' && settings?.allowShopping) ||
    (activityType === 'SWAPPING' && settings?.allowSwapping) ||
    (activityType === 'INVESTING' && settings?.allowInvesting) ||
    (activityType === 'TRANSFER' && settings?.allowTransfers) ||
    activityType === 'GAS_FEE' ||
    activityType === 'OTHER'
  )

  if (!activityAllowed) {
    audit('WALLET_ACTIVITY_NOT_ALLOWED', { agentId, chain, activityType, sessionId })
    return { approved: false, denied: true, reason: `Activity type ${activityType} is not enabled for this wallet` }
  }

  const amountNum = parseFloat(amount)
  const autoLimitNum = parseFloat(settings?.spendLimitAuto ?? '0')
  const maxLimitNum = parseFloat(settings?.spendLimitMax ?? '0')

  // Above max limit — always denied
  if (maxLimitNum > 0 && amountNum > maxLimitNum) {
    audit('WALLET_SPEND_EXCEEDS_MAX', { agentId, chain, amount, maxLimit: settings?.spendLimitMax, sessionId })
    return { approved: false, denied: true, reason: `Amount ${amount} exceeds maximum spend limit of ${settings?.spendLimitMax}` }
  }

  // Record pending transaction
  const txRecord = await prisma.walletTransaction.create({
    data: {
      walletId: wallet.id,
      direction: 'OUT',
      amount,
      token: tokenContract,
      toAddress,
      status: 'PENDING',
      initiatedBy: agentId,
      activityType,
      note
    }
  })

  // Within auto limit and autonomous mode on — execute without approval
  if (settings?.autonomousMode && amountNum <= autoLimitNum) {
    audit('WALLET_AUTONOMOUS_SPEND', { agentId, chain, amount, autoLimit: settings.spendLimitAuto, sessionId })
    return await executeTransaction(wallet, txRecord.id, req)
  }

  // Requires human-in-the-loop approval
  const approval = createApproval(
    sessionId,
    `wallet_${chain.toLowerCase()}_send`,
    `Agent ${agentId} requests to send ${amount} ${chain} to ${toAddress}`,
    { agentId, chain, amount, toAddress, activityType, tokenContract, note },
    `Session: ${sessionId}. Activity: ${activityType}. Note: ${note || 'none'}`,
    amountNum > autoLimitNum * 2 ? 'high' : 'medium'
  )

  await prisma.walletTransaction.update({
    where: { id: txRecord.id },
    data: { status: 'PENDING_APPROVAL', approvalId: approval.id }
  })

  audit('WALLET_SPEND_AWAITING_APPROVAL', { agentId, chain, amount, approvalId: approval.id, sessionId })

  let approved: boolean
  try {
    approved = await waitForApproval(approval.id, Number(process.env.APPROVAL_TIMEOUT_MS) || 300000)
  } catch {
    await prisma.walletTransaction.update({ where: { id: txRecord.id }, data: { status: 'DENIED', failReason: 'Approval timeout' } })
    return { approved: false, denied: true, approvalId: approval.id, reason: 'Approval timeout' }
  }

  if (!approved) {
    await prisma.walletTransaction.update({ where: { id: txRecord.id }, data: { status: 'DENIED', failReason: 'Admin denied' } })
    return { approved: false, denied: true, approvalId: approval.id, reason: 'Admin denied transaction' }
  }

  await prisma.walletTransaction.update({ where: { id: txRecord.id }, data: { status: 'APPROVED' } })
  return await executeTransaction(wallet, txRecord.id, req)
}

async function executeTransaction(
  wallet: { id: string; encryptedKey: string; encryptedSeed: string | null; address: string },
  txRecordId: string,
  req: SpendRequest
): Promise<{ approved: boolean; txHash?: string; reason?: string }> {
  const { agentId, chain, toAddress, amount, activityType, tokenContract, note } = req

  try {
    await prisma.walletTransaction.update({ where: { id: txRecordId }, data: { status: 'BROADCASTING' } })

    let txHash: string

    switch (chain) {
      case 'ETH':
        if (tokenContract) {
          const result = await sendERC20(wallet.encryptedKey, tokenContract, toAddress, amount, agentId, note)
          txHash = result.txHash
        } else {
          const result = await sendETH(wallet.encryptedKey, toAddress, amount, agentId, note)
          txHash = result.txHash
        }
        break
      case 'BTC':
        const btcResult = await sendBTC(wallet.encryptedKey, wallet.address, toAddress, amount, agentId, note)
        txHash = btcResult.txHash
        break
      case 'ZEC':
        const zecResult = await sendZEC(wallet.encryptedKey, wallet.address, toAddress, amount, agentId, note)
        txHash = zecResult.txHash
        break
      case 'XMR':
        if (!wallet.encryptedSeed) throw new Error('XMR requires seed')
        const xmrResult = await sendXMR(wallet.encryptedSeed, toAddress, amount, agentId, note)
        txHash = xmrResult.txHash
        break
      default:
        throw new Error(`Unsupported chain: ${chain}`)
    }

    await prisma.walletTransaction.update({
      where: { id: txRecordId },
      data: { status: 'CONFIRMED', txHash, confirmedAt: new Date() }
    })

    audit('WALLET_TX_COMPLETE', { agentId, chain, txHash, amount, activityType })
    return { approved: true, txHash }

  } catch (err) {
    await prisma.walletTransaction.update({
      where: { id: txRecordId },
      data: { status: 'FAILED', failedAt: new Date(), failReason: String(err) }
    })
    logger.error('Wallet transaction failed', { agentId, chain, amount, error: String(err) })
    throw err
  }
}

export async function updateWalletSettings(
  agentId: AgentId,
  chain: Chain,
  settings: {
    autonomousMode?: boolean
    spendLimitAuto?: string
    spendLimitMax?: string
    allowShopping?: boolean
    allowSwapping?: boolean
    allowInvesting?: boolean
    allowTransfers?: boolean
  },
  updatedBy: string
): Promise<void> {
  const wallet = await prisma.agentWallet.findUnique({ where: { agentId_chain: { agentId, chain } } })
  if (!wallet) throw new Error(`No ${chain} wallet for agent ${agentId}`)

  await prisma.walletSettings.upsert({
    where: { walletId: wallet.id },
    update: { ...settings, updatedBy },
    create: { walletId: wallet.id, ...settings, updatedBy }
  })

  audit('WALLET_SETTINGS_UPDATED', { agentId, chain, settings, updatedBy })
}

export async function getTransactionHistory(agentId: AgentId, chain: Chain, limit = 50): Promise<unknown[]> {
  const wallet = await prisma.agentWallet.findUnique({ where: { agentId_chain: { agentId, chain } } })
  if (!wallet) return []

  return prisma.walletTransaction.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    take: limit
  })
}

