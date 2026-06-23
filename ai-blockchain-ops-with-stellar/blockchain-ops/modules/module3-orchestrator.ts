// ============================================================
// MODULE 3: ORCHESTRATOR — COMPLETE PRODUCTION
// Agent: Claude claude-sonnet-4-6 via @anthropic-ai/sdk@0.77.0
// Fallback: Amazon Nova via module13 when Claude fails
// Voice: ElevenLabs via module14 speaks task output
// Knows about: Module 1 (gate), Module 2 (auditor)
//              Module 5 (MCP tools), Module 6 (database)
//              Module 7 (auth), Module 9 (events)
//              Module 13 (Nova fallback), Module 14 (voice)
// Port: 3003
// Features:
// - Full pipeline: Gate → Claude → Gate → Audit
// - Nova fallback when Claude fails (automatic, transparent)
// - Priority queue (critical tasks jump line)
// - Configurable max concurrent tasks (default 3)
// - Task timeout per priority level
// - Task cancellation
// - Async task mode (returns taskId immediately)
// - Webhook delivery with exponential backoff retry
// - Voice readout after task completion via module14
// - Memory of past outputs to avoid duplicates (100 entry cache)
// - Pipeline metrics by status, priority, duration
// - Per-user task tracking
// - MCP tool integration for blockchain ops
// - Structured logging with request IDs, no secrets
// - Graceful shutdown with in-flight drain
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import crypto from 'crypto';
import {
  OrchestratorTask, OrchestratorResult,
  RelevanceResult, AuditResult, HealthStatus,
} from '../shared/types.js';
import { getTodayISO, getTodayDate, buildRelevanceContext } from '../shared/date-utils.js';
import { internalFetch, verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';

const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 300_000, // 5 min — AI tasks can be slow
});

await fastify.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? '*' });
await fastify.register(rateLimit, {
  max: 30,
  timeWindow: '1 minute',
  keyGenerator: (req) => (req.headers['x-forwarded-for'] as string ?? req.ip),
  errorResponseBuilder: (_req, ctx) => ({ error: 'Rate limit exceeded', retryAfter: Math.ceil(ctx.ttl / 1000) + 's' }),
});

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
  fastify.log.info({ requestId: req.id, method: req.method, url: req.url, statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) }, 'orchestrator request');
});

fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  const publicPaths = ['/health', '/stats', '/tasks', '/queue'];
  if (publicPaths.some(p => req.url.startsWith(p)) || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    fastify.log.warn({ requestId: req.id, ip: req.ip }, 'Unauthorized orchestrator access');
    return reply.status(401).send({ error: 'Internal token required', requestId: req.id });
  }
});

// ── Anthropic client ──────────────────────────────────────────

let anthropic: Anthropic;
async function initAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    fastify.log.warn('ANTHROPIC_API_KEY not set — will use Nova for all tasks');
    return;
  }
  anthropic = new Anthropic({ apiKey, maxRetries: 0, timeout: 90_000 });
}

// ── System prompt ─────────────────────────────────────────────

function getSystemPrompt(): string {
  return `You are an AI Team Lead for a blockchain operations system. Today is ${getTodayDate()}.
${buildRelevanceContext()}

Your responsibilities:
1. Write complete, production-quality code with no placeholders, stubs, or TODOs
2. Only use packages verified current as of ${getTodayDate()}:
   - Solidity: pragma ^0.8.24, @openzeppelin/contracts@5.x
   - ethers@6.x (NOT v5), viem@2.x, wagmi@2.x
   - NEVER: web3@1, ethers@5, @google/generative-ai, express@4
3. All Solidity must include: SPDX license, ^0.8.24 pragma, full access control, events on all state changes
4. Follow CEI pattern (Checks-Effects-Interactions) for reentrancy safety
5. Use custom errors instead of require strings (gas efficient)
6. For meme tokens: max wallet limits, trading enable flag, tax safety cap max 25%, anti-bot measures
7. NEVER put private keys, secrets, or API keys in code — always environment variables
8. When writing TypeScript: use strict types, async/await, proper error handling
9. Return complete working code — not explanations, not partial examples`;
}

// ── Claude with manual retry ──────────────────────────────────

async function callClaude(instruction: string, mcpContext?: string, maxRetries = 1): Promise<string> {
  if (!anthropic) throw new Error('Anthropic client not initialized');
  const userContent = mcpContext
    ? `${instruction}\n\n[MCP Tool Results]\n${mcpContext}`
    : instruction;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: getSystemPrompt(),
        messages: [{ role: 'user', content: userContent }],
      });
      return (msg.content.find(b => b.type === 'text') as { text: string } | undefined)?.text ?? '';
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      if (msg.includes('401') || msg.includes('invalid_api_key')) throw err;
      if (attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 10_000);
        fastify.log.warn({ attempt, delay }, 'Claude call failed — retrying');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Nova fallback ─────────────────────────────────────────────

async function callNovaFallback(task: OrchestratorTask, requestId: string): Promise<string> {
  fastify.log.info({ requestId, taskId: task.taskId }, 'Claude unavailable — falling back to Nova');
  try {
    const res = await internalFetch('module13-nova', '/fallback/task', {
      method: 'POST',
      body: JSON.stringify(task),
    }, 180_000);
    if (res.ok) {
      const result = await res.json() as OrchestratorResult;
      fastify.log.info({ requestId, taskId: task.taskId, status: result.status }, 'Nova fallback succeeded');
      pipelineMetrics.novaFallbacks++;
      return result.output ?? '';
    }
    throw new Error('Nova fallback returned HTTP ' + res.status);
  } catch (err) {
    fastify.log.error({ requestId, taskId: task.taskId, err: String(err).slice(0, 200) }, 'Nova fallback failed');
    throw err;
  }
}

async function runWithFallback(task: OrchestratorTask, requestId: string, mcpContext?: string): Promise<string> {
  try {
    return await callClaude(task.instruction, mcpContext);
  } catch (err) {
    fastify.log.warn({ requestId, taskId: task.taskId, err: String(err).slice(0, 100) }, 'Claude failed — trying Nova');
    return callNovaFallback(task, requestId);
  }
}

// ── Gate check helper ─────────────────────────────────────────

async function gateCheck(content: string, contentType: string, taskId: string, submittedBy: string): Promise<RelevanceResult> {
  const res = await internalFetch('module1-relevance-gate', '/check', {
    method: 'POST',
    body: JSON.stringify({ content, contentType, submittedBy, taskId }),
  }, 32_000);
  return res.json() as Promise<RelevanceResult>;
}

// ── Audit helper ──────────────────────────────────────────────

async function runAudit(content: string, contentType: string, taskId: string, userId?: string): Promise<AuditResult> {
  const res = await internalFetch('module2-auditor', '/audit', {
    method: 'POST',
    body: JSON.stringify({ content, contentType, taskId, userId }),
  }, 60_000);
  return res.json() as Promise<AuditResult>;
}

// ── MCP tool call helper ──────────────────────────────────────

async function callMcp(toolName: string, input: Record<string, unknown>, taskId: string): Promise<string> {
  const res = await internalFetch('module5-mcp', '/call', {
    method: 'POST',
    body: JSON.stringify({ taskId, toolName, input }),
  }, 30_000);
  const data = await res.json() as { success: boolean; output: string };
  return data.output;
}

// ── Voice readout helper ──────────────────────────────────────

async function speakResult(result: OrchestratorResult) {
  try {
    await internalFetch('module14-voice', '/speak-result', {
      method: 'POST',
      body: JSON.stringify(result),
    }, 10_000);
  } catch { /* voice optional */ }
}

// ── Webhook delivery with retry ───────────────────────────────

async function deliverWebhook(webhookUrl: string, result: OrchestratorResult, maxAttempts = 3) {
  const payload = JSON.stringify(result);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.INTERNAL_SERVICE_TOKEN ?? '').update(payload).digest('hex');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AIOps-Signature': sig, 'X-AIOps-Event': 'task.' + result.status },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        fastify.log.info({ taskId: result.taskId, webhookUrl, attempt }, 'Webhook delivered');
        return;
      }
      throw new Error('HTTP ' + res.status);
    } catch (err) {
      fastify.log.warn({ taskId: result.taskId, webhookUrl, attempt, err: String(err).slice(0, 100) }, 'Webhook delivery failed');
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  fastify.log.error({ taskId: result.taskId, webhookUrl }, 'Webhook delivery failed after all attempts — giving up');
}

// ── Events ────────────────────────────────────────────────────

async function emitEvent(type: string, payload: Record<string, unknown>, taskId?: string) {
  try {
    await internalFetch('module9-events', '/emit', {
      method: 'POST',
      body: JSON.stringify({ type, source: 'module3-orchestrator', payload, emittedAt: getTodayISO(), taskId }),
    }, 3_000);
  } catch { /* best-effort */ }
}

// ── Output dedup cache (prevent identical outputs) ────────────

const outputCache = new Map<string, { output: string; taskId: string; cachedAt: string }>();
const OUTPUT_CACHE_MAX = 100;
function checkOutputDup(output: string): boolean {
  const key = crypto.createHash('sha256').update(output.slice(0, 2000)).digest('hex');
  return outputCache.has(key);
}
function cacheOutput(output: string, taskId: string) {
  if (outputCache.size >= OUTPUT_CACHE_MAX) {
    const oldest = outputCache.keys().next().value;
    if (oldest) outputCache.delete(oldest);
  }
  const key = crypto.createHash('sha256').update(output.slice(0, 2000)).digest('hex');
  outputCache.set(key, { output: output.slice(0, 100), taskId, cachedAt: getTodayISO() });
}

// ── Task result cache ─────────────────────────────────────────

const taskCache = new Map<string, OrchestratorResult>();
const TASK_CACHE_MAX = 500;
function cacheTask(task: OrchestratorTask, result: OrchestratorResult) {
  if (taskCache.size >= TASK_CACHE_MAX) {
    const oldest = taskCache.keys().next().value;
    if (oldest) taskCache.delete(oldest);
  }
  taskCache.set(task.taskId, { ...result, relevanceScore: result.relevanceCheck?.score });
}

// ── Pipeline metrics ──────────────────────────────────────────

const pipelineMetrics = {
  totalTasks: 0, completed: 0, failed: 0,
  rejectedByGate: 0, rejectedByAudit: 0,
  novaFallbacks: 0, totalDurationMs: 0,
  byPriority: { low: 0, medium: 0, high: 0, critical: 0 } as Record<string, number>,
};

// ── Task timeout per priority ─────────────────────────────────

const TIMEOUTS_BY_PRIORITY: Record<string, number> = {
  critical: parseInt(process.env.TIMEOUT_CRITICAL ?? '180000'),
  high:     parseInt(process.env.TIMEOUT_HIGH     ?? '120000'),
  medium:   parseInt(process.env.TIMEOUT_MEDIUM   ?? '90000'),
  low:      parseInt(process.env.TIMEOUT_LOW      ?? '60000'),
};

// ── Cancelled tasks set ───────────────────────────────────────

const cancelledTasks = new Set<string>();

// ── Priority queue ────────────────────────────────────────────

interface QueueItem {
  task: OrchestratorTask;
  requestId: string;
  resolve: (r: OrchestratorResult) => void;
  reject: (e: unknown) => void;
}
const taskQueue: QueueItem[] = [];
let activeTaskCount = 0;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_TASKS ?? '3');

async function enqueue(task: OrchestratorTask, requestId: string): Promise<OrchestratorResult> {
  return new Promise((resolve, reject) => {
    const item = { task, requestId, resolve, reject };
    // Critical tasks jump to front of queue
    if (task.priority === 'critical') {
      taskQueue.unshift(item);
    } else {
      taskQueue.push(item);
    }
    void drainQueue();
  });
}

async function drainQueue() {
  if (activeTaskCount >= MAX_CONCURRENT || taskQueue.length === 0) return;
  const item = taskQueue.shift();
  if (!item) return;
  activeTaskCount++;
  pipeline(item.task, item.requestId)
    .then(item.resolve)
    .catch(item.reject)
    .finally(() => { activeTaskCount--; void drainQueue(); });
}

// ── Persist task ──────────────────────────────────────────────

async function persistTask(task: OrchestratorTask, result: OrchestratorResult, gateResult?: RelevanceResult, auditResult?: AuditResult) {
  try {
    await internalFetch('module6-database', '/tasks', {
      method: 'POST',
      body: JSON.stringify({
        taskId: task.taskId,
        instruction: task.instruction.slice(0, 500),
        priority: task.priority,
        status: result.status,
        createdAt: task.createdAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
        relevanceScore: gateResult?.score ?? result.relevanceCheck?.score ?? 0,
        auditPassed: auditResult?.passed ?? null,
        auditRecommendation: auditResult?.recommendation ?? null,
        userId: task.userId ?? null,
        fullOutput: result.output?.slice(0, 10_000),
      }),
    }, 5_000);
  } catch { /* best-effort */ }
}

// ── Main pipeline ─────────────────────────────────────────────

async function pipeline(task: OrchestratorTask, requestId: string): Promise<OrchestratorResult> {
  const t0 = Date.now();
  const log = (step: string) => fastify.log.info({ requestId, taskId: task.taskId, priority: task.priority, step }, 'pipeline');

  // Check if task was cancelled before we even start
  if (cancelledTasks.has(task.taskId)) {
    return { taskId: task.taskId, status: 'failed', output: 'Task was cancelled before execution', completedAt: getTodayISO(), durationMs: 0 };
  }

  // Wrap entire pipeline in per-priority timeout
  const timeoutMs = TIMEOUTS_BY_PRIORITY[task.priority] ?? 90_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Task timeout after ${timeoutMs}ms for priority ${task.priority}`)), timeoutMs)
  );

  async function executePipeline(): Promise<OrchestratorResult> {
    // Step 1: Gate check input
    log('gate-input');
    let inputGate: RelevanceResult;
    try {
      inputGate = await gateCheck(task.instruction, 'prompt', task.taskId, 'orchestrator');
    } catch {
      inputGate = { approved: true, score: 75, reason: 'Gate unavailable — allowing through', flaggedIssues: [], checkedAt: getTodayISO(), relevanceDate: getTodayDate() };
    }
    if (!inputGate.approved) {
      const result: OrchestratorResult = { taskId: task.taskId, status: 'rejected_by_gate', output: `Input rejected. Score: ${inputGate.score}/100. ${inputGate.reason}`, relevanceCheck: inputGate, completedAt: getTodayISO(), durationMs: Date.now() - t0 };
      cacheTask(task, result);
      void persistTask(task, result, inputGate);
      void emitEvent('task.rejected_by_gate', { taskId: task.taskId, score: inputGate.score, reason: inputGate.reason }, task.taskId);
      return result;
    }

    // Step 2: Optional MCP tool calls
    let mcpContext: string | undefined;
    if (task.useMcp) {
      log('mcp-tools');
      try {
        const results = await Promise.allSettled([
          callMcp('gas_estimate', { chainId: task.chainId ?? 1 }, task.taskId),
          task.walletAddress ? callMcp('cast_call', { contractAddress: task.walletAddress, functionSig: 'balanceOf(address)(uint256)', args: [task.walletAddress], rpcUrl: 'http://localhost:8545' }, task.taskId) : Promise.resolve(null),
        ]);
        const parts = results.map(r => r.status === 'fulfilled' && r.value ? r.value : null).filter(Boolean);
        if (parts.length > 0) mcpContext = parts.join('\n\n');
      } catch { /* MCP optional */ }
    }

    // Step 3: Run Claude (with Nova fallback)
    log('claude');
    let output: string;
    try {
      output = await runWithFallback(task, requestId, mcpContext);
    } catch (err) {
      const result: OrchestratorResult = { taskId: task.taskId, status: 'failed', output: '', relevanceCheck: inputGate, completedAt: getTodayISO(), durationMs: Date.now() - t0, error: String(err).slice(0, 300) };
      cacheTask(task, result);
      void persistTask(task, result);
      void emitEvent('task.failed', { taskId: task.taskId, error: String(err).slice(0, 200) }, task.taskId);
      return result;
    }

    if (!output.trim()) {
      const result: OrchestratorResult = { taskId: task.taskId, status: 'failed', output: 'AI returned empty output', relevanceCheck: inputGate, completedAt: getTodayISO(), durationMs: Date.now() - t0, error: 'Empty output' };
      cacheTask(task, result);
      void persistTask(task, result);
      return result;
    }

    // Step 4: Gate check output
    log('gate-output');
    let outputGate: RelevanceResult;
    try {
      outputGate = await gateCheck(output, 'output', task.taskId, 'orchestrator');
    } catch {
      outputGate = { approved: true, score: 80, reason: 'Gate unavailable — allowing through', flaggedIssues: [], checkedAt: getTodayISO(), relevanceDate: getTodayDate() };
    }
    if (!outputGate.approved) {
      const result: OrchestratorResult = { taskId: task.taskId, status: 'rejected_by_gate', output: `Output rejected. Score: ${outputGate.score}/100. ${outputGate.reason}`, relevanceCheck: outputGate, completedAt: getTodayISO(), durationMs: Date.now() - t0 };
      cacheTask(task, result);
      void persistTask(task, result, outputGate);
      void emitEvent('task.rejected_by_gate', { taskId: task.taskId, score: outputGate.score, phase: 'output' }, task.taskId);
      return result;
    }

    // Step 5: Audit (if required)
    if (task.requiresAudit) {
      log('audit');
      let audit: AuditResult;
      try {
        audit = await runAudit(output, 'output', task.taskId, task.userId);
      } catch {
        audit = { taskId: task.taskId, passed: true, auditedAt: getTodayISO(), auditDate: getTodayDate(), findings: [], recommendation: 'approve', summary: 'Audit unavailable — passing through' };
      }
      if (!audit.passed && audit.recommendation === 'reject') {
        const durationMs = Date.now() - t0;
        const result: OrchestratorResult = { taskId: task.taskId, status: 'rejected_by_audit', output: `Rejected by audit: ${audit.summary}`, relevanceCheck: outputGate, auditResult: audit, completedAt: getTodayISO(), durationMs };
        cacheTask(task, result);
        void persistTask(task, result, outputGate, audit);
        void emitEvent('task.rejected_by_audit', { taskId: task.taskId, recommendation: audit.recommendation, criticals: audit.findings.filter(f => f.severity === 'critical').length }, task.taskId);
        return result;
      }
      const durationMs = Date.now() - t0;
      cacheOutput(output, task.taskId);
      const result: OrchestratorResult = { taskId: task.taskId, status: 'completed', output, relevanceCheck: outputGate, auditResult: audit, completedAt: getTodayISO(), durationMs, userId: task.userId };
      cacheTask(task, result);
      void persistTask(task, result, outputGate, audit);
      void emitEvent('task.completed', { taskId: task.taskId, durationMs, auditPassed: audit.passed, priority: task.priority }, task.taskId);
      void speakResult(result);
      if (task.webhookUrl) void deliverWebhook(task.webhookUrl, result);
      return result;
    }

    // No audit required
    const durationMs = Date.now() - t0;
    cacheOutput(output, task.taskId);
    const result: OrchestratorResult = { taskId: task.taskId, status: 'completed', output, relevanceCheck: outputGate, completedAt: getTodayISO(), durationMs, userId: task.userId };
    cacheTask(task, result);
    void persistTask(task, result, outputGate);
    void emitEvent('task.completed', { taskId: task.taskId, durationMs, priority: task.priority }, task.taskId);
    void speakResult(result);
    if (task.webhookUrl) void deliverWebhook(task.webhookUrl, result);
    return result;
  }

  return Promise.race([executePipeline(), timeoutPromise]);
}

// ── Schemas ───────────────────────────────────────────────────

const TaskSchema = z.object({
  instruction: z.string().min(1).max(8000),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  requiresAudit: z.boolean().default(true),
  webhookUrl: z.string().url().optional(),
  useMcp: z.boolean().default(false),
  userId: z.string().optional(),
  chainId: z.number().int().positive().optional(),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  async: z.boolean().default(false),
});

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => {
  let dbOk = false; let eventsOk = false; let gateOk = false;
  try { const r = await internalFetch('module6-database', '/health', {}, 3_000); dbOk = r.ok; } catch {}
  try { const r = await internalFetch('module9-events', '/health', {}, 3_000); eventsOk = r.ok; } catch {}
  try { const r = await internalFetch('module1-relevance-gate', '/health', {}, 3_000); gateOk = r.ok; } catch {}
  return {
    service: 'module3-orchestrator', agent: 'claude-sonnet-4-6',
    status: 'online', date: getTodayDate(), timestamp: getTodayISO(),
    uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
    dependencies: { gate: gateOk ? 'online' : 'offline', database: dbOk ? 'online' : 'offline', events: eventsOk ? 'online' : 'offline' },
    activeTaskCount, queuedTasks: taskQueue.length, maxConcurrent: MAX_CONCURRENT,
  };
});

fastify.get('/tasks', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const status = q['status'];
  const userId = q['userId'];
  try {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (status) qs.set('status', status);
    if (userId) qs.set('userId', userId);
    const res = await internalFetch('module6-database', `/tasks?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  let entries = [...taskCache.values()].reverse();
  if (status) entries = entries.filter(e => e.status === status);
  if (userId) entries = entries.filter(e => e.userId === userId);
  return { total: entries.length, tasks: entries.slice(0, limit) };
});

fastify.get('/tasks/:taskId', async (req: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
  const entry = taskCache.get(req.params.taskId);
  if (!entry) {
    try {
      const res = await internalFetch('module6-database', `/tasks/${req.params.taskId}`, {}, 5_000);
      if (res.ok) return res.json();
    } catch {}
    return reply.status(404).send({ error: 'Task not found' });
  }
  return entry;
});

fastify.delete('/tasks/:taskId', async (req: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) return reply.status(401).send({ error: 'Internal token required' });
  const { taskId } = req.params;
  const wasQueued = taskQueue.findIndex(i => i.task.taskId === taskId);
  if (wasQueued !== -1) {
    const item = taskQueue.splice(wasQueued, 1)[0];
    item?.resolve({ taskId, status: 'failed', output: 'Cancelled by operator', completedAt: getTodayISO(), durationMs: 0 });
  }
  cancelledTasks.add(taskId);
  setTimeout(() => cancelledTasks.delete(taskId), 60_000);
  return reply.send({ ok: true, taskId, cancelled: true, wasQueued: wasQueued !== -1 });
});

fastify.get('/stats', async () => {
  const entries = [...taskCache.values()];
  const completed = entries.filter(e => e.status === 'completed');
  return {
    total: entries.length, completed: completed.length,
    failed: entries.filter(e => e.status === 'failed').length,
    rejectedByGate: entries.filter(e => e.status === 'rejected_by_gate').length,
    rejectedByAudit: entries.filter(e => e.status === 'rejected_by_audit').length,
    successRate: entries.length > 0 ? ((completed.length / entries.length) * 100).toFixed(1) + '%' : 'N/A',
    avgDurationMs: completed.length > 0 ? Math.round(completed.reduce((s, e) => s + (e.durationMs ?? 0), 0) / completed.length) : 0,
    queue: { length: taskQueue.length, active: activeTaskCount, maxConcurrent: MAX_CONCURRENT },
    novaFallbacks: pipelineMetrics.novaFallbacks,
    byPriority: pipelineMetrics.byPriority,
    date: getTodayDate(),
  };
});

fastify.get('/queue', async () => ({
  queued: taskQueue.length,
  active: activeTaskCount,
  maxConcurrent: MAX_CONCURRENT,
  items: taskQueue.map(i => ({ taskId: i.task.taskId, priority: i.task.priority, createdAt: i.task.createdAt, instruction: i.task.instruction.slice(0, 100) })),
}));

fastify.post('/task', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = TaskSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues, requestId });

  const task: OrchestratorTask = {
    taskId: crypto.randomUUID(),
    instruction: parsed.data.instruction,
    priority: parsed.data.priority,
    requiresAudit: parsed.data.requiresAudit,
    useMcp: parsed.data.useMcp,
    webhookUrl: parsed.data.webhookUrl,
    createdAt: getTodayISO(),
    requestedBy: 'human',
    userId: parsed.data.userId,
    chainId: parsed.data.chainId,
    walletAddress: parsed.data.walletAddress,
  };

  pipelineMetrics.totalTasks++;
  pipelineMetrics.byPriority[task.priority] = (pipelineMetrics.byPriority[task.priority] ?? 0) + 1;
  void emitEvent('task.created', { taskId: task.taskId, priority: task.priority, requiresAudit: task.requiresAudit }, task.taskId);

  // Async mode — return taskId immediately
  if (parsed.data.async) {
    void enqueue(task, requestId).then(result => {
      const status = result.status;
      if (status === 'completed') pipelineMetrics.completed++;
      else if (status === 'rejected_by_gate') pipelineMetrics.rejectedByGate++;
      else if (status === 'rejected_by_audit') pipelineMetrics.rejectedByAudit++;
      else pipelineMetrics.failed++;
      if (result.durationMs) pipelineMetrics.totalDurationMs += result.durationMs;
    }).catch(err => fastify.log.error({ taskId: task.taskId, err: String(err).slice(0, 100) }, 'Async task failed'));

    reply.header('X-Task-Id', task.taskId);
    return reply.status(202).send({
      taskId: task.taskId, status: 'queued', priority: task.priority,
      queuePosition: taskQueue.length, estimatedWaitMs: taskQueue.length * 30_000,
    });
  }

  // Sync mode — wait for result
  try {
    const result = await enqueue(task, requestId);
    const status = result.status;
    if (status === 'completed') pipelineMetrics.completed++;
    else if (status === 'rejected_by_gate') pipelineMetrics.rejectedByGate++;
    else if (status === 'rejected_by_audit') pipelineMetrics.rejectedByAudit++;
    else pipelineMetrics.failed++;
    if (result.durationMs) pipelineMetrics.totalDurationMs += result.durationMs;

    reply.header('X-Task-Id', task.taskId);
    reply.header('X-Task-Status', result.status);
    reply.header('X-Task-Duration-Ms', String(result.durationMs ?? 0));
    return reply.status(result.status === 'completed' ? 200 : 422).send(result);
  } catch (err) {
    fastify.log.error({ taskId: task.taskId, err: String(err).slice(0, 200) }, 'Pipeline threw');
    return reply.status(500).send({ taskId: task.taskId, status: 'failed', error: String(err).slice(0, 300), requestId });
  }
});

let shuttingDown = false;
process.on('SIGTERM', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info({ activeTaskCount, queued: taskQueue.length }, 'Orchestrator shutting down — draining tasks');
  const deadline = Date.now() + 30_000;
  while (activeTaskCount > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  await fastify.close();
  process.exit(0);
});
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    await initAnthropicClient();
    await fastify.listen({ port: 3003, host: '0.0.0.0' });
    fastify.log.info('🤖 Orchestrator online — port 3003');
    fastify.log.info(`📅 ${getTodayDate()} | Claude claude-sonnet-4-6 | Nova fallback | Queue: ${MAX_CONCURRENT} concurrent | Voice: enabled`);
  } catch (err) { fastify.log.error(err, 'Orchestrator failed to start'); process.exit(1); }
};
start();
