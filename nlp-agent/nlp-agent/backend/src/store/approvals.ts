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
SHA-256:  C4EA7C475ED6B6A2EF5FE4CFD1DAAA6E13D102A001231F2680A2D0A50BEDCF30
SHA-512:  C35A6CBFD34B3CF98C6A71F81520EA8B4019F4496255E22A1D6187DA59B63969123386C10869F630F20922C85CC5161871FBFB8E6B85283497EB28CFEFE61515
MD5:      BF3A5C6AF889C695DABB63FAB68193BF
File Size: 4626 bytes

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
import { v4 as uuidv4 } from 'uuid'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import type { PendingApproval, RiskLevel } from '../types/index.js'
import { audit, logger } from '../utils/logger.js'

const MAX_STORE_SIZE = 10000
const PERSIST_PATH = path.join(process.env.LOG_DIR || './logs', 'approvals.json')

const store = new Map<string, PendingApproval>()
const waiters = new Map<string, (approved: boolean) => void>()

function loadPersistedApprovals(): void {
  try {
    if (existsSync(PERSIST_PATH)) {
      const entries: PendingApproval[] = JSON.parse(readFileSync(PERSIST_PATH, 'utf-8'))
      for (const entry of entries) store.set(entry.id, entry)
      logger.info('Approvals loaded from disk', { count: entries.length })
    }
  } catch (err) {
    logger.warn('Could not load persisted approvals', { error: String(err) })
  }
}

function persistApprovals(): void {
  try {
    const dir = path.dirname(PERSIST_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(PERSIST_PATH, JSON.stringify(Array.from(store.values()), null, 2), 'utf-8')
  } catch (err) {
    logger.error('Failed to persist approvals', { error: String(err) })
  }
}

function enforceMaxSize(): void {
  if (store.size <= MAX_STORE_SIZE) return
  const toDelete = Array.from(store.values())
    .filter(a => a.status !== 'pending')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, store.size - MAX_STORE_SIZE)
  for (const entry of toDelete) store.delete(entry.id)
  logger.info('Approval store pruned', { removed: toDelete.length, remaining: store.size })
}

export function createApproval(
  sessionId: string,
  tool: string,
  action: string,
  parameters: Record<string, unknown>,
  context: string,
  riskLevel: RiskLevel = 'medium'
): PendingApproval {
  enforceMaxSize()
  const approval: PendingApproval = {
    id: uuidv4(),
    sessionId,
    tool,
    action,
    parameters,
    context,
    riskLevel,
    createdAt: new Date().toISOString(),
    status: 'pending'
  }
  store.set(approval.id, approval)
  persistApprovals()
  audit('APPROVAL_CREATED', { approvalId: approval.id, sessionId, tool, action, riskLevel })
  return approval
}

export function getPending(): PendingApproval[] {
  return Array.from(store.values()).filter(a => a.status === 'pending')
}

export function getAll(limit = 200, offset = 0): { approvals: PendingApproval[]; total: number } {
  const all = Array.from(store.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
  return { approvals: all.slice(offset, offset + limit), total: all.length }
}

export function getById(id: string): PendingApproval | undefined {
  return store.get(id)
}

export function resolve(id: string, approved: boolean, adminId: string): PendingApproval | null {
  const approval = store.get(id)
  if (!approval || approval.status !== 'pending') return null
  approval.status = approved ? 'approved' : 'denied'
  approval.resolvedAt = new Date().toISOString()
  approval.resolvedBy = adminId
  store.set(id, approval)
  persistApprovals()
  audit('APPROVAL_RESOLVED', { approvalId: id, approved, adminId, tool: approval.tool })
  const waiter = waiters.get(id)
  if (waiter) { waiter(approved); waiters.delete(id) }
  return approval
}

export function waitForApproval(id: string, timeoutMs = 300000): Promise<boolean> {
  return new Promise((res, rej) => {
    const approval = store.get(id)
    if (!approval) return rej(new Error('Approval not found'))
    if (approval.status !== 'pending') return res(approval.status === 'approved')
    const timer = setTimeout(() => {
      waiters.delete(id)
      const a = store.get(id)
      if (a && a.status === 'pending') {
        a.status = 'denied'
        a.resolvedAt = new Date().toISOString()
        a.resolvedBy = 'system_timeout'
        store.set(id, a)
        persistApprovals()
      }
      rej(new Error(`Approval timeout for tool: ${approval.tool}`))
    }, timeoutMs)
    waiters.set(id, (approved: boolean) => { clearTimeout(timer); res(approved) })
  })
}

export function cleanupOldApprovals(): void {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  let removed = 0
  for (const [id, a] of store.entries()) {
    if (a.status !== 'pending' && new Date(a.createdAt).getTime() < cutoff) {
      store.delete(id)
      removed++
    }
  }
  if (removed > 0) { persistApprovals(); logger.info('Old approvals cleaned', { removed }) }
}

loadPersistedApprovals()
setInterval(cleanupOldApprovals, 24 * 60 * 60 * 1000)

