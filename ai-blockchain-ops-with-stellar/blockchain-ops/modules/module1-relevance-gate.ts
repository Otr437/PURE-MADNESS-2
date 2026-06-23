/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:40:57
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  7CCF3BF6F45C46F70C49B82814641F3792DD5A17DC3639F31B7511FC60AEA699
SHA-512:  EDC5F2D59ACD371A6AD67386E128FA2CE4748770C860DF5A03E53F2713AE907251896302EC9319B6DDD2AFBF34B5A26B257ECA58AE2B25A714347EB9FC6D6C95
MD5:      015A3118C8990B10B4B4ADAB8DD9F67F
File Size: 9720 bytes

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
// ============================================================
// MODULE 1: RELEVANCE GATE
// Agent: DeepSeek via openai@6.22.0 baseURL swap
// Knows about: Module 6 (persists gate decisions)
//              Module 9 (emits circuit breaker events)
// Port: 3001
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import OpenAI from 'openai';
import { z } from 'zod';
import crypto from 'crypto';
import { RelevanceRequest, RelevanceResult, HealthStatus } from '../shared/types.js';
import { getTodayISO, getTodayDate, buildRelevanceContext } from '../shared/date-utils.js';
import { internalFetch, verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';

const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 35_000,
});

await fastify.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? '*' });
await fastify.register(rateLimit, {
  max: 200,
  timeWindow: '1 minute',
  keyGenerator: (req) => (req.headers['x-forwarded-for'] as string ?? req.ip),
  errorResponseBuilder: (_req, ctx) => ({ error: 'Rate limit exceeded', retryAfter: Math.ceil(ctx.ttl / 1000) + 's' }),
});

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

// ── Structured request/response logging — no secrets ─────────

fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
  fastify.log.info({
    requestId: req.id,
    method: req.method,
    url: req.url,
    statusCode: reply.statusCode,
    durationMs: Math.round(reply.elapsedTime),
    ip: req.ip,
  }, 'gate request');
});

// ── Internal-only guard ───────────────────────────────────────

fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  const publicPaths = ['/health', '/circuit', '/metrics', '/decisions', '/stats/callers'];
  if (publicPaths.some(p => req.url.startsWith(p)) || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    fastify.log.warn({ requestId: req.id, ip: req.ip, url: req.url }, 'Unauthorized gate access');
    return reply.status(401).send({ error: 'Internal token required', requestId: req.id });
  }
});

// ── DeepSeek client ───────────────────────────────────────────

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  baseURL: 'https://api.deepseek.com',
  timeout: 25_000,
  maxRetries: 0, // we handle retries manually with backoff
});

// ── DeepSeek with manual exponential backoff retry ────────────

async function callDeepSeekWithRetry(systemPrompt: string, userMessage: string, requestId: string, maxRetries = 2): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const completion = await deepseek.chat.completions.create({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
        temperature: 0.05,
        max_tokens: 500,
      });
      const text = completion.choices[0]?.message?.content ?? '{}';
      fastify.log.debug({ requestId, attempt, tokens: completion.usage?.total_tokens }, 'DeepSeek call succeeded');
      return text;
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      // Do not retry on auth errors
      if (msg.includes('401') || msg.includes('403') || msg.includes('invalid_api_key')) throw err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8_000);
        fastify.log.warn({ requestId, attempt, delay, err: msg.slice(0, 200) }, 'DeepSeek call failed — retrying');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Nova fallback (called when DeepSeek circuit opens) ────────

async function checkViaNova(req: RelevanceRequest, requestId: string): Promise<RelevanceResult> {
  try {
    fastify.log.info({ requestId, taskId: req.taskId }, 'Gate falling back to Nova');
    const res = await internalFetch('module13-nova', '/gate/check', {
      method: 'POST',
      body: JSON.stringify({ content: req.content, contentType: req.contentType, submittedBy: req.submittedBy, taskId: req.taskId }),
    }, 30_000);
    if (res.ok) {
      const result = await res.json() as RelevanceResult;
      fastify.log.info({ requestId, approved: result.approved, score: result.score }, 'Nova gate fallback succeeded');
      return result;
    }
    throw new Error('Nova returned HTTP ' + res.status);
  } catch (err) {
    fastify.log.error({ requestId, err: String(err).slice(0, 200) }, 'Nova gate fallback failed');
    return {
      approved: false, score: 0,
      reason: 'All gate providers failed — failing closed for safety',
      flaggedIssues: ['DeepSeek circuit open', 'Nova fallback unavailable'],
      checkedAt: getTodayISO(), relevanceDate: getTodayDate(),
    };
  }
}

// ── Webhook on critical rejections ────────────────────────────

async function notifyWebhookOnReject(result: RelevanceResult, req: RelevanceRequest) {
  const webhookUrl = process.env.GATE_REJECT_WEBHOOK_URL;
  if (!webhookUrl || result.approved || result.score > 30) return; // only notify on severe rejections
  try {
    const payload = JSON.stringify({ score: result.score, reason: result.reason, flaggedIssues: result.flaggedIssues, contentType: req.contentType, submittedBy: req.submittedBy, taskId: req.taskId, checkedAt: result.checkedAt });
    const sig = 'sha256=' + crypto.createHmac('sha256', process.env.INTERNAL_SERVICE_TOKEN ?? '').update(payload).digest('hex');
    await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AIOps-Signature': sig }, body: payload, signal: AbortSignal.timeout(8_000) });
  } catch { /* best-effort */ }
}

// ── Voice alert helper ────────────────────────────────────────

async function speakAlert(text: string) {
  try {
    await internalFetch('module14-voice', '/speak-text', { method: 'POST', body: JSON.stringify({ text }) }, 10_000);
  } catch { /* voice is optional — never block gate */ }
}

// ── Circuit breaker with Nova fallback and voice alerts ───────

const circuit = {
  failures: 0,
  threshold: parseInt(process.env.CIRCUIT_THRESHOLD ?? '5'),
  cooldownMs: parseInt(process.env.CIRCUIT_COOLDOWN_MS ?? '60000'),
  openUntil: 0,
  wasOpen: false,
  totalTrips: 0,
  isOpen(): boolean {
    if (this.failures >= this.threshold) {
      if (Date.now() < this.openUntil) return true;
      this.failures = 0; // cooldown expired — half-open
      return false;
    }
    return false;
  },
  recordSuccess() {
    const wasOpenBefore = this.wasOpen;
    this.failures = 0;
    this.wasOpen = false;
    if (wasOpenBefore) {
      void emitEvent('gate.circuit_closed', { threshold: this.threshold, totalTrips: this.totalTrips });
      void speakAlert('Gate circuit breaker closed. DeepSeek is back online.');
      fastify.log.info({ totalTrips: this.totalTrips }, 'Gate circuit closed — DeepSeek recovered');
    }
  },
  recordFailure() {
    this.failures++;
    this.openUntil = Date.now() + this.cooldownMs;
    if (!this.wasOpen && this.failures >= this.threshold) {
      this.wasOpen = true;
      this.totalTrips++;
      metrics.circuitTrips++;
      void emitEvent('gate.circuit_opened', { failures: this.failures, openUntilMs: this.openUntil, totalTrips: this.totalTrips });
      void speakAlert('Warning. Gate circuit breaker opened. DeepSeek is failing. Amazon Nova is now handling gate checks.');
      fastify.log.error({ failures: this.failures, cooldownMs: this.cooldownMs, totalTrips: this.totalTrips }, 'Gate circuit OPENED — Nova fallback active');
    }
  },
  reset() {
    const wasOpen = this.wasOpen;
    this.failures = 0;
    this.openUntil = 0;
    this.wasOpen = false;
    if (wasOpen) {
      void emitEvent('gate.circuit_closed', { manual: true });
      fastify.log.info('Gate circuit manually reset');
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────

async function emitEvent(type: string, payload: Record<string, unknown>) {
  try {
    await internalFetch('module9-events', '/emit', {
      method: 'POST',
      body: JSON.stringify({ type, source: 'module1-relevance-gate', payload, emittedAt: getTodayISO() }),
    }, 3_000);
  } catch { /* best-effort */ }
}

async function persistDecision(req: RelevanceRequest, result: RelevanceResult, taskId?: string) {
  try {
    await internalFetch('module6-database', '/gate-decisions', {
      method: 'POST',
      body: JSON.stringify({
        taskId: taskId ?? null,
        contentType: req.contentType,
        approved: result.approved,
        score: result.score,
        reason: result.reason,
        flaggedIssues: result.flaggedIssues,
        checkedAt: result.checkedAt,
        relevanceDate: result.relevanceDate,
        submittedBy: req.submittedBy,
      }),
    }, 3_000);
  } catch { /* best-effort */ }
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

// ── System prompt ─────────────────────────────────────────────

function getSystemPrompt(): string {
  return `You are the Relevance Gate — a strict security and quality filter.
${buildRelevanceContext()}

Respond with ONLY valid JSON, no markdown:
{"approved":true,"score":95,"reason":"one sentence","flaggedIssues":[]}

Rules:
- score 0-100. approved=false if score<70 OR any blocked package found
- REJECT immediately: @google/generative-ai, express@4.x, axios<1.7.0, hardcoded secrets, HTTP external calls`;
}

// ── LRU cache ─────────────────────────────────────────────────

const CACHE_MAX = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry { result: RelevanceResult; expiresAt: number; hits: number }
const decisionCache = new Map<string, CacheEntry>();
function cacheKey(content: string, contentType: string): string {
  return crypto.createHash('sha256').update(contentType + ':' + content).digest('hex');
}
function getCached(key: string): RelevanceResult | null {
  const e = decisionCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { decisionCache.delete(key); return null; }
  e.hits++;
  return e.result;
}
function setCache(key: string, result: RelevanceResult) {
  if (decisionCache.size >= CACHE_MAX) {
    const oldest = decisionCache.keys().next().value;
    if (oldest) decisionCache.delete(oldest);
  }
  decisionCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS, hits: 0 });
}

// ── Metrics ───────────────────────────────────────────────────

const metrics = { totalChecks: 0, approved: 0, rejected: 0, cacheHits: 0, circuitTrips: 0, solidityRejections: 0, packageRejections: 0, avgScoreSum: 0 };
const callerStats = new Map<string, { calls: number; rejections: number; lastSeen: string }>();
function trackCaller(submittedBy: string, approved: boolean) {
  const s = callerStats.get(submittedBy) ?? { calls: 0, rejections: 0, lastSeen: '' };
  s.calls++; if (!approved) s.rejections++; s.lastSeen = getTodayISO();
  callerStats.set(submittedBy, s);
}

// ── Recent decisions ring buffer ──────────────────────────────

interface DecisionRecord {
  requestId: string; taskId?: string; contentType: string; submittedBy: string;
  approved: boolean; score: number; reason: string; flaggedIssues: string[];
  checkedAt: string; fromCache: boolean; durationMs: number;
}
const recentDecisions: DecisionRecord[] = [];
function recordDecision(d: DecisionRecord) {
  recentDecisions.unshift(d);
  if (recentDecisions.length > 200) recentDecisions.pop();
}

// ── Solidity static security rules ───────────────────────────

interface SolidityRule { test: (c: string) => boolean; reason: string; severity: 'critical' | 'warning' }
const SOLIDITY_RULES: SolidityRule[] = [
  { test: (c) => /tx\.origin/.test(c), reason: 'tx.origin used for auth — phishing vulnerability', severity: 'critical' },
  { test: (c) => /selfdestruct\s*\(/.test(c), reason: 'selfdestruct deprecated EIP-6049', severity: 'critical' },
  { test: (c) => /suicide\s*\(/.test(c), reason: 'suicide() is selfdestruct alias — deprecated', severity: 'critical' },
  { test: (c) => /pragma solidity\s*[^0-9]*0\.[0-6]\./.test(c), reason: 'Solidity version below 0.7.0 — critical vulnerabilities', severity: 'critical' },
  { test: (c) => /private.{0,20}key|PRIVATE_KEY\s*=\s*['"0x]/.test(c), reason: 'Possible hardcoded private key', severity: 'critical' },
  { test: (c) => /delegatecall\s*\(/.test(c), reason: 'delegatecall — verify intent and reentrancy guard', severity: 'warning' },
  { test: (c) => /assembly\s*\{/.test(c), reason: 'Inline assembly — requires manual review', severity: 'warning' },
  { test: (c) => /block\.timestamp\s*[<>=!]/.test(c), reason: 'block.timestamp comparison — miner manipulation risk', severity: 'warning' },
  { test: (c) => /\.call\{[^}]*value/.test(c), reason: 'Low-level .call with value — verify CEI pattern', severity: 'warning' },
  { test: (c) => /abi\.encodePacked\s*\([^)]*,\s*[^)]*\)/.test(c), reason: 'abi.encodePacked multi dynamic args — hash collision risk', severity: 'warning' },
];

function runSolidityStaticAnalysis(content: string): { issues: string[]; autoReject: boolean } {
  const issues: string[] = [];
  let autoReject = false;
  for (const rule of SOLIDITY_RULES) {
    if (rule.test(content)) {
      issues.push('[' + rule.severity.toUpperCase() + '] ' + rule.reason);
      if (rule.severity === 'critical') autoReject = true;
    }
  }
  return { issues, autoReject };
}

// ── Package blocklist ─────────────────────────────────────────

const BLOCKED_PACKAGES: { name: string; reason: string }[] = [
  { name: '@google/generative-ai', reason: 'Deprecated Aug 2025 — use @google/genai@1.42.0' },
  { name: 'express@4', reason: 'Deprecated — use fastify@5.x' },
  { name: 'web3@1', reason: 'Deprecated — use ethers@6.x or viem@2.x' },
  { name: 'ethers@5', reason: 'Deprecated — use ethers@6.x' },
  { name: 'truffle', reason: 'Truffle deprecated — use Hardhat or Foundry' },
  { name: '@openzeppelin/contracts@4', reason: 'OZ v4 deprecated — use @openzeppelin/contracts@5.x' },
  { name: 'node-fetch@2', reason: 'Deprecated — use native fetch (Node 22)' },
  { name: 'request@', reason: 'request package unmaintained' },
];

function checkPackageBlocklist(content: string): string[] {
  return BLOCKED_PACKAGES.filter(p => content.includes(p.name)).map(p => p.name + ': ' + p.reason);
}

// ── Schemas ───────────────────────────────────────────────────

const CheckSchema = z.object({
  content: z.string().min(1).max(50_000),
  contentType: z.enum(['code', 'package', 'prompt', 'audit', 'output', 'solidity', 'transaction']),
  submittedBy: z.enum(['orchestrator', 'auditor', 'human', 'mcp', 'blockchain']),
  taskId: z.string().uuid().optional(),
  metadata: z.record(z.string()).optional(),
  skipCache: z.boolean().optional(),
});

const BulkCheckSchema = z.object({
  items: z.array(z.object({
    content: z.string().min(1).max(50_000),
    contentType: z.enum(['code', 'package', 'prompt', 'audit', 'output', 'solidity', 'transaction']),
    submittedBy: z.enum(['orchestrator', 'auditor', 'human', 'mcp', 'blockchain']),
    taskId: z.string().uuid().optional(),
  })).min(1).max(10),
});

// ── Core check ────────────────────────────────────────────────

async function checkRelevance(req: RelevanceRequest, requestId: string, skipCache = false): Promise<{ result: RelevanceResult; fromCache: boolean; durationMs: number }> {
  const t0 = Date.now();
  const isSolidity = req.contentType === 'solidity' || (req.contentType === 'code' && req.content.includes('pragma solidity'));

  // Static pre-check — no API cost
  if (isSolidity) {
    const staticCheck = runSolidityStaticAnalysis(req.content);
    if (staticCheck.autoReject) {
      metrics.solidityRejections++;
      return {
        result: { approved: false, score: 0, reason: 'Solidity static analysis: critical security issue', flaggedIssues: staticCheck.issues, checkedAt: getTodayISO(), relevanceDate: getTodayDate() },
        fromCache: false, durationMs: Date.now() - t0,
      };
    }
  }

  const blockedPkgs = checkPackageBlocklist(req.content);
  if (blockedPkgs.length > 0) {
    metrics.packageRejections++;
    return {
      result: { approved: false, score: 0, reason: 'Blocked packages: ' + blockedPkgs.map(p => p.split(':')[0]).join(', '), flaggedIssues: blockedPkgs, checkedAt: getTodayISO(), relevanceDate: getTodayDate() },
      fromCache: false, durationMs: Date.now() - t0,
    };
  }

  // Cache
  if (!skipCache) {
    const key = cacheKey(req.content, req.contentType);
    const cached = getCached(key);
    if (cached) { metrics.cacheHits++; return { result: cached, fromCache: true, durationMs: Date.now() - t0 }; }
  }

  // Circuit breaker
  if (circuit.isOpen()) {
    metrics.circuitTrips++;
    return {
      result: { approved: false, score: 0, reason: 'Circuit breaker open — DeepSeek unavailable', flaggedIssues: ['Circuit breaker open'], checkedAt: getTodayISO(), relevanceDate: getTodayDate() },
      fromCache: false, durationMs: Date.now() - t0,
    };
  }

  // DeepSeek call
  try {
    const completion = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: `Check this ${req.contentType} from ${req.submittedBy} [${requestId}]:\n---\n${req.content}\n---\nReturn ONLY JSON.` },
      ],
      temperature: 0.05,
      max_tokens: 500,
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    let parsed: { approved: boolean; score: number; reason: string; flaggedIssues: string[] };

    try {
      parsed = JSON.parse(extractJSON(raw));
      if (typeof parsed.approved !== 'boolean' || typeof parsed.score !== 'number') throw new Error('bad shape');
      if (parsed.score < 70) parsed.approved = false;
      if (isSolidity) {
        const staticCheck = runSolidityStaticAnalysis(req.content);
        if (staticCheck.issues.length > 0) parsed.flaggedIssues = [...(parsed.flaggedIssues ?? []), ...staticCheck.issues];
      }
    } catch {
      circuit.recordFailure();
      return {
        result: { approved: false, score: 0, reason: 'Parse error — failing closed', flaggedIssues: ['Unparseable response'], checkedAt: getTodayISO(), relevanceDate: getTodayDate() },
        fromCache: false, durationMs: Date.now() - t0,
      };
    }

    circuit.recordSuccess();
    const result: RelevanceResult = {
      approved: parsed.approved,
      score: Math.max(0, Math.min(100, parsed.score)),
      reason: String(parsed.reason ?? ''),
      flaggedIssues: Array.isArray(parsed.flaggedIssues) ? parsed.flaggedIssues : [],
      checkedAt: getTodayISO(),
      relevanceDate: getTodayDate(),
    };

    if (!skipCache) setCache(cacheKey(req.content, req.contentType), result);
    return { result, fromCache: false, durationMs: Date.now() - t0 };
  } catch (err) {
    circuit.recordFailure();
    fastify.log.error({ requestId, err }, 'DeepSeek call failed');
    throw err;
  }
}

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => ({
  service: 'module1-relevance-gate', agent: 'deepseek-chat',
  status: circuit.isOpen() ? 'degraded' : 'online',
  date: getTodayDate(), timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  dependencies: { database: getServiceUrl('module6-database'), events: getServiceUrl('module9-events') },
}));

fastify.get('/circuit', async () => ({
  failures: circuit.failures, threshold: circuit.threshold,
  isOpen: circuit.isOpen(),
  openUntil: circuit.openUntil > 0 ? new Date(circuit.openUntil).toISOString() : null,
  totalTrips: circuit.totalTrips, wasOpen: circuit.wasOpen,
}));

fastify.post('/circuit/reset', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) return reply.status(401).send({ error: 'Internal token required' });
  circuit.reset();
  return { ok: true, message: 'Circuit breaker reset', timestamp: getTodayISO() };
});

fastify.get('/metrics', async () => ({
  service: 'module1-relevance-gate', timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  checks: { total: metrics.totalChecks, approved: metrics.approved, rejected: metrics.rejected, approvalRate: metrics.totalChecks > 0 ? ((metrics.approved / metrics.totalChecks) * 100).toFixed(1) + '%' : 'N/A', avgScore: metrics.totalChecks > 0 ? Math.round(metrics.avgScoreSum / metrics.totalChecks) : 0 },
  cache: { size: decisionCache.size, maxSize: CACHE_MAX, hits: metrics.cacheHits, hitRate: metrics.totalChecks > 0 ? ((metrics.cacheHits / metrics.totalChecks) * 100).toFixed(1) + '%' : 'N/A' },
  circuit: { failures: circuit.failures, threshold: circuit.threshold, isOpen: circuit.isOpen(), totalTrips: circuit.totalTrips },
  solidityRejections: metrics.solidityRejections, packageRejections: metrics.packageRejections,
  callers: Object.fromEntries(callerStats),
}));

fastify.get('/decisions', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 200);
  const filterApproved = q['approved'];
  let results = recentDecisions;
  if (filterApproved === 'true') results = results.filter(d => d.approved);
  if (filterApproved === 'false') results = results.filter(d => !d.approved);
  return { total: results.length, decisions: results.slice(0, limit) };
});

fastify.delete('/cache', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) return reply.status(401).send({ error: 'Internal token required' });
  const size = decisionCache.size;
  decisionCache.clear();
  return { ok: true, cleared: size, timestamp: getTodayISO() };
});

fastify.post('/check', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = CheckSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const body: RelevanceRequest = { content: parsed.data.content, contentType: parsed.data.contentType, submittedBy: parsed.data.submittedBy, submittedAt: getTodayISO(), taskId: parsed.data.taskId, metadata: parsed.data.metadata };
  metrics.totalChecks++;

  try {
    const { result, fromCache, durationMs } = await checkRelevance(body, requestId, parsed.data.skipCache);
    metrics.avgScoreSum += result.score;
    if (result.approved) metrics.approved++; else metrics.rejected++;
    trackCaller(body.submittedBy, result.approved);
    recordDecision({ requestId, taskId: parsed.data.taskId, contentType: body.contentType, submittedBy: body.submittedBy, approved: result.approved, score: result.score, reason: result.reason, flaggedIssues: result.flaggedIssues, checkedAt: result.checkedAt, fromCache, durationMs });
    void persistDecision(body, result, parsed.data.taskId);
    if (!result.approved) void emitEvent('gate.rejected', { taskId: parsed.data.taskId, score: result.score, reason: result.reason, contentType: body.contentType, submittedBy: body.submittedBy });
    reply.header('X-Gate-Score', String(result.score));
    reply.header('X-Gate-Approved', String(result.approved));
    reply.header('X-Gate-Cache', String(fromCache));
    reply.header('X-Gate-Duration-Ms', String(durationMs));
    return reply.status(result.approved ? 200 : 422).send(result);
  } catch (err) {
    fastify.log.error({ requestId, err }, 'Gate check failed');
    return reply.status(500).send({ approved: false, score: 0, reason: 'Gate internal error — failing closed', flaggedIssues: ['Internal error'], checkedAt: getTodayISO(), relevanceDate: getTodayDate() } satisfies RelevanceResult);
  }
});

fastify.post('/bulk-check', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = BulkCheckSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const results = await Promise.allSettled(
    parsed.data.items.map(async (item) => {
      const body: RelevanceRequest = { ...item, submittedAt: getTodayISO() };
      metrics.totalChecks++;
      try {
        const { result, fromCache, durationMs } = await checkRelevance(body, requestId);
        metrics.avgScoreSum += result.score;
        if (result.approved) metrics.approved++; else metrics.rejected++;
        trackCaller(body.submittedBy, result.approved);
        void persistDecision(body, result, item.taskId);
        return { ...result, fromCache, durationMs, taskId: item.taskId };
      } catch {
        return { approved: false, score: 0, reason: 'Check failed', flaggedIssues: ['Error'], checkedAt: getTodayISO(), relevanceDate: getTodayDate(), fromCache: false, durationMs: 0 };
      }
    })
  );

  const responses = results.map(r => r.status === 'fulfilled' ? r.value : { approved: false, score: 0, reason: 'Promise rejected', flaggedIssues: ['Error'], checkedAt: getTodayISO(), relevanceDate: getTodayDate() });
  const allApproved = responses.every(r => r.approved);
  return reply.status(allApproved ? 200 : 207).send({ allApproved, results: responses, summary: { total: responses.length, approved: responses.filter(r => r.approved).length, rejected: responses.filter(r => !r.approved).length } });
});

fastify.post('/check-solidity', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const b = req.body as Record<string, unknown>;
  const content = String(b['source'] ?? b['content'] ?? '');
  const taskId = b['taskId'] as string | undefined;
  if (!content) return reply.status(400).send({ error: 'source or content required' });

  const staticResult = runSolidityStaticAnalysis(content);
  const blockedPkgs = checkPackageBlocklist(content);
  const body: RelevanceRequest = { content, contentType: 'solidity', submittedBy: 'blockchain', submittedAt: getTodayISO(), taskId };
  metrics.totalChecks++;

  try {
    const { result, fromCache, durationMs } = await checkRelevance(body, requestId);
    metrics.avgScoreSum += result.score;
    if (result.approved) metrics.approved++; else { metrics.rejected++; metrics.solidityRejections++; }
    void persistDecision(body, result, taskId);
    return reply.status(result.approved ? 200 : 422).send({ ...result, staticAnalysis: { issues: staticResult.issues, blockedPackages: blockedPkgs, autoRejected: staticResult.autoReject }, fromCache, durationMs });
  } catch (err) {
    return reply.status(500).send({ approved: false, score: 0, reason: 'Gate error', flaggedIssues: ['Internal error'], checkedAt: getTodayISO(), relevanceDate: getTodayDate() });
  }
});

fastify.get('/stats/callers', async () => ({ callers: Object.fromEntries(callerStats), timestamp: getTodayISO() }));

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required');
    await fastify.listen({ port: 3001, host: '0.0.0.0' });
    fastify.log.info('🔒 Relevance Gate online — port 3001');
    fastify.log.info(`📅 ${getTodayDate()} | DeepSeek | Cache: ${CACHE_MAX} | Circuit: ${circuit.threshold} failures → 60s`);
    fastify.log.info(`🔍 Solidity rules: ${SOLIDITY_RULES.length} | Blocked packages: ${BLOCKED_PACKAGES.length}`);
  } catch (err) { fastify.log.error(err, 'Gate failed'); process.exit(1); }
};
start();

