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
SHA-256:  DE0EA7FD1CBC9EBEF1AA44CAECC53D88A3392305E2620D281B09FACEDCB4B724
SHA-512:  B0648C871870C42689A80DDE774DDB69E2ACF9EBC49CF80409BA5E7CFF16521373D83DCCB84BD44D8BFB2B9A754AF01E6D578EA21F19AEA0329312D8AD1ECD46
MD5:      15B7CC39929D79181D523FF541E3F267
File Size: 2394 bytes

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
import { buildTransaction, signTransaction, calculateTransactionId, selectUTXOs, ZcashRPCClient } from '@mayaprotocol/zcash-ts'
import type { UTXO } from '@mayaprotocol/zcash-ts'
import { decrypt } from '../utils/crypto.js'
import { audit, logger } from '../utils/logger.js'
import type { AgentId } from '@prisma/client'

function getRPCClient(): ZcashRPCClient {
  return new ZcashRPCClient({
    host: process.env.ZEC_RPC_HOST || 'localhost',
    port: Number(process.env.ZEC_RPC_PORT) || 8232,
    username: process.env.ZEC_RPC_USER || '',
    password: process.env.ZEC_RPC_PASS || '',
    network: 'mainnet'
  })
}

export async function getZECBalance(address: string): Promise<string> {
  const rpc = getRPCClient()
  const utxos: UTXO[] = await rpc.getUTXOs(address)
  const totalZatoshi = utxos.reduce((sum, u) => sum + u.value, 0)
  return (totalZatoshi / 1e8).toFixed(8)
}

export async function sendZEC(
  encryptedKey: string,
  fromAddress: string,
  toAddress: string,
  amountZEC: string,
  agentId: AgentId,
  note?: string
): Promise<{ txHash: string }> {
  const privateKey = decrypt(encryptedKey, process.env.WALLET_MASTER_SECRET!)
  const rpc = getRPCClient()

  const utxos: UTXO[] = await rpc.getUTXOs(fromAddress)
  if (utxos.length === 0) throw new Error('No confirmed ZEC UTXOs available')

  const amountZatoshi = Math.round(parseFloat(amountZEC) * 1e8)
  const feeZatoshi = 10000

  const selection = selectUTXOs({
    utxos,
    targets: [{ address: toAddress, value: amountZatoshi }],
    changeAddress: fromAddress
  })

  if (!selection) throw new Error('Insufficient ZEC funds for transaction')

  const blockHeight = await rpc.getBlockCount()

  const unsignedTx = buildTransaction({
    inputs: selection.inputs,
    outputs: selection.outputs,
    network: 'mainnet',
    blockHeight
  })

  const signatures = unsignedTx.sighashes.map(hash => {
    // Sign each sighash with private key using secp256k1
    const keyBuffer = Buffer.from(privateKey.replace('0x', ''), 'hex')
    const { sign } = await import('@bitcoinerlab/secp256k1')
    return sign(hash, keyBuffer)
  })

  const signedTx = signTransaction(unsignedTx, signatures, 'mainnet')
  const txId = calculateTransactionId(signedTx)

  await rpc.sendRawTransaction(signedTx)

  audit('ZEC_TX_BROADCAST', { agentId, txHash: txId, to: toAddress, amount: amountZEC, note })

  return { txHash: txId }
}

