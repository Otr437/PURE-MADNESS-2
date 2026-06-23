'use strict';

/**
 * bot/core/agent.js
 * Autonomous ReAct agent (Reason → Act → Observe → loop).
 *
 * Wires together:
 *   - LLM via Anthropic API (pure Node https)
 *   - Tool registry (32 crypto tools + 8 file tools)
 *   - Session persistence (encrypted key store on disk)
 *   - Conversation memory (persistent JSONL)
 *   - Retry + error recovery (exponential backoff)
 *   - Audit log (tamper-evident hash chain)
 *
 * Zero external npm dependencies.
 */

require('./resolver');

const https    = require('https');
const crypto   = require('crypto');

const CONFIG   = require('../config/config');
const { listTools, callTool, setStore } = require('../tools/registry');
const { audit }          = require('./audit');
const memory             = require('./memory');
const session            = require('./session');
const { withLLMRetry }   = require('./retry');
const { getLogger }      = require('@crypto-monorepo/shared');

const log = getLogger('agent');

// ── Session bootstrap ─────────────────────────────────────────────────────────

let _store = null;

function _initSession() {
  if (_store) return _store;
  const loaded = session.load();
  if (loaded) {
    log.info('Session restored', { keys: loaded.store.list().length, savedAt: new Date(loaded.savedAt).toISOString() });
    _store = loaded.store;
  } else {
    const { SecureKeyStore } = require('@crypto-monorepo/secure-key-store');
    _store = new SecureKeyStore();
    log.info('New session started');
  }
  setStore(_store);
  return _store;
}

// ── System prompt ─────────────────────────────────────────────────────────────

function _buildSystemPrompt(goalId) {
  const tools       = listTools();
  const toolDocs    = tools.map(t =>
    `### ${t.name}\n${t.description}\nParams: ${JSON.stringify(t.parameters)}`
  ).join('\n\n');
  const memCtx      = memory.buildContext(8);
  const keyList     = _store ? _store.list().map(k => k.id) : [];

  return `You are an autonomous cryptography operations agent.
Goal ID: ${goalId}

## Reasoning loop
Respond ONLY with a single valid JSON object — no markdown, no prose, no code fences.

ACTION shape (call a tool):
{"thought":"...","action":"tool_name","params":{...}}

FINAL shape (goal complete):
{"thought":"...","final_answer":"human-readable result"}

## Rules
- Chain tools across steps. Carry results in thought for next step.
- Never put raw private keys in final_answer unless explicitly asked.
- Prefer AES-GCM over AES-CBC for new encryption.
- If a tool fails, reason about why and try an alternative.
- Keys currently in store: [${keyList.join(', ') || 'none'}]

${memCtx}

## Available tools (${tools.length} total)

${toolDocs}`;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function _httpsPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(payload),
        'x-api-key':         CONFIG.apiKey,
        'anthropic-version': '2023-06-01',
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function _callLLM(messages, goalId) {
  if (!CONFIG.apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await _httpsPost({
    model:      CONFIG.model,
    max_tokens: CONFIG.maxTokens,
    system:     _buildSystemPrompt(goalId),
    messages,
  });
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// ── Parse LLM step ────────────────────────────────────────────────────────────

function _parse(raw) {
  const clean = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
  try { return JSON.parse(clean); }
  catch { throw new Error(`LLM returned non-JSON: ${raw.slice(0, 300)}`); }
}

// ── Main agent run ────────────────────────────────────────────────────────────

/**
 * Run the agent toward a natural-language goal.
 *
 * @param {string} goal
 * @param {object} [opts]
 * @param {boolean} [opts.verbose=false]
 * @param {boolean} [opts.saveSession=true]
 * @returns {Promise<{ answer: string, steps: object[], goalId: string }>}
 */
async function run(goal, opts = {}) {
  const verbose     = opts.verbose     ?? false;
  const saveSession = opts.saveSession ?? true;

  _initSession();

  const goalId   = crypto.randomBytes(4).toString('hex');
  const messages = [{ role: 'user', content: goal }];
  const steps    = [];

  memory.append('user', goal, { goalId, tags: ['goal'] });
  audit('agent.run.start', { goalId, goal: goal.slice(0, 100) });
  log.info('Agent started', { goalId, goal: goal.slice(0, 80) });

  try {
    for (let step = 1; step <= CONFIG.maxSteps; step++) {
      log.info(`Step ${step}/${CONFIG.maxSteps}`, { goalId });

      // Call LLM with retry
      const raw = await withLLMRetry(
        (msgs) => _callLLM(msgs, goalId),
        messages,
        { onRetry: (attempt, err) => log.warn('LLM retry', { attempt, error: err.message }) }
      );

      const parsed = _parse(raw);

      if (verbose) {
        console.log(`\n── Step ${step} ──────────────────────────`);
        console.log('THOUGHT:', parsed.thought);
      }

      // ── Terminal ──────────────────────────────────────────────────────────
      if (parsed.final_answer !== undefined) {
        if (verbose) console.log('\nANSWER:', parsed.final_answer);
        steps.push({ step, type: 'final', thought: parsed.thought, answer: parsed.final_answer });
        memory.append('assistant', parsed.final_answer, { goalId, tags: ['answer'] });
        audit('agent.run.complete', { goalId, steps: step, answer: parsed.final_answer.slice(0, 100) });
        log.info('Agent complete', { goalId, steps: step });

        if (saveSession) session.save(_store);
        return { answer: parsed.final_answer, steps, goalId };
      }

      // ── Tool call ─────────────────────────────────────────────────────────
      const { action, params, thought } = parsed;
      if (!action) throw new Error(`Step ${step}: no action and no final_answer`);

      if (verbose) {
        console.log('ACTION:', action);
        console.log('PARAMS:', JSON.stringify(params || {}, null, 2));
      }

      memory.append('assistant', `${thought} → ${action}(${JSON.stringify(params || {})})`, { goalId, action });

      let observation;
      try {
        observation = callTool(action, params || {});
        if (verbose) console.log('RESULT:', JSON.stringify(observation, null, 2));
        audit('agent.tool.ok', { goalId, action, step });
      } catch (err) {
        observation = { ok: false, error: err.message };
        audit('agent.tool.error', { goalId, action, step, error: err.message });
        if (verbose) console.log('ERROR:', err.message);
      }

      steps.push({ step, type: 'action', thought, action, params, observation });
      memory.append('tool', JSON.stringify(observation), { goalId, action });

      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user',      content: `Tool result: ${JSON.stringify(observation)}` });
    }

    throw new Error(`Agent exceeded max steps (${CONFIG.maxSteps})`);

  } catch (err) {
    audit('agent.run.error', { goalId, error: err.message });
    if (saveSession) { try { session.save(_store); } catch {} }
    throw err;
  }
}

/** Expose the current store (for scheduler, peer, etc.) */
function getStore() { return _store; }

module.exports = { run, getStore };
