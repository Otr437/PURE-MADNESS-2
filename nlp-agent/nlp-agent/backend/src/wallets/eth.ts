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
SHA-256:  E2EFB0A3554EB1E37F6E2200DAD980F56502F91B0071DCF923EC32FD951C49BC
SHA-512:  D6304CDB6CD2EDEAFD6E03D4F9750D136D36F321F8BAA138D709265DCFB3E41D80519C809CDE3E0401148F7BDE2BF5EC50ABB09E10655CBAC8899A6B52269E28
MD5:      2F7C3F2C6EF221E58BEC0C9CA396EC99
File Size: 3735 bytes

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
import { ethers } from 'ethers'
import { decrypt } from '../utils/crypto.js'
import { logger, audit } from '../utils/logger.js'
import type { AgentId } from '@prisma/client'

const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL || 'https://mainnet.infura.io/v3/' + process.env.INFURA_KEY)

function getWallet(encryptedKey: string): ethers.Wallet {
  const privateKey = decrypt(encryptedKey, process.env.WALLET_MASTER_SECRET!)
  return new ethers.Wallet(privateKey, provider)
}

export async function getETHBalance(address: string): Promise<string> {
  const balance = await provider.getBalance(address)
  return ethers.formatEther(balance)
}

export async function getERC20Balance(address: string, tokenContract: string): Promise<string> {
  const abi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']
  const contract = new ethers.Contract(tokenContract, abi, provider)
  const [balance, decimals] = await Promise.all([contract.balanceOf(address), contract.decimals()])
  return ethers.formatUnits(balance, decimals)
}

export async function sendETH(
  encryptedKey: string,
  toAddress: string,
  amountEth: string,
  agentId: AgentId,
  note?: string
): Promise<{ txHash: string; gasUsed: string }> {
  const wallet = getWallet(encryptedKey)

  if (!ethers.isAddress(toAddress)) throw new Error(`Invalid ETH address: ${toAddress}`)

  const valueWei = ethers.parseEther(amountEth)
  const feeData = await provider.getFeeData()

  const tx = await wallet.sendTransaction({
    to: toAddress,
    value: valueWei,
    maxFeePerGas: feeData.maxFeePerGas ?? undefined,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined
  })

  audit('ETH_TX_BROADCAST', { agentId, txHash: tx.hash, to: toAddress, amount: amountEth, note })

  const receipt = await tx.wait(1)
  if (!receipt || receipt.status === 0) throw new Error('ETH transaction failed on-chain')

  audit('ETH_TX_CONFIRMED', { agentId, txHash: tx.hash, gasUsed: receipt.gasUsed.toString() })

  return { txHash: tx.hash, gasUsed: receipt.gasUsed.toString() }
}

export async function sendERC20(
  encryptedKey: string,
  tokenContract: string,
  toAddress: string,
  amount: string,
  agentId: AgentId,
  note?: string
): Promise<{ txHash: string; gasUsed: string }> {
  const wallet = getWallet(encryptedKey)

  if (!ethers.isAddress(toAddress)) throw new Error(`Invalid address: ${toAddress}`)
  if (!ethers.isAddress(tokenContract)) throw new Error(`Invalid token contract: ${tokenContract}`)

  const abi = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)'
  ]
  const contract = new ethers.Contract(tokenContract, abi, wallet)
  const decimals: number = await contract.decimals()
  const amountWei = ethers.parseUnits(amount, decimals)

  const tx = await contract.transfer(toAddress, amountWei)
  audit('ERC20_TX_BROADCAST', { agentId, txHash: tx.hash, token: tokenContract, to: toAddress, amount, note })

  const receipt = await tx.wait(1)
  if (!receipt || receipt.status === 0) throw new Error('ERC20 transaction failed on-chain')

  audit('ERC20_TX_CONFIRMED', { agentId, txHash: tx.hash, gasUsed: receipt.gasUsed.toString() })

  return { txHash: tx.hash, gasUsed: receipt.gasUsed.toString() }
}

export async function estimateETHGas(toAddress: string, amountEth: string): Promise<string> {
  const valueWei = ethers.parseEther(amountEth)
  const gasEstimate = await provider.estimateGas({ to: toAddress, value: valueWei })
  const feeData = await provider.getFeeData()
  const gasCostWei = gasEstimate * (feeData.maxFeePerGas ?? 0n)
  return ethers.formatEther(gasCostWei)
}

