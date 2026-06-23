// ============================================================
// MODULE 2: AUDITOR — COMPLETE PRODUCTION
// Agent: Gemini 2.5 Flash via @google/genai@1.42.0
// Fallback: Amazon Nova via module13 when Gemini fails
// Voice: ElevenLabs via module14 speaks audit results
// Knows about: Module 6 (persists audit logs)
//              Module 9 (emits audit events)
//              Module 13 (Nova fallback)
//              Module 14 (Voice alerts)
// Port: 3002
// Features:
// - Gemini 2.5 Flash with exponential backoff retry (3 attempts)
// - Nova fallback when all Gemini retries fail or quota throttled
// - Content dedup cache (LRU 300 entries, 10min TTL)
// - Solidity static pre-scan (23 rules) before AI — zero cost
// - Per-caller rate tracking and rejection statistics
// - Audit result HMAC signing for tamper detection
// - Concurrent audit queue (max 5 parallel Gemini calls)
// - Webhook notification on critical findings
// - Voice readout via module14 after audit completion
// - Bulk audit endpoint (up to 10 contracts)
// - Signature verification endpoint
// - Re-audit on revision with skipCache flag
// - Gemini quota tracker with auto-fallback
// - Blocked packages list (23 entries)
// - Health check tests actual dependencies
// - Structured logging with request IDs, no secrets in logs
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import crypto from 'crypto';
import { AuditRequest, AuditResult, AuditFinding, HealthStatus } from '../shared/types.js';
import { getTodayISO, getTodayDate, isAuditDateValid, buildRelevanceContext } from '../shared/date-utils.js';
import { internalFetch, verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';

const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 60_000,
});

await fastify.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? '*' });
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (req) => (req.headers['x-forwarded-for'] as string ?? req.ip),
  errorResponseBuilder: (_req, ctx) => ({ error: 'Rate limit exceeded', retryAfter: Math.ceil(ctx.ttl / 1000) + 's' }),
});

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

// Structured logging on every response — no secrets
fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
  fastify.log.info({
    requestId: req.id, method: req.method, url: req.url,
    statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime),
  }, 'auditor request');
});

// Internal-only guard — public paths bypass token check
fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  const publicPaths = ['/health', '/metrics', '/recent', '/static-rules'];
  if (publicPaths.some(p => req.url.startsWith(p)) || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    fastify.log.warn({ requestId: req.id, ip: req.ip }, 'Unauthorized auditor access');
    return reply.status(401).send({ error: 'Internal token required', requestId: req.id });
  }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// ── Content deduplication cache (LRU 300 entries, 10min TTL) ─

const CACHE_MAX = 300;
const CACHE_TTL_MS = 10 * 60 * 1000;
interface AuditCacheEntry { result: AuditResult; expiresAt: number; hits: number }
const auditCache = new Map<string, AuditCacheEntry>();

function auditCacheKey(content: string, contentType: string): string {
  return crypto.createHash('sha256').update(contentType + ':' + content).digest('hex');
}
function getAuditCached(key: string): AuditResult | null {
  const e = auditCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { auditCache.delete(key); return null; }
  e.hits++;
  auditMetrics.cacheHits++;
  return { ...e.result };
}
function setAuditCache(key: string, result: AuditResult) {
  if (auditCache.size >= CACHE_MAX) {
    const oldest = auditCache.keys().next().value;
    if (oldest) auditCache.delete(oldest);
  }
  auditCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS, hits: 0 });
}

// ── Per-caller tracking ───────────────────────────────────────

const callerStats = new Map<string, { audits: number; rejections: number; criticalFindings: number; lastSeen: string }>();
function trackCaller(userId: string | undefined, result: AuditResult) {
  if (!userId) return;
  const s = callerStats.get(userId) ?? { audits: 0, rejections: 0, criticalFindings: 0, lastSeen: '' };
  s.audits++;
  if (!result.passed) s.rejections++;
  s.criticalFindings += result.findings.filter(f => f.severity === 'critical').length;
  s.lastSeen = getTodayISO();
  callerStats.set(userId, s);
}

// ── Concurrent audit queue (max 5 parallel Gemini calls) ──────

let activeAudits = 0;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_AUDITS ?? '5');
const auditWaiters: Array<() => void> = [];
async function withAuditSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeAudits >= MAX_CONCURRENT) {
    await new Promise<void>(resolve => auditWaiters.push(resolve));
  }
  activeAudits++;
  try { return await fn(); } finally {
    activeAudits--;
    auditWaiters.shift()?.();
  }
}

// ── Audit result HMAC signing for tamper detection ────────────

function signAuditResult(result: AuditResult): string {
  const payload = JSON.stringify({
    taskId: result.taskId, passed: result.passed,
    recommendation: result.recommendation, auditedAt: result.auditedAt,
  });
  return crypto.createHmac('sha256', process.env.INTERNAL_SERVICE_TOKEN ?? 'fallback').update(payload).digest('hex');
}

// ── Solidity static pre-scan (23 rules, zero AI cost) ────────

interface StaticRule {
  test: (c: string) => boolean;
  reason: string;
  severity: AuditFinding['severity'];
  category: AuditFinding['category'];
}
const STATIC_SOLIDITY_RULES: StaticRule[] = [
  { test: c => /tx\.origin/.test(c), reason: 'tx.origin used for auth — phishing vulnerability', severity: 'critical', category: 'security' },
  { test: c => /selfdestruct\s*\(/.test(c), reason: 'selfdestruct is deprecated (EIP-6049)', severity: 'critical', category: 'security' },
  { test: c => /suicide\s*\(/.test(c), reason: 'suicide() is deprecated alias for selfdestruct', severity: 'critical', category: 'security' },
  { test: c => /pragma solidity\s*[^0-9]*0\.[0-6]\./.test(c), reason: 'Solidity < 0.7.0 has critical known vulnerabilities', severity: 'critical', category: 'security' },
  { test: c => /["'].*PRIVATE.*KEY.*["']|0x[0-9a-fA-F]{64}/.test(c), reason: 'Possible hardcoded private key in source', severity: 'critical', category: 'security' },
  { test: c => /\.call\{[^}]*value[^}]*\}/.test(c) && !/nonReentrant|ReentrancyGuard/.test(c), reason: 'External call with value — missing reentrancy guard (CEI pattern required)', severity: 'critical', category: 'solidity_vulnerability' },
  { test: c => /@openzeppelin\/contracts@[0-3]\./.test(c), reason: 'OpenZeppelin contracts v1-v3 deprecated — use v5.x', severity: 'critical', category: 'deprecated_package' },
  { test: c => /delegatecall\s*\(/.test(c), reason: 'delegatecall used — verify intent, check reentrancy guard', severity: 'warning', category: 'security' },
  { test: c => /assembly\s*\{/.test(c), reason: 'Inline assembly present — manual security review required', severity: 'warning', category: 'security' },
  { test: c => /block\.timestamp\s*[<>=!]/.test(c), reason: 'block.timestamp comparison — miner can manipulate by ~15s', severity: 'warning', category: 'solidity_vulnerability' },
  { test: c => /block\.number\s*[<>=!]/.test(c), reason: 'block.number for timing — avoid using as time oracle', severity: 'warning', category: 'solidity_vulnerability' },
  { test: c => /abi\.encodePacked\([^)]*,[^)]*\)/.test(c), reason: 'abi.encodePacked with multiple dynamic args — hash collision risk', severity: 'warning', category: 'security' },
  { test: c => /ecrecover\s*\(/.test(c), reason: 'ecrecover — must validate against address(0), consider OpenZeppelin ECDSA', severity: 'warning', category: 'security' },
  { test: c => /payable/.test(c) && !/receive\s*\(\)/.test(c) && !/fallback\s*\(/.test(c), reason: 'Contract is payable but has no receive() or fallback()', severity: 'warning', category: 'solidity_vulnerability' },
  { test: c => /for\s*\([^;]+;[^;]+;[^)]+\)\s*\{[^}]*\.length/.test(c), reason: 'Array .length read in loop — cache to local var for gas savings', severity: 'warning', category: 'quality' },
  { test: c => /mapping\s*\([^)]+\)\s*public/.test(c) && /delete\s+\w+\[/.test(c), reason: 'Public mapping with delete — verify delete is properly authorized', severity: 'warning', category: 'security' },
  { test: c => /\+\+/.test(c) && !/pragma solidity\s*[^;]*0\.8/.test(c) && !/unchecked/.test(c), reason: 'Increment without Solidity 0.8+ overflow protection', severity: 'warning', category: 'solidity_vulnerability' },
  { test: c => /require\s*\(\s*msg\.sender\s*==/.test(c) && !/modifier/.test(c), reason: 'Inline msg.sender check without modifier — consider access control library', severity: 'info', category: 'quality' },
  { test: c => /Ownable/.test(c) && !/Ownable2Step/.test(c), reason: 'Ownable without Ownable2Step — ownership transfer is not two-step', severity: 'info', category: 'security' },
  { test: c => /constructor\s*\([^)]*address/.test(c) && !/address\(0\)/.test(c), reason: 'Address constructor arg not validated for zero address', severity: 'info', category: 'quality' },
  { test: c => !/event\s+/.test(c) && /function\s+\w+\s*\([^)]*\)\s*external/.test(c), reason: 'No events defined — state changes are not logged on-chain', severity: 'info', category: 'quality' },
  { test: c => !/\/\/\//.test(c), reason: 'Missing NatSpec documentation on public functions', severity: 'info', category: 'quality' },
  { test: c => /uint256\s+\w+\s*=\s*now/.test(c), reason: 'now is deprecated — use block.timestamp', severity: 'critical', category: 'security' },
];

function runStaticScan(content: string): { findings: AuditFinding[]; autoReject: boolean } {
  const findings = STATIC_SOLIDITY_RULES
    .filter(rule => rule.test(content))
    .map(rule => ({ severity: rule.severity, category: rule.category, description: rule.reason }));
  return { findings, autoReject: findings.some(f => f.severity === 'critical') };
}

// ── Blocked packages list ─────────────────────────────────────

const BLOCKED_PACKAGES = [
  '@google/generative-ai', 'web3@1.', 'web3@0.', 'truffle', 'embark', 'drizzle',
  'ethers@4.', 'ethers@5.', '@openzeppelin/contracts@3.', '@openzeppelin/contracts@4.',
  'express@4.', 'axios@0.', 'node-fetch@2.', 'ganache-cli', 'ganache@6.',
  'solc@0.4', 'solc@0.5', 'solc@0.6', 'solc@0.7',
  'hardhat@2.0.', 'hardhat@2.1.', 'hardhat@2.2.',
  'remix-solidity', 'web3-providers-ws@1.',
  'ethereumjs-tx@1.', 'ethereumjs-tx@2.',
];
function checkBlockedPackages(content: string): string[] {
  return BLOCKED_PACKAGES.filter(pkg => content.includes(pkg));
}

// ── Gemini quota tracker ──────────────────────────────────────

const geminiQuota = {
  callsThisHour: 0,
  errorsThisHour: 0,
  lastHourReset: Date.now(),
  isThrottled: false,
  throttledUntil: 0,
  track(success: boolean) {
    const now = Date.now();
    if (now - this.lastHourReset > 3_600_000) {
      this.callsThisHour = 0; this.errorsThisHour = 0; this.lastHourReset = now;
    }
    this.callsThisHour++;
    if (!success) this.errorsThisHour++;
    if (this.errorsThisHour >= 10) {
      this.isThrottled = true;
      this.throttledUntil = now + 120_000;
      fastify.log.warn({ errorsThisHour: this.errorsThisHour }, 'Gemini quota throttled — auto-switching to Nova');
    }
    if (this.isThrottled && now > this.throttledUntil) {
      this.isThrottled = false; this.errorsThisHour = 0;
      fastify.log.info('Gemini quota throttle lifted');
    }
  },
  get shouldFallback() { return this.isThrottled; },
};

// ── Nova fallback when Gemini fails ──────────────────────────

async function auditViaNova(req: AuditRequest, requestId: string): Promise<AuditResult> {
  try {
    const res = await internalFetch('module13-nova', '/audit', {
      method: 'POST',
      body: JSON.stringify(req),
    }, 60_000);
    if (res.ok) {
      const result = await res.json() as AuditResult;
      fastify.log.info({ requestId, taskId: req.taskId, passed: result.passed }, 'Nova audit fallback succeeded');
      return { ...result, taskId: req.taskId };
    }
    throw new Error('Nova audit returned HTTP ' + res.status);
  } catch (err) {
    fastify.log.error({ requestId, taskId: req.taskId, err: String(err).slice(0, 200) }, 'Nova audit fallback failed');
    return {
      taskId: req.taskId, passed: false, auditedAt: getTodayISO(), auditDate: getTodayDate(),
      findings: [{ severity: 'critical', category: 'quality', description: 'Both Gemini and Nova unavailable — failing closed. Manual review required.' }],
      recommendation: 'reject', summary: 'All audit providers failed. Manual review required.',
    };
  }
}

// ── Webhook on critical findings ──────────────────────────────

async function notifyWebhookOnCritical(result: AuditResult, webhookUrl?: string) {
  const url = webhookUrl ?? process.env.AUDIT_CRITICAL_WEBHOOK_URL;
  if (!url) return;
  const criticals = result.findings.filter(f => f.severity === 'critical');
  if (criticals.length === 0) return;
  try {
    const payload = JSON.stringify({
      taskId: result.taskId, passed: result.passed,
      criticalFindings: criticals, recommendation: result.recommendation,
      auditedAt: result.auditedAt, signature: signAuditResult(result),
    });
    const sig = 'sha256=' + crypto.createHmac('sha256', process.env.INTERNAL_SERVICE_TOKEN ?? '')
      .update(payload).digest('hex');
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AIOps-Signature': sig, 'X-Audit-Critical': String(criticals.length) },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    fastify.log.info({ taskId: result.taskId, criticalCount: criticals.length }, 'Critical findings webhook delivered');
  } catch (err) {
    fastify.log.warn({ taskId: result.taskId, err: String(err).slice(0, 100) }, 'Critical findings webhook failed — best-effort');
  }
}

// ── Voice readout via module14 ────────────────────────────────

async function speakAuditResult(result: AuditResult) {
  try {
    await internalFetch('module14-voice', '/speak-audit', {
      method: 'POST',
      body: JSON.stringify(result),
    }, 10_000);
  } catch { /* voice is optional — never block audit pipeline */ }
}

// ── Metrics ───────────────────────────────────────────────────

const auditMetrics = {
  totalAudits: 0, passed: 0, rejected: 0, revised: 0,
  cacheHits: 0, solidityAudits: 0, criticalFindings: 0,
  findingsSum: 0, novaFallbacks: 0, staticRejections: 0, totalDurationMs: 0,
};

interface AuditSummary {
  taskId: string; passed: boolean; recommendation: string;
  findingCount: number; criticalCount: number; contentType: string;
  auditedAt: string; durationMs: number; fromCache: boolean;
  usedNova: boolean; staticPreScan: boolean;
}
const recentAudits: AuditSummary[] = [];
function recordAudit(a: AuditSummary) {
  recentAudits.unshift(a);
  if (recentAudits.length > 100) recentAudits.pop();
}

// ── Gemini retry with exponential backoff ─────────────────────

async function callGeminiWithRetry(
  prompt: string, systemInstruction: string, requestId: string, maxRetries = 2
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { systemInstruction, temperature: 0.05, maxOutputTokens: 2000 },
      });
      const text = response.text ?? '{}';
      geminiQuota.track(true);
      fastify.log.debug({ requestId, attempt }, 'Gemini call succeeded');
      return text;
    } catch (err) {
      lastError = err;
      geminiQuota.track(false);
      const msg = String(err);
      // Do not retry on auth errors
      if (msg.includes('401') || msg.includes('API_KEY') || msg.includes('403')) throw err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8_000);
        fastify.log.warn({ requestId, attempt, delay, err: msg.slice(0, 100) }, 'Gemini failed — retrying');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

function extractJSON(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('{')) return t;
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m?.[1]) return m[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s !== -1 && e > s) return t.slice(s, e + 1);
  return '{}';
}

const VALID_SEV = new Set(['info', 'warning', 'critical']);
const VALID_CAT = new Set(['deprecated_package', 'security', 'relevance', 'quality', 'solidity_vulnerability']);
const VALID_REC = new Set(['approve', 'reject', 'revise']);

function normalizeFindings(raw: unknown[]): AuditFinding[] {
  return raw.map((f) => {
    const x = f as Record<string, unknown>;
    return {
      severity: VALID_SEV.has(String(x['severity'])) ? x['severity'] as AuditFinding['severity'] : 'warning',
      category: VALID_CAT.has(String(x['category'])) ? x['category'] as AuditFinding['category'] : 'quality',
      description: String(x['description'] ?? 'No description').slice(0, 500),
      location: x['location'] ? String(x['location']).slice(0, 200) : undefined,
    };
  });
}

async function emitEvent(type: string, payload: Record<string, unknown>) {
  try {
    await internalFetch('module9-events', '/emit', {
      method: 'POST',
      body: JSON.stringify({ type, source: 'module2-auditor', payload, emittedAt: getTodayISO() }),
    }, 3_000);
  } catch { /* best-effort */ }
}

async function persistAuditLog(result: AuditResult, userId?: string) {
  try {
    await internalFetch('module6-database', '/audit-logs', {
      method: 'POST',
      body: JSON.stringify({
        taskId: result.taskId, auditDate: result.auditDate, auditedAt: result.auditedAt,
        passed: result.passed, recommendation: result.recommendation,
        summary: result.summary, findings: result.findings, userId: userId ?? null,
      }),
    }, 3_000);
  } catch { /* best-effort */ }
}

function getSystemInstruction(): string {
  return `You are the Auditor — a strict, date-locked quality and security auditor for a blockchain AI operations system.
${buildRelevanceContext()}

Audit against TODAY's standards (${getTodayDate()}) ONLY.

Respond with ONLY valid JSON, no markdown:
{"passed":true,"findings":[{"severity":"info","category":"quality","description":"...","location":"optional"}],"recommendation":"approve","summary":"one paragraph"}

severity: "info"|"warning"|"critical"
category: "deprecated_package"|"security"|"relevance"|"quality"|"solidity_vulnerability"
recommendation: "approve"|"reject"|"revise"

Rules:
- critical finding → passed:false + reject
- 3+ warnings → revise
- Clean → approve

Solidity-specific:
- CRITICAL: missing access control, reentrancy, integer overflow, unchecked return values
- WARNING: missing events, centralization risk, missing input validation, gas inefficiency
- INFO: consider multi-sig, upgradeability, NatSpec docs`;
}

function getSolidityAuditPrompt(content: string, taskId: string, requestId: string): string {
  return `Perform a comprehensive security audit of this Solidity contract for task ${taskId} [${requestId}].
Audit Date: ${getTodayDate()}

SOLIDITY SOURCE:
---
${content}
---

Check ALL of the following:
1. Access control (missing onlyOwner, wrong modifiers, unauthorized minting)
2. Reentrancy (state changes after .call, .transfer, .send — require CEI pattern)
3. Integer overflow/underflow (require Solidity 0.8+ or SafeMath)
4. Front-running (sandwich attacks, price oracle manipulation)
5. Timestamp manipulation (block.timestamp for timing-critical logic)
6. Gas limit DoS (unbounded loops, transfer to contracts that reject)
7. Centralization risk (single owner, no timelock, single point of failure)
8. Missing events on ALL state-changing functions
9. Incorrect visibility specifiers (public where internal intended)
10. Hardcoded addresses that should be configurable
11. Missing zero-address checks on address parameters
12. Unsafe type casting
13. Token economic logic errors (tax caps, max wallet, supply consistency)
14. MEV exposure (sandwich, frontrun, backrun vectors)
15. Flash loan attack vectors

Return ONLY JSON.`;
}

const AuditSchema = z.object({
  content: z.string().min(1).max(50_000),
  contentType: z.enum(['code', 'output', 'recommendation', 'solidity']),
  taskId: z.string().uuid(),
  auditDate: z.string().optional(),
  userId: z.string().optional(),
  skipCache: z.boolean().default(false),
  webhookUrl: z.string().url().optional(),
});

const BulkAuditSchema = z.object({
  items: z.array(z.object({
    content: z.string().min(1).max(50_000),
    contentType: z.enum(['code', 'output', 'recommendation', 'solidity']),
    taskId: z.string().uuid(),
    userId: z.string().optional(),
  })).min(1).max(10),
});

async function runAudit(
  req: AuditRequest,
  requestId: string,
  skipCache = false,
  webhookUrl?: string,
): Promise<AuditResult> {
  const t0 = Date.now();
  const today = getTodayDate();
  const isSolidity = req.contentType === 'solidity';
  let usedNova = false;
  let staticPreScan = false;
  let result: AuditResult;

  // Step 1: Cache check
  if (!skipCache) {
    const key = auditCacheKey(req.content, req.contentType);
    const cached = getAuditCached(key);
    if (cached) {
      fastify.log.debug({ requestId, taskId: req.taskId }, 'Audit cache hit');
      recordAudit({ taskId: req.taskId, passed: cached.passed, recommendation: cached.recommendation, findingCount: cached.findings.length, criticalCount: cached.findings.filter(f => f.severity === 'critical').length, contentType: req.contentType, auditedAt: getTodayISO(), durationMs: 0, fromCache: true, usedNova: false, staticPreScan: false });
      return { ...cached, taskId: req.taskId, auditedAt: getTodayISO() };
    }
  }

  // Step 2: Solidity static pre-scan (zero AI cost, instant rejection)
  let preScanFindings: AuditFinding[] = [];
  if (isSolidity) {
    staticPreScan = true;
    const scan = runStaticScan(req.content);
    preScanFindings = scan.findings;
    const blocked = checkBlockedPackages(req.content);
    if (blocked.length > 0) {
      preScanFindings.push(...blocked.map(pkg => ({ severity: 'critical' as const, category: 'deprecated_package' as const, description: `Blocked package in use: ${pkg}` })));
    }

    if (scan.autoReject || blocked.length > 0) {
      fastify.log.info({ requestId, taskId: req.taskId, criticals: preScanFindings.filter(f => f.severity === 'critical').length }, 'Static pre-scan auto-rejected — AI call skipped');
      auditMetrics.staticRejections++;
      result = {
        taskId: req.taskId, passed: false, auditedAt: getTodayISO(), auditDate: today,
        findings: preScanFindings, recommendation: 'reject',
        summary: `Static analysis found ${preScanFindings.filter(f => f.severity === 'critical').length} critical issue(s). AI audit skipped to save cost.`,
      };
      // Track, persist, emit, webhook, voice, cache
      auditMetrics.totalAudits++; auditMetrics.rejected++; auditMetrics.solidityAudits++;
      auditMetrics.criticalFindings += preScanFindings.filter(f => f.severity === 'critical').length;
      auditMetrics.findingsSum += preScanFindings.length;
      auditMetrics.totalDurationMs += Date.now() - t0;
      trackCaller(req.userId, result);
      recordAudit({ taskId: req.taskId, passed: false, recommendation: 'reject', findingCount: preScanFindings.length, criticalCount: preScanFindings.filter(f => f.severity === 'critical').length, contentType: req.contentType, auditedAt: getTodayISO(), durationMs: Date.now() - t0, fromCache: false, usedNova: false, staticPreScan: true });
      void persistAuditLog(result, req.userId);
      void emitEvent('task.rejected_by_audit', { taskId: req.taskId, passed: false, recommendation: 'reject', criticalFindings: preScanFindings.filter(f => f.severity === 'critical').length, staticScan: true });
      void notifyWebhookOnCritical(result, webhookUrl);
      void speakAuditResult(result);
      if (!skipCache) setAuditCache(auditCacheKey(req.content, req.contentType), result);
      return result;
    }
  }

  // Step 3: AI audit — Gemini or Nova fallback
  const prompt = isSolidity
    ? getSolidityAuditPrompt(req.content, req.taskId, requestId)
    : `Audit this ${req.contentType} for task ${req.taskId} [${requestId}].\nAudit Date: ${today}\n---\n${req.content}\n---\nReturn ONLY JSON.`;

  if (geminiQuota.shouldFallback) {
    fastify.log.warn({ requestId }, 'Gemini throttled — using Nova directly');
    result = await withAuditSlot(() => auditViaNova(req, requestId));
    usedNova = true;
    auditMetrics.novaFallbacks++;
  } else {
    try {
      const raw = await withAuditSlot(() => callGeminiWithRetry(prompt, getSystemInstruction(), requestId));

      let parsed: { passed: boolean; findings: unknown[]; recommendation: string; summary: string };
      try {
        parsed = JSON.parse(extractJSON(raw));
        if (typeof parsed.passed !== 'boolean') throw new Error('missing passed field');
      } catch {
        fastify.log.warn({ requestId, preview: raw.slice(0, 80) }, 'Gemini parse error — falling back to Nova');
        result = await auditViaNova(req, requestId);
        usedNova = true;
        auditMetrics.novaFallbacks++;
        // skip to finalize
        const durationMs = Date.now() - t0;
        auditMetrics.totalAudits++;
        if (result.passed) auditMetrics.passed++;
        else if (result.recommendation === 'reject') auditMetrics.rejected++;
        else auditMetrics.revised++;
        if (isSolidity) auditMetrics.solidityAudits++;
        auditMetrics.criticalFindings += result.findings.filter(f => f.severity === 'critical').length;
        auditMetrics.findingsSum += result.findings.length;
        auditMetrics.totalDurationMs += durationMs;
        trackCaller(req.userId, result);
        recordAudit({ taskId: req.taskId, passed: result.passed, recommendation: result.recommendation, findingCount: result.findings.length, criticalCount: result.findings.filter(f => f.severity === 'critical').length, contentType: req.contentType, auditedAt: getTodayISO(), durationMs, fromCache: false, usedNova: true, staticPreScan });
        void persistAuditLog(result, req.userId);
        void emitEvent(result.passed ? 'task.completed' : 'task.rejected_by_audit', { taskId: result.taskId, passed: result.passed, recommendation: result.recommendation, durationMs, usedNova: true });
        void notifyWebhookOnCritical(result, webhookUrl);
        void speakAuditResult(result);
        if (!skipCache) setAuditCache(auditCacheKey(req.content, req.contentType), result);
        return result;
      }

      const aiFindings = normalizeFindings(Array.isArray(parsed.findings) ? parsed.findings : []);
      // Merge static findings with AI findings — no duplicates
      const allFindings = [...preScanFindings];
      for (const f of aiFindings) {
        if (!allFindings.some(e => e.description === f.description)) allFindings.push(f);
      }

      const hasCritical = allFindings.some(f => f.severity === 'critical');
      const warningCount = allFindings.filter(f => f.severity === 'warning').length;
      let recommendation = VALID_REC.has(parsed.recommendation) ? parsed.recommendation as AuditResult['recommendation'] : 'reject';
      let passed = parsed.passed;
      if (hasCritical) { passed = false; recommendation = 'reject'; }
      else if (warningCount >= 3 && recommendation === 'approve') recommendation = 'revise';

      result = {
        taskId: req.taskId, passed, auditedAt: getTodayISO(), auditDate: today,
        findings: allFindings, recommendation,
        summary: String(parsed.summary ?? '').slice(0, 1000),
      };
    } catch (err) {
      fastify.log.error({ requestId, err: String(err).slice(0, 200) }, 'Gemini failed — falling back to Nova');
      result = await auditViaNova(req, requestId);
      usedNova = true;
      auditMetrics.novaFallbacks++;
    }
  }

  // Step 4: Track, persist, emit, webhook, voice, cache
  const durationMs = Date.now() - t0;
  auditMetrics.totalAudits++;
  if (result.passed) auditMetrics.passed++;
  else if (result.recommendation === 'reject') auditMetrics.rejected++;
  else auditMetrics.revised++;
  if (isSolidity) auditMetrics.solidityAudits++;
  auditMetrics.criticalFindings += result.findings.filter(f => f.severity === 'critical').length;
  auditMetrics.findingsSum += result.findings.length;
  auditMetrics.totalDurationMs += durationMs;

  trackCaller(req.userId, result);
  recordAudit({ taskId: req.taskId, passed: result.passed, recommendation: result.recommendation, findingCount: result.findings.length, criticalCount: result.findings.filter(f => f.severity === 'critical').length, contentType: req.contentType, auditedAt: getTodayISO(), durationMs, fromCache: false, usedNova, staticPreScan });

  void persistAuditLog(result, req.userId);
  void emitEvent(result.passed ? 'task.completed' : 'task.rejected_by_audit', { taskId: result.taskId, passed: result.passed, recommendation: result.recommendation, criticalFindings: result.findings.filter(f => f.severity === 'critical').length, durationMs, usedNova });
  void notifyWebhookOnCritical(result, webhookUrl);
  void speakAuditResult(result);

  if (!skipCache) setAuditCache(auditCacheKey(req.content, req.contentType), result);

  fastify.log.info({ requestId, taskId: req.taskId, passed: result.passed, recommendation: result.recommendation, findings: result.findings.length, durationMs, usedNova, staticPreScan }, 'Audit complete');

  return result;
}

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => {
  let dbOk = false;
  let eventsOk = false;
  let novaOk = false;
  let voiceOk = false;
  try { const r = await internalFetch('module6-database', '/health', {}, 3_000); dbOk = r.ok; } catch {}
  try { const r = await internalFetch('module9-events', '/health', {}, 3_000); eventsOk = r.ok; } catch {}
  try { const r = await internalFetch('module13-nova', '/health', {}, 3_000); novaOk = r.ok; } catch {}
  try { const r = await internalFetch('module14-voice', '/health', {}, 3_000); voiceOk = r.ok; } catch {}
  return {
    service: 'module2-auditor', agent: 'gemini-2.5-flash',
    status: 'online', date: getTodayDate(), timestamp: getTodayISO(),
    uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
    dependencies: {
      database: dbOk ? 'online' : 'offline',
      events: eventsOk ? 'online' : 'offline',
      nova: novaOk ? 'online' : 'offline',
      voice: voiceOk ? 'online' : 'offline',
    },
    activeAudits,
    queuedAudits: auditWaiters.length,
    geminiQuota: {
      callsThisHour: geminiQuota.callsThisHour,
      errorsThisHour: geminiQuota.errorsThisHour,
      isThrottled: geminiQuota.isThrottled,
    },
  };
});

fastify.get('/metrics', async () => ({
  service: 'module2-auditor', timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  audits: {
    total: auditMetrics.totalAudits, passed: auditMetrics.passed,
    rejected: auditMetrics.rejected, revised: auditMetrics.revised,
    passRate: auditMetrics.totalAudits > 0 ? ((auditMetrics.passed / auditMetrics.totalAudits) * 100).toFixed(1) + '%' : 'N/A',
    solidityAudits: auditMetrics.solidityAudits,
    criticalFindings: auditMetrics.criticalFindings,
    avgFindings: auditMetrics.totalAudits > 0 ? (auditMetrics.findingsSum / auditMetrics.totalAudits).toFixed(1) : '0',
    avgDurationMs: auditMetrics.totalAudits > 0 ? Math.round(auditMetrics.totalDurationMs / auditMetrics.totalAudits) : 0,
    cacheHits: auditMetrics.cacheHits,
    cacheSize: auditCache.size,
    novaFallbacks: auditMetrics.novaFallbacks,
    staticRejections: auditMetrics.staticRejections,
  },
  queue: { active: activeAudits, waiting: auditWaiters.length, maxConcurrent: MAX_CONCURRENT },
  geminiQuota: { callsThisHour: geminiQuota.callsThisHour, errorsThisHour: geminiQuota.errorsThisHour, isThrottled: geminiQuota.isThrottled },
  callers: Object.fromEntries(callerStats),
}));

fastify.get('/recent', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '20'), 100);
  const passedFilter = q['passed'];
  let audits = recentAudits;
  if (passedFilter === 'true') audits = audits.filter(a => a.passed);
  if (passedFilter === 'false') audits = audits.filter(a => !a.passed);
  return { total: audits.length, audits: audits.slice(0, limit) };
});

fastify.get('/static-rules', async () => ({
  count: STATIC_SOLIDITY_RULES.length,
  rules: STATIC_SOLIDITY_RULES.map(r => ({ reason: r.reason, severity: r.severity, category: r.category })),
  blockedPackages: BLOCKED_PACKAGES,
}));

fastify.delete('/cache', async (_req: FastifyRequest, reply: FastifyReply) => {
  const size = auditCache.size;
  auditCache.clear();
  return reply.send({ ok: true, cleared: size, timestamp: getTodayISO() });
});

fastify.post('/audit', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = AuditSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues, requestId });

  const body: AuditRequest = { ...parsed.data, auditDate: getTodayDate() };
  if (!isAuditDateValid(body.auditDate)) {
    return reply.status(422).send({ error: 'Audit date invalid — server clock error', requestId });
  }

  try {
    const result = await runAudit(body, requestId, parsed.data.skipCache, parsed.data.webhookUrl);
    const signature = signAuditResult(result);
    reply.header('X-Audit-Date', result.auditDate);
    reply.header('X-Audit-Passed', String(result.passed));
    reply.header('X-Audit-Recommendation', result.recommendation);
    reply.header('X-Audit-Signature', signature);
    reply.header('X-Request-Id', requestId);
    return reply.status(result.passed ? 200 : 422).send({ ...result, signature });
  } catch (err) {
    fastify.log.error({ requestId, err: String(err).slice(0, 200) }, 'Audit route error');
    return reply.status(500).send({
      taskId: parsed.data.taskId, passed: false, auditedAt: getTodayISO(), auditDate: getTodayDate(),
      findings: [{ severity: 'critical', category: 'quality', description: 'Internal audit error — failing closed' }],
      recommendation: 'reject', summary: 'Audit internal error.', requestId,
    } satisfies AuditResult & { requestId: string });
  }
});

fastify.post('/audit-solidity', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const b = req.body as Record<string, unknown>;
  const source = String(b['source'] ?? b['content'] ?? '');
  const taskId = b['taskId'] ? String(b['taskId']) : crypto.randomUUID();
  const userId = b['userId'] as string | undefined;
  const skipCache = Boolean(b['skipCache']);
  const webhookUrl = b['webhookUrl'] as string | undefined;

  if (!source) return reply.status(400).send({ error: 'source or content required', requestId });
  if (source.length > 50_000) return reply.status(400).send({ error: 'source too large — max 50000 chars', requestId });

  const body: AuditRequest = { content: source, contentType: 'solidity', auditDate: getTodayDate(), taskId, userId };
  try {
    const result = await runAudit(body, requestId, skipCache, webhookUrl);
    const signature = signAuditResult(result);
    reply.header('X-Audit-Passed', String(result.passed));
    reply.header('X-Audit-Recommendation', result.recommendation);
    reply.header('X-Audit-Signature', signature);
    return reply.status(result.passed ? 200 : 422).send({ ...result, signature });
  } catch (err) {
    return reply.status(500).send({
      taskId, passed: false, auditedAt: getTodayISO(), auditDate: getTodayDate(),
      findings: [{ severity: 'critical', category: 'quality', description: String(err).slice(0, 200) }],
      recommendation: 'reject', summary: 'Audit error.',
    } satisfies AuditResult);
  }
});

// POST /bulk-audit — audit up to 10 items, run in parallel with queue
fastify.post('/bulk-audit', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = BulkAuditSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const results = await Promise.allSettled(
    parsed.data.items.map(item =>
      runAudit({ ...item, auditDate: getTodayDate() }, requestId)
    )
  );

  const responses = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : {
      taskId: parsed.data.items[i]!.taskId,
      passed: false, auditedAt: getTodayISO(), auditDate: getTodayDate(),
      findings: [{ severity: 'critical' as const, category: 'quality' as const, description: 'Audit failed for this item' }],
      recommendation: 'reject' as const, summary: 'Bulk audit failed for this item.',
    }
  );

  const allPassed = responses.every(r => r.passed);
  return reply.status(allPassed ? 200 : 207).send({
    allPassed,
    results: responses,
    summary: {
      total: responses.length,
      passed: responses.filter(r => r.passed).length,
      rejected: responses.filter(r => !r.passed).length,
    },
  });
});

// POST /verify-signature — verify audit result was not tampered with
fastify.post('/verify-signature', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const result = b['result'] as AuditResult;
  const signature = String(b['signature'] ?? '');
  if (!result?.taskId || !signature) {
    return reply.status(400).send({ error: 'result and signature required' });
  }
  const expected = signAuditResult(result);
  let diff = 0;
  if (expected.length !== signature.length) {
    return reply.send({ valid: false, taskId: result.taskId, timestamp: getTodayISO() });
  }
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return reply.send({ valid: diff === 0, taskId: result.taskId, timestamp: getTodayISO() });
});

fastify.get('/audit-logs', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const qs = new URLSearchParams();
    if (q['taskId']) qs.set('taskId', q['taskId']);
    if (q['limit']) qs.set('limit', q['limit']);
    if (q['passed']) qs.set('passed', q['passed']);
    const res = await internalFetch('module6-database', `/audit-logs?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
    return { logs: [] };
  } catch { return { logs: [] }; }
});

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      fastify.log.warn('GEMINI_API_KEY not set — Nova fallback will handle all audits');
    }
    await fastify.listen({ port: 3002, host: '0.0.0.0' });
    fastify.log.info('🔍 Auditor online — port 3002');
    fastify.log.info(`📅 ${getTodayDate()} | Gemini 2.5 Flash | Nova fallback | Static rules: ${STATIC_SOLIDITY_RULES.length} | Cache: ${CACHE_MAX} | Queue: ${MAX_CONCURRENT} concurrent | Voice: enabled`);
  } catch (err) { fastify.log.error(err, 'Auditor failed to start'); process.exit(1); }
};
start();
