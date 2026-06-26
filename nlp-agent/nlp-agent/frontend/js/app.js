/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2026 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-03-07 12:21:26
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  FF66C3E6FB81009CA283BDD1DD0C8A2E47C81F00C50F4E27C0340A2D59DC686A
SHA-512:  2A346D9539D18FCFCC1C1062C5CAF6CD74E39B2C18EB4BBFC7B0228DD3B59659EBC2F239134418E41A9352F45C76292C380326EC7A9EA3307E8B73784C77D83D
MD5:      6022D48FBF74872367E3CD8F0993AE1C
File Size: 8939 bytes

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
import { ensureCsrfToken, sendChat, getPendingApprovals, resolveApproval, getAdminHealth } from './api.js'

const SESSION_ID = crypto.randomUUID().replace(/-/g, '')
const MAX_HISTORY_MESSAGES = 100

let conversationHistory = []
let adminToken = ''
let approvalPollInterval = null

const messagesEl = document.getElementById('messages')
const textareaEl = document.getElementById('input-textarea')
const sendBtn = document.getElementById('send-btn')
const approvalsList = document.getElementById('approvals-list')
const approvalsBadge = document.getElementById('approvals-badge')
const adminTokenInput = document.getElementById('admin-token-input')
const sessionDisplay = document.getElementById('session-display')
const mcpDot = document.getElementById('mcp-dot')
const mcpStatus = document.getElementById('mcp-status')

async function init() {
  sessionDisplay.textContent = SESSION_ID.slice(0, 18) + '...'
  try {
    await ensureCsrfToken()
  } catch (err) {
    showToast('Warning: Could not connect to backend — ' + err.message, 6000)
  }
  startApprovalPolling()
}

function showToast(msg, duration = 3000) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), duration)
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function appendUserMessage(text) {
  const div = document.createElement('div')
  div.className = 'msg user'
  div.innerHTML = `
    <div class="bubble">${escHtml(text)}</div>
    <div class="meta">${new Date().toLocaleTimeString()}</div>
  `
  messagesEl.appendChild(div)
  scrollToBottom()
}

function showTyping() {
  const div = document.createElement('div')
  div.className = 'msg assistant'
  div.id = 'typing-indicator'
  div.innerHTML = `<div class="typing"><span></span><span></span><span></span></div>`
  messagesEl.appendChild(div)
  scrollToBottom()
}

function hideTyping() {
  document.getElementById('typing-indicator')?.remove()
}

function appendAssistantMessage(response) {
  hideTyping()
  const { synthesized, contributions, toolsUsed, pendingApprovals } = response

  const toolInfo = toolsUsed?.length > 0
    ? `<div class="meta">${toolsUsed.length} tool(s) executed</div>`
    : ''

  const pendingInfo = pendingApprovals?.length > 0
    ? `<div class="meta" style="color:var(--warn)">⏳ ${pendingApprovals.length} approval(s) pending in admin panel</div>`
    : ''

  const div = document.createElement('div')
  div.className = 'msg assistant'
  div.innerHTML = `
    <div class="bubble">${escHtml(synthesized || '')}</div>
    ${toolInfo}${pendingInfo}
    <div class="meta">${new Date().toLocaleTimeString()}</div>
    <div class="contributions">
      <button class="contributions-toggle" onclick="toggleContributions(this)">Show model contributions</button>
      <div class="contributions-panel hidden">
        <div class="contribution claude">
          <div class="provider-label">Claude (claude-opus-4-5)</div>
          <div class="text">${escHtml(contributions?.claude || '(no response)')}</div>
        </div>
        <div class="contribution openai">
          <div class="provider-label">GPT (gpt-4o)</div>
          <div class="text">${escHtml(contributions?.openai || '(no response)')}</div>
        </div>
        <div class="contribution deepseek">
          <div class="provider-label">DeepSeek (deepseek-chat)</div>
          <div class="text">${escHtml(contributions?.deepseek || '(no response)')}</div>
        </div>
      </div>
    </div>
  `
  messagesEl.appendChild(div)
  scrollToBottom()
  if (pendingApprovals?.length > 0 && adminToken) renderApprovals()
}

window.toggleContributions = function (btn) {
  const panel = btn.nextElementSibling
  const hidden = panel.classList.toggle('hidden')
  btn.textContent = hidden ? 'Show model contributions' : 'Hide model contributions'
}

async function sendMessage() {
  const text = textareaEl.value.trim()
  if (!text || sendBtn.disabled) return

  textareaEl.value = ''
  textareaEl.style.height = 'auto'
  sendBtn.disabled = true

  const userMsg = { role: 'user', content: text, timestamp: new Date().toISOString() }
  conversationHistory.push(userMsg)

  // Cap history in memory
  if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES)
  }

  appendUserMessage(text)
  showTyping()

  try {
    const response = await sendChat(conversationHistory, SESSION_ID)
    const assistantMsg = {
      role: 'assistant',
      content: response.synthesized || '',
      timestamp: response.timestamp || new Date().toISOString()
    }
    conversationHistory.push(assistantMsg)
    appendAssistantMessage(response)
  } catch (err) {
    hideTyping()
    showToast('Error: ' + err.message, 6000)
    const errDiv = document.createElement('div')
    errDiv.className = 'msg assistant'
    errDiv.innerHTML = `<div class="bubble" style="border-color:var(--danger);color:var(--danger)">❌ ${escHtml(err.message)}</div>`
    messagesEl.appendChild(errDiv)
    scrollToBottom()
    // Remove failed user message from history
    conversationHistory = conversationHistory.filter(m => m !== userMsg)
  } finally {
    sendBtn.disabled = false
    textareaEl.focus()
  }
}

async function renderApprovals() {
  if (!adminToken) {
    approvalsList.innerHTML = `<div class="no-approvals">Enter admin token below to manage approvals</div>`
    approvalsBadge.textContent = ''
    approvalsBadge.className = 'badge zero'
    return
  }

  try {
    const { approvals } = await getPendingApprovals(adminToken)
    approvalsBadge.textContent = approvals.length || ''
    approvalsBadge.className = approvals.length ? 'badge' : 'badge zero'

    if (approvals.length === 0) {
      approvalsList.innerHTML = `<div class="no-approvals">No pending approvals ✓</div>`
      return
    }

    approvalsList.innerHTML = ''
    for (const a of approvals) {
      const card = document.createElement('div')
      card.className = 'approval-card'
      card.id = `approval-${a.id}`
      let paramsStr = ''
      try { paramsStr = JSON.stringify(a.parameters, null, 2) } catch { paramsStr = String(a.parameters) }
      card.innerHTML = `
        <div class="tool-name">${escHtml(a.tool)}</div>
        <div class="action-text">${escHtml(a.action)}</div>
        <div class="params">${escHtml(paramsStr)}</div>
        <div class="action-text" style="font-size:0.72rem;color:var(--text2)">${escHtml(a.context)}</div>
        <div class="risk ${escHtml(a.riskLevel)}">Risk: ${escHtml(a.riskLevel?.toUpperCase())}</div>
        <div class="actions">
          <button class="approve-btn" onclick="handleApproval('${escHtml(a.id)}', true)">✓ Approve</button>
          <button class="deny-btn" onclick="handleApproval('${escHtml(a.id)}', false)">✗ Deny</button>
        </div>
      `
      approvalsList.appendChild(card)
    }
  } catch (err) {
    approvalsList.innerHTML = `<div class="no-approvals" style="color:var(--danger)">Error: ${escHtml(err.message)}</div>`
  }
}

window.handleApproval = async function (approvalId, approved) {
  const card = document.getElementById(`approval-${approvalId}`)
  if (card) {
    card.style.opacity = '0.5'
    card.querySelectorAll('button').forEach(b => { b.disabled = true })
  }
  try {
    await resolveApproval(approvalId, approved, adminToken)
    showToast(approved ? '✓ Tool approved — executing' : '✗ Tool denied')
    await renderApprovals()
  } catch (err) {
    showToast('Error: ' + err.message, 5000)
    if (card) {
      card.style.opacity = '1'
      card.querySelectorAll('button').forEach(b => { b.disabled = false })
    }
  }
}

function startApprovalPolling() {
  if (approvalPollInterval) clearInterval(approvalPollInterval)
  approvalPollInterval = setInterval(() => {
    if (adminToken) renderApprovals().catch(() => {})
  }, 5000)
}

adminTokenInput.addEventListener('input', async () => {
  adminToken = adminTokenInput.value.trim()
  await renderApprovals()
  if (adminToken.length >= 32) {
    try {
      const health = await getAdminHealth(adminToken)
      mcpDot.className = 'dot' + (health.mcp?.online ? '' : ' offline')
      mcpStatus.textContent = health.mcp?.online ? 'MCP online' : 'MCP offline'
    } catch {
      mcpDot.className = 'dot offline'
      mcpStatus.textContent = 'Auth failed'
    }
  }
})

textareaEl.addEventListener('input', () => {
  textareaEl.style.height = 'auto'
  textareaEl.style.height = Math.min(textareaEl.scrollHeight, 160) + 'px'
})

textareaEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})

sendBtn.addEventListener('click', sendMessage)

init()

