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
SHA-256:  3045A1667AA19A82B9B1785487B522D1270F2D18B5DD0542B20E5101303D8500
SHA-512:  49D859DB8091326AB2ABD1D0985D2D58AF2CA43E026EF4351F3C43A12062BF92FD0A78F4B000AE14DD71AE990EC434D77ABEC0B066C1A25A05A6AE9139140335
MD5:      4367861AD5E80DA6B6F0FD6B9178E05A
File Size: 1742 bytes

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
import moneroTs from 'monero-ts'
import { decrypt } from '../utils/crypto.js'
import { audit, logger } from '../utils/logger.js'
import type { AgentId } from '@prisma/client'

const DAEMON_URI = process.env.XMR_DAEMON_URI || 'http://localhost:18081'

export async function getXMRBalance(address: string, encryptedSeed: string): Promise<string> {
  const seed = decrypt(encryptedSeed, process.env.WALLET_MASTER_SECRET!)

  const wallet = await moneroTs.createWalletFull({
    networkType: moneroTs.MoneroNetworkType.MAINNET,
    seed,
    restoreHeight: Number(process.env.XMR_RESTORE_HEIGHT) || 0,
    server: { uri: DAEMON_URI }
  })

  await wallet.sync()
  const balance = await wallet.getUnlockedBalance()
  await wallet.close()

  return moneroTs.GenUtils.atomicUnitsToXmr(balance).toString()
}

export async function sendXMR(
  encryptedSeed: string,
  toAddress: string,
  amountXMR: string,
  agentId: AgentId,
  note?: string
): Promise<{ txHash: string }> {
  const seed = decrypt(encryptedSeed, process.env.WALLET_MASTER_SECRET!)

  const wallet = await moneroTs.createWalletFull({
    networkType: moneroTs.MoneroNetworkType.MAINNET,
    seed,
    restoreHeight: Number(process.env.XMR_RESTORE_HEIGHT) || 0,
    server: { uri: DAEMON_URI }
  })

  await wallet.sync()

  const atomicAmount = moneroTs.GenUtils.xmrToAtomicUnits(parseFloat(amountXMR))

  audit('XMR_TX_PREPARING', { agentId, to: toAddress, amount: amountXMR, note })

  const tx = await wallet.createTx({
    accountIndex: 0,
    address: toAddress,
    amount: atomicAmount,
    relay: true
  })

  const txHash = await tx.getHash()

  await wallet.close()

  audit('XMR_TX_BROADCAST', { agentId, txHash, to: toAddress, amount: amountXMR })

  return { txHash }
}

