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
SHA-256:  A382940410B5ECE0DD9A5DC23485AB2C18044319509E9D344033C57E622DB167
SHA-512:  EE0B9302D1CAFBADA0B8A9219976E0B3351FE6A14D5281FD70FEB9BC877576CD74107FC226A669D7884A4BF3A0A54E71A91C89A179CCFA669288E494DBD8B7C9
MD5:      B12726B189996D18B0A0F2F288C19530
File Size: 3360 bytes

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
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import * as ecc from '@bitcoinerlab/secp256k1'
import { decrypt } from '../utils/crypto.js'
import { audit, logger } from '../utils/logger.js'
import type { AgentId } from '@prisma/client'

const ECPair = ECPairFactory(ecc)
const network = bitcoin.networks.bitcoin

interface UTXO {
  txid: string
  vout: number
  value: number
  script: string
}

async function getUTXOs(address: string): Promise<UTXO[]> {
  const url = `${process.env.BTC_API_URL || 'https://blockstream.info/api'}/address/${address}/utxo`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`BTC UTXO fetch failed: ${res.statusText}`)
  const data = await res.json() as Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean } }>
  return data.filter(u => u.status.confirmed).map(u => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    script: bitcoin.address.toOutputScript(address, network).toString('hex')
  }))
}

async function broadcastTx(txHex: string): Promise<string> {
  const url = `${process.env.BTC_API_URL || 'https://blockstream.info/api'}/tx`
  const res = await fetch(url, { method: 'POST', body: txHex })
  if (!res.ok) throw new Error(`BTC broadcast failed: ${await res.text()}`)
  return res.text()
}

export async function getBTCBalance(address: string): Promise<string> {
  const utxos = await getUTXOs(address)
  const totalSats = utxos.reduce((sum, u) => sum + u.value, 0)
  return (totalSats / 1e8).toFixed(8)
}

export async function sendBTC(
  encryptedKey: string,
  fromAddress: string,
  toAddress: string,
  amountBTC: string,
  agentId: AgentId,
  note?: string
): Promise<{ txHash: string }> {
  const privateKey = decrypt(encryptedKey, process.env.WALLET_MASTER_SECRET!)
  const keyPair = ECPair.fromWIF(privateKey, network)
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyPair.publicKey), network })

  const utxos = await getUTXOs(fromAddress)
  if (utxos.length === 0) throw new Error('No confirmed UTXOs available')

  const amountSats = Math.round(parseFloat(amountBTC) * 1e8)
  const feeSats = 1500 // ~10 sat/vbyte for typical tx
  const totalNeeded = amountSats + feeSats

  const selectedUtxos: UTXO[] = []
  let inputTotal = 0
  for (const utxo of utxos.sort((a, b) => b.value - a.value)) {
    selectedUtxos.push(utxo)
    inputTotal += utxo.value
    if (inputTotal >= totalNeeded) break
  }

  if (inputTotal < totalNeeded) throw new Error(`Insufficient BTC balance. Have: ${inputTotal} sats, need: ${totalNeeded} sats`)

  const psbt = new bitcoin.Psbt({ network })

  for (const utxo of selectedUtxos) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: p2wpkh.output!,
        value: utxo.value
      }
    })
  }

  psbt.addOutput({ address: toAddress, value: amountSats })

  const change = inputTotal - amountSats - feeSats
  if (change > 546) psbt.addOutput({ address: fromAddress, value: change })

  psbt.signAllInputs(keyPair)
  psbt.finalizeAllInputs()

  const txHex = psbt.extractTransaction().toHex()
  audit('BTC_TX_SIGNING', { agentId, to: toAddress, amount: amountBTC, note })

  const txHash = await broadcastTx(txHex)
  audit('BTC_TX_BROADCAST', { agentId, txHash, to: toAddress, amount: amountBTC })

  return { txHash }
}

