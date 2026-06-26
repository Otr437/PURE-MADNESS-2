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
SHA-256:  F77297642F3F32D50DBFD8DCF9A104FEF8C483D37EACE491B4328F5DA72C7AD7
SHA-512:  D683C892FC93C56A706783D8C3CDAADC38EDFFD71547D4F993CB0674E4745473CFEE170469C27E0D4E7E7AEB1AD9D8A267015C8A5AB9A54F796D6E05CD429434
MD5:      832478384830AA839FC80284E0D7A7EC
File Size: 3538 bytes

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
const BASE = 'http://localhost:3001/api'
const FETCH_TIMEOUT_MS = 60000

let csrfToken = null
let csrfFetchedAt = 0
const CSRF_TTL_MS = 30 * 60 * 1000 // refresh every 30 min

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    return res
  } finally {
    clearTimeout(timer)
  }
}

export async function ensureCsrfToken() {
  if (csrfToken && Date.now() - csrfFetchedAt < CSRF_TTL_MS) return csrfToken
  try {
    const res = await fetchWithTimeout('http://localhost:3001/api/csrf-token', { credentials: 'include' })
    if (!res.ok) throw new Error(`CSRF fetch failed: ${res.status}`)
    const data = await res.json()
    csrfToken = data.token
    csrfFetchedAt = Date.now()
    return csrfToken
  } catch (err) {
    console.error('CSRF token fetch failed:', err)
    throw err
  }
}

function buildHeaders(adminToken = null) {
  const h = {
    'Content-Type': 'application/json',
    'x-csrf-token': csrfToken || ''
  }
  if (adminToken) h['x-admin-token'] = adminToken
  return h
}

export async function sendChat(messages, sessionId) {
  await ensureCsrfToken()
  const res = await fetchWithTimeout(`${BASE}/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...buildHeaders(), 'x-session-id': sessionId },
    body: JSON.stringify({ messages, sessionId })
  })
  if (!res.ok) {
    if (res.status === 403) {
      // CSRF expired — refresh and retry once
      csrfToken = null
      await ensureCsrfToken()
      const retry = await fetchWithTimeout(`${BASE}/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...buildHeaders(), 'x-session-id': sessionId },
        body: JSON.stringify({ messages, sessionId })
      })
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({ error: retry.statusText }))
        throw new Error(err.error || `HTTP ${retry.status}`)
      }
      return retry.json()
    }
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getPendingApprovals(adminToken) {
  await ensureCsrfToken()
  const res = await fetchWithTimeout(`${BASE}/approvals/pending`, {
    credentials: 'include',
    headers: buildHeaders(adminToken)
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function resolveApproval(approvalId, approved, adminToken) {
  await ensureCsrfToken()
  const res = await fetchWithTimeout(`${BASE}/approvals/resolve`, {
    method: 'POST',
    credentials: 'include',
    headers: buildHeaders(adminToken),
    body: JSON.stringify({ approvalId, approved })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function getAdminHealth(adminToken) {
  await ensureCsrfToken()
  const res = await fetchWithTimeout(`${BASE}/admin/health`, {
    credentials: 'include',
    headers: buildHeaders(adminToken)
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

