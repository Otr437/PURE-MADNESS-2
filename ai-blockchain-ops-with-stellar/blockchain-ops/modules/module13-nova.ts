// ============================================================
// MODULE 13: AMAZON NOVA ENGINE
// Provider: Amazon Bedrock — Nova Micro, Lite, Pro, Premier
// Role: Plug-and-play AI engine that works alongside OR replaces
//       Claude (module3), DeepSeek (module1), Gemini (module2).
//       Exposes the same API contract as all three so any module
//       can swap to Nova with zero code changes.
//
// Modes:
//   standalone   — primary AI engine (replaces Claude in module3)
//   gate         — content gate (replaces DeepSeek in module1)
//   auditor      — security auditor (replaces Gemini in module2)
//   fallback     — secondary engine, called when primary fails
//   all          — handles all roles simultaneously
//
// Knows about: Module 6 (persists all Nova decisions + tasks)
//              Module 9 (emits Nova events)
//              Module 1 (can replace or augment the gate)
//              Module 2 (can replace or augment the auditor)
//              Module 3 (can replace or augment Claude)
// Port: 3013
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
  type SystemContentBlock,
  type InferenceConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import crypto from 'crypto';
import {
  RelevanceRequest, RelevanceResult,
  AuditRequest, AuditResult, AuditFinding,
  OrchestratorTask, OrchestratorResult,
  HealthStatus,
} from '../shared/types.js';
import { getTodayISO, getTodayDate, buildRelevanceContext } from '../shared/date-utils.js';
import { internalFetch, verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';

const SERVICE_START = Date.now();

// ── Nova Model IDs ────────────────────────────────────────────
// All cross-region inference profile IDs (us.* prefix = auto routing)

export const NOVA_MODELS = {
  micro:   'us.amazon.nova-micro-v1:0',     // Fastest, cheapest, text only
  lite:    'us.amazon.nova-lite-v1:0',      // Multimodal, fast, low cost
  pro:     'us.amazon.nova-pro-v1:0',       // Best accuracy/speed/cost balance
  premier: 'us.amazon.nova-premier-v1:1',   // Most capable, complex reasoning
  // Next gen (2026)
  lite2:   'us.amazon.nova-2-lite-v1:0',    // 1M context, reasoning, multimodal
} as const;

type NovaModelKey = keyof typeof NOVA_MODELS;

// ── Mode configuration ────────────────────────────────────────

type NovaMode = 'standalone' | 'gate' | 'auditor' | 'fallback' | 'all';

const NOVA_MODE = (process.env.NOVA_MODE ?? 'all') as NovaMode;

// Model selection per role — can override via env
const MODEL_FOR_ROLE = {
  orchestrator: (process.env.NOVA_MODEL_ORCHESTRATOR ?? NOVA_MODELS.pro)   as string,
  gate:         (process.env.NOVA_MODEL_GATE         ?? NOVA_MODELS.micro)  as string,
  auditor:      (process.env.NOVA_MODEL_AUDITOR      ?? NOVA_MODELS.pro)    as string,
  fallback:     (process.env.NOVA_MODEL_FALLBACK     ?? NOVA_MODELS.lite)   as string,
};

// ── Fastify ───────────────────────────────────────────────────

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 180_000,
});

await fastify.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? '*' });
await fastify.register(rateLimit, { max: 60, timeWindow: '1 minute' });

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.url === '/health' || req.url === '/models' || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
});

// ── Bedrock client ────────────────────────────────────────────

function buildBedrockClient(): BedrockRuntimeClient {
  const region = process.env.AWS_REGION ?? 'us-east-1';

  // Support both explicit credentials and IAM roles / instance profiles
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return new BedrockRuntimeClient({
      region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      },
    });
  }

  // IAM role / instance profile / ECS task role — SDK picks up automatically
  return new BedrockRuntimeClient({ region });
}

const bedrock = buildBedrockClient();

// ── Metrics ───────────────────────────────────────────────────

const metrics = {
  totalCalls: 0,
  successCalls: 0,
  failedCalls: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalLatencyMs: 0,
  byModel: {} as Record<string, { calls: number; tokens: number; latencyMs: number }>,
  byRole: {
    orchestrator: 0,
    gate: 0,
    auditor: 0,
    fallback: 0,
    direct: 0,
  },
};

function trackCall(modelId: string, role: string, inputTokens: number, outputTokens: number, latencyMs: number, success: boolean) {
  metrics.totalCalls++;
  if (success) metrics.successCalls++; else metrics.failedCalls++;
  metrics.totalInputTokens += inputTokens;
  metrics.totalOutputTokens += outputTokens;
  metrics.totalLatencyMs += latencyMs;
  const m = metrics.byModel[modelId] ?? { calls: 0, tokens: 0, latencyMs: 0 };
  m.calls++;
  m.tokens += inputTokens + outputTokens;
  m.latencyMs += latencyMs;
  metrics.byModel[modelId] = m;
  if (role in metrics.byRole) (metrics.byRole as Record<string, number>)[role]++;
}

// ── Recent calls ring buffer ──────────────────────────────────

interface CallRecord {
  callId: string;
  modelId: string;
  role: string;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  calledAt: string;
  promptPreview: string;
  responsePreview: string;
}
const callHistory: CallRecord[] = [];
function recordCall(c: CallRecord) {
  callHistory.unshift(c);
  if (callHistory.length > 200) callHistory.pop();
}

// ── Core Nova invocation ──────────────────────────────────────

interface NovaCallOptions {
  modelId?: string;
  systemPrompt?: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  role?: string;
}

interface NovaCallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  modelId: string;
  stopReason: string;
}

async function callNova(opts: NovaCallOptions): Promise<NovaCallResult> {
  const t0 = Date.now();
  const modelId = opts.modelId ?? MODEL_FOR_ROLE.orchestrator;
  const role = opts.role ?? 'direct';
  const callId = crypto.randomUUID();

  const messages: Message[] = [
    { role: 'user', content: [{ text: opts.userMessage }] },
  ];

  const system: SystemContentBlock[] = opts.systemPrompt
    ? [{ text: opts.systemPrompt }]
    : [];

  const inferenceConfig: InferenceConfiguration = {
    maxTokens: opts.maxTokens ?? 8096,
    temperature: opts.temperature ?? 0.7,
    topP: opts.topP ?? 0.9,
  };

  const command = new ConverseCommand({
    modelId,
    messages,
    system: system.length > 0 ? system : undefined,
    inferenceConfig,
  });

  let result: NovaCallResult;
  try {
    const response = await bedrock.send(command);
    const latencyMs = Date.now() - t0;
    const content = response.output?.message?.content?.[0]?.text ?? '';
    const inputTokens = response.usage?.inputTokens ?? 0;
    const outputTokens = response.usage?.outputTokens ?? 0;
    const stopReason = response.stopReason ?? 'end_turn';

    result = { content, inputTokens, outputTokens, latencyMs, modelId, stopReason };
    trackCall(modelId, role, inputTokens, outputTokens, latencyMs, true);
    recordCall({
      callId, modelId, role, success: true,
      inputTokens, outputTokens, latencyMs,
      calledAt: getTodayISO(),
      promptPreview: opts.userMessage.slice(0, 100),
      responsePreview: content.slice(0, 100),
    });
  } catch (err) {
    const latencyMs = Date.now() - t0;
    trackCall(modelId, role, 0, 0, latencyMs, false);
    recordCall({
      callId, modelId, role, success: false,
      inputTokens: 0, outputTokens: 0, latencyMs,
      calledAt: getTodayISO(),
      promptPreview: opts.userMessage.slice(0, 100),
      responsePreview: String(err).slice(0, 100),
    });
    throw err;
  }

  return result;
}

// Nova with retry + exponential backoff
async function callNovaWithRetry(opts: NovaCallOptions, maxRetries = 2): Promise<NovaCallResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callNova(opts);
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      // Don't retry on validation errors or access denied
      if (msg.includes('ValidationException') || msg.includes('AccessDeniedException')) throw err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
        fastify.log.warn({ attempt, delay, err }, 'Nova call failed — retrying');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Streaming Nova call (for real-time AI assistant) ──────────

async function callNovaStream(
  opts: NovaCallOptions,
  onChunk: (text: string) => void,
): Promise<{ inputTokens: number; outputTokens: number; latencyMs: number }> {
  const t0 = Date.now();
  const modelId = opts.modelId ?? MODEL_FOR_ROLE.orchestrator;

  const messages: Message[] = [
    { role: 'user', content: [{ text: opts.userMessage }] },
  ];
  const system: SystemContentBlock[] = opts.systemPrompt ? [{ text: opts.systemPrompt }] : [];

  const command = new ConverseStreamCommand({
    modelId,
    messages,
    system: system.length > 0 ? system : undefined,
    inferenceConfig: {
      maxTokens: opts.maxTokens ?? 8096,
      temperature: opts.temperature ?? 0.7,
    },
  });

  const response = await bedrock.send(command);
  let inputTokens = 0;
  let outputTokens = 0;
  let fullContent = '';

  if (response.stream) {
    for await (const event of response.stream) {
      if (event.contentBlockDelta?.delta?.text) {
        const chunk = event.contentBlockDelta.delta.text;
        fullContent += chunk;
        onChunk(chunk);
      }
      if (event.metadata?.usage) {
        inputTokens = event.metadata.usage.inputTokens ?? 0;
        outputTokens = event.metadata.usage.outputTokens ?? 0;
      }
    }
  }

  const latencyMs = Date.now() - t0;
  trackCall(modelId, opts.role ?? 'stream', inputTokens, outputTokens, latencyMs, true);
  return { inputTokens, outputTokens, latencyMs };
}

// ── JSON extraction helper ─────────────────────────────────────

function extractJSON(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('{')) return t;
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m?.[1]) return m[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s !== -1 && e > s) return t.slice(s, e + 1);
  return '{}';
}

// ── GATE MODE — Nova as Relevance Gate ────────────────────────
// Same output contract as module1-relevance-gate

function getGateSystemPrompt(): string {
  return `You are the Relevance Gate — a strict security and quality filter for a blockchain AI operations system.
${buildRelevanceContext()}

Respond with ONLY valid JSON, no markdown:
{"approved":true,"score":95,"reason":"one sentence","flaggedIssues":[]}

Rules:
- score 0-100. approved=false if score < 70
- REJECT immediately: hardcoded private keys, tx.origin auth, selfdestruct, Solidity below 0.8
- REJECT: @google/generative-ai, express@4, web3@1, ethers@5, truffle, @openzeppelin/contracts@4
- WARN on: delegatecall, inline assembly, block.timestamp comparisons, missing reentrancy guards
- PASS: secure, current packages, correct patterns for ${getTodayDate()}`;
}

async function novaGateCheck(req: RelevanceRequest, requestId: string): Promise<RelevanceResult> {
  try {
    const result = await callNovaWithRetry({
      modelId: MODEL_FOR_ROLE.gate,
      systemPrompt: getGateSystemPrompt(),
      userMessage: `Check this ${req.contentType} from ${req.submittedBy} [${requestId}]:\n---\n${req.content}\n---\nReturn ONLY JSON.`,
      maxTokens: 500,
      temperature: 0.05,
      role: 'gate',
    });

    let parsed: { approved: boolean; score: number; reason: string; flaggedIssues: string[] };
    try {
      parsed = JSON.parse(extractJSON(result.content));
      if (typeof parsed.approved !== 'boolean' || typeof parsed.score !== 'number') throw new Error('bad shape');
      if (parsed.score < 70) parsed.approved = false;
    } catch {
      return { approved: false, score: 0, reason: 'Nova gate parse error — failing closed', flaggedIssues: ['Parse error'], checkedAt: getTodayISO(), relevanceDate: getTodayDate() };
    }

    return {
      approved: parsed.approved,
      score: Math.max(0, Math.min(100, parsed.score)),
      reason: String(parsed.reason ?? ''),
      flaggedIssues: Array.isArray(parsed.flaggedIssues) ? parsed.flaggedIssues : [],
      checkedAt: getTodayISO(),
      relevanceDate: getTodayDate(),
    };
  } catch (err) {
    fastify.log.error({ requestId, err }, 'Nova gate check failed');
    return { approved: false, score: 0, reason: 'Nova gate unavailable — failing closed', flaggedIssues: [String(err).slice(0, 200)], checkedAt: getTodayISO(), relevanceDate: getTodayDate() };
  }
}

// ── AUDITOR MODE — Nova as Security Auditor ───────────────────
// Same output contract as module2-auditor

function getAuditorSystemPrompt(): string {
  return `You are the Auditor — a strict security auditor for a blockchain AI operations system.
${buildRelevanceContext()}

Audit against TODAY's standards (${getTodayDate()}) ONLY.

Respond with ONLY valid JSON, no markdown:
{"passed":true,"findings":[{"severity":"info","category":"quality","description":"...","location":"optional"}],"recommendation":"approve","summary":"one paragraph"}

severity: "info"|"warning"|"critical"
category: "deprecated_package"|"security"|"relevance"|"quality"|"solidity_vulnerability"
recommendation: "approve"|"reject"|"revise"

Solidity rules:
- CRITICAL: missing access control, reentrancy, tx.origin auth, integer overflow pre-0.8
- WARNING: missing events, centralization risk, missing zero-address checks
- INFO: consider multi-sig, upgradeability patterns

Rules: critical → passed:false + reject. 3+ warnings → revise. Clean → approve.`;
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
      description: String(x['description'] ?? 'No description'),
      location: x['location'] ? String(x['location']) : undefined,
    };
  });
}

async function novaAudit(req: AuditRequest, requestId: string): Promise<AuditResult> {
  const today = getTodayDate();
  const isSolidity = req.contentType === 'solidity';

  const prompt = isSolidity
    ? `Perform a comprehensive security audit of this Solidity contract for task ${req.taskId} [${requestId}].
Audit Date: ${today}

SOLIDITY SOURCE:
---
${req.content}
---

Check for: reentrancy, access control, integer overflow, front-running, timestamp manipulation, gas DoS, centralization, missing events, hardcoded values, incorrect visibility, missing zero-address checks, logic errors in token economics.

Return ONLY JSON.`
    : `Audit this ${req.contentType} for task ${req.taskId} [${requestId}].\nAudit Date: ${today}\n---\n${req.content}\n---\nReturn ONLY JSON.`;

  try {
    const result = await callNovaWithRetry({
      modelId: MODEL_FOR_ROLE.auditor,
      systemPrompt: getAuditorSystemPrompt(),
      userMessage: prompt,
      maxTokens: 2000,
      temperature: 0.05,
      role: 'auditor',
    });

    let parsed: { passed: boolean; findings: unknown[]; recommendation: string; summary: string };
    try {
      parsed = JSON.parse(extractJSON(result.content));
      if (typeof parsed.passed !== 'boolean') throw new Error('missing passed');
    } catch {
      return { taskId: req.taskId, passed: false, auditedAt: getTodayISO(), auditDate: today, findings: [{ severity: 'critical', category: 'quality', description: 'Nova auditor parse error — failing closed' }], recommendation: 'reject', summary: 'Audit failed.' };
    }

    const findings = normalizeFindings(Array.isArray(parsed.findings) ? parsed.findings : []);
    const hasCritical = findings.some(f => f.severity === 'critical');
    const warningCount = findings.filter(f => f.severity === 'warning').length;
    let recommendation = VALID_REC.has(parsed.recommendation) ? parsed.recommendation as AuditResult['recommendation'] : 'reject';
    let passed = parsed.passed;
    if (hasCritical) { passed = false; recommendation = 'reject'; }
    else if (warningCount >= 3 && recommendation === 'approve') recommendation = 'revise';

    return { taskId: req.taskId, passed, auditedAt: getTodayISO(), auditDate: today, findings, recommendation, summary: String(parsed.summary ?? '') };
  } catch (err) {
    fastify.log.error({ requestId, err }, 'Nova audit failed');
    return { taskId: req.taskId, passed: false, auditedAt: getTodayISO(), auditDate: today, findings: [{ severity: 'critical', category: 'quality', description: String(err).slice(0, 200) }], recommendation: 'reject', summary: 'Nova audit error.' };
  }
}

// ── ORCHESTRATOR MODE — Nova as AI Team Lead ──────────────────
// Same output contract as module3-orchestrator

function getOrchestratorSystemPrompt(): string {
  return `You are an AI Team Lead powered by Amazon Nova, operating in a blockchain AI operations system.
${buildRelevanceContext()}

Your team handles blockchain operations: smart contract deployment, meme token launches,
security audits, gas management, wallet operations, and on-chain transaction management.

Your rules:
1. Full production-quality output — no stubs, no placeholders, no TODOs
2. Only use packages verified current as of ${getTodayDate()}:
   - Solidity: @openzeppelin/contracts@5.x, pragma ^0.8.24
   - ethers@6.x (NOT v5), viem@2.x
   - NEVER: deprecated, compromised, or pre-2026 packages
3. All Solidity MUST include: SPDX license, ^0.8.24 pragma, access control, events
4. Follow CEI pattern (Checks-Effects-Interactions) for reentrancy safety
5. Use custom errors instead of require strings (gas efficient)
6. For meme tokens: always include max wallet limits, trading enable flag, tax safety caps (max 25%)
7. NEVER put private keys in code — always environment variables`;
}

async function novaPipeline(task: OrchestratorTask, requestId: string): Promise<OrchestratorResult> {
  const t0 = Date.now();

  // Step 1: Gate check the instruction via module1 (or Nova gate)
  let relevanceCheck: RelevanceResult;
  try {
    const gateRes = await internalFetch('module1-relevance-gate', '/check', {
      method: 'POST',
      body: JSON.stringify({ content: task.instruction, contentType: 'prompt', submittedBy: 'orchestrator', taskId: task.taskId }),
    }, 32_000);
    relevanceCheck = await gateRes.json() as RelevanceResult;
  } catch {
    // Fallback: use Nova as gate
    relevanceCheck = await novaGateCheck(
      { content: task.instruction, contentType: 'prompt', submittedBy: 'orchestrator', submittedAt: getTodayISO(), taskId: task.taskId },
      requestId
    );
  }

  if (!relevanceCheck.approved) {
    return {
      taskId: task.taskId,
      status: 'rejected_by_gate',
      output: `Input rejected. Score: ${relevanceCheck.score}/100. Reason: ${relevanceCheck.reason}`,
      relevanceCheck,
      completedAt: getTodayISO(),
      durationMs: Date.now() - t0,
    };
  }

  // Step 2: Run Nova
  let output: string;
  try {
    const result = await callNovaWithRetry({
      modelId: MODEL_FOR_ROLE.orchestrator,
      systemPrompt: getOrchestratorSystemPrompt(),
      userMessage: task.instruction,
      maxTokens: 8096,
      temperature: 0.7,
      role: 'orchestrator',
    });
    output = result.content;
  } catch (err) {
    return { taskId: task.taskId, status: 'failed', output: '', relevanceCheck, completedAt: getTodayISO(), durationMs: Date.now() - t0, error: String(err).slice(0, 300) };
  }

  if (!output.trim()) {
    return { taskId: task.taskId, status: 'failed', output: 'Nova returned empty output', relevanceCheck, completedAt: getTodayISO(), durationMs: Date.now() - t0, error: 'Empty output' };
  }

  // Step 3: Gate check the output
  let outputGate: RelevanceResult;
  try {
    const gateRes = await internalFetch('module1-relevance-gate', '/check', {
      method: 'POST',
      body: JSON.stringify({ content: output, contentType: 'output', submittedBy: 'orchestrator', taskId: task.taskId }),
    }, 32_000);
    outputGate = await gateRes.json() as RelevanceResult;
  } catch {
    outputGate = await novaGateCheck({ content: output, contentType: 'output', submittedBy: 'orchestrator', submittedAt: getTodayISO(), taskId: task.taskId }, requestId);
  }

  if (!outputGate.approved) {
    return { taskId: task.taskId, status: 'rejected_by_gate', output: `Output rejected. Score: ${outputGate.score}/100. Issues: ${outputGate.flaggedIssues.join('; ')}`, relevanceCheck: outputGate, completedAt: getTodayISO(), durationMs: Date.now() - t0 };
  }

  // Step 4: Audit (if required)
  if (task.requiresAudit) {
    let audit: AuditResult;
    try {
      const auditRes = await internalFetch('module2-auditor', '/audit', {
        method: 'POST',
        body: JSON.stringify({ content: output, contentType: 'output', auditDate: getTodayDate(), taskId: task.taskId }),
      }, 55_000);
      audit = await auditRes.json() as AuditResult;
    } catch {
      // Fallback: use Nova as auditor
      audit = await novaAudit({ content: output, contentType: 'output', auditDate: getTodayDate(), taskId: task.taskId }, requestId);
    }

    const durationMs = Date.now() - t0;
    if (!audit.passed && audit.recommendation === 'reject') {
      return { taskId: task.taskId, status: 'rejected_by_audit', output: `Rejected by audit: ${audit.summary}`, relevanceCheck: outputGate, auditResult: audit, completedAt: getTodayISO(), durationMs };
    }

    return { taskId: task.taskId, status: 'completed', output, relevanceCheck: outputGate, auditResult: audit, completedAt: getTodayISO(), durationMs, userId: task.userId };
  }

  return { taskId: task.taskId, status: 'completed', output, relevanceCheck: outputGate, completedAt: getTodayISO(), durationMs: Date.now() - t0, userId: task.userId };
}

// ── Persist + emit helpers ────────────────────────────────────

async function emitEvent(type: string, payload: Record<string, unknown>, taskId?: string) {
  try {
    await internalFetch('module9-events', '/emit', {
      method: 'POST',
      body: JSON.stringify({ type, source: 'module13-nova', payload, emittedAt: getTodayISO(), taskId }),
    }, 3_000);
  } catch { /* best-effort */ }
}

async function persistNovaCall(callId: string, modelId: string, role: string, taskId: string | undefined, inputTokens: number, outputTokens: number, latencyMs: number, success: boolean) {
  try {
    await internalFetch('module6-database', '/nova-calls', {
      method: 'POST',
      body: JSON.stringify({ callId, modelId, role, taskId: taskId ?? null, inputTokens, outputTokens, latencyMs, success, calledAt: getTodayISO() }),
    }, 3_000);
  } catch { /* best-effort */ }
}

// ── Schemas ───────────────────────────────────────────────────

const DirectCallSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  systemPrompt: z.string().max(10_000).optional(),
  model: z.enum(['micro', 'lite', 'pro', 'premier', 'lite2']).optional(),
  modelId: z.string().optional(),
  maxTokens: z.number().int().min(1).max(32768).optional(),
  temperature: z.number().min(0).max(1).optional(),
  topP: z.number().min(0).max(1).optional(),
  taskId: z.string().uuid().optional(),
  stream: z.boolean().optional(),
});

const GateCheckSchema = z.object({
  content: z.string().min(1).max(50_000),
  contentType: z.enum(['code', 'package', 'prompt', 'audit', 'output', 'solidity', 'transaction']),
  submittedBy: z.enum(['orchestrator', 'auditor', 'human', 'mcp', 'blockchain']).default('orchestrator'),
  taskId: z.string().uuid().optional(),
});

const AuditSchema = z.object({
  content: z.string().min(1).max(50_000),
  contentType: z.enum(['code', 'output', 'recommendation', 'solidity']).default('output'),
  taskId: z.string().uuid(),
  auditDate: z.string().optional(),
  userId: z.string().optional(),
});

const OrchestrateSchema = z.object({
  instruction: z.string().min(1).max(8000),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  requiresAudit: z.boolean().default(true),
  useMcp: z.boolean().default(false),
  userId: z.string().optional(),
  chainId: z.number().int().positive().optional(),
  walletAddress: z.string().optional(),
});

const CompareSchema = z.object({
  instruction: z.string().min(1).max(8000),
  requiresAudit: z.boolean().default(false),
  userId: z.string().optional(),
});

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => ({
  service: 'module13-nova',
  agent: 'amazon-nova',
  status: 'online',
  date: getTodayDate(),
  timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  version: JSON.stringify({
    mode: NOVA_MODE,
    models: {
      orchestrator: MODEL_FOR_ROLE.orchestrator,
      gate: MODEL_FOR_ROLE.gate,
      auditor: MODEL_FOR_ROLE.auditor,
    },
  }),
  dependencies: {
    database: getServiceUrl('module6-database'),
    events: getServiceUrl('module9-events'),
    gate: getServiceUrl('module1-relevance-gate'),
    auditor: getServiceUrl('module2-auditor'),
  },
}));

// GET /models — list all available Nova models
fastify.get('/models', async () => ({
  models: Object.entries(NOVA_MODELS).map(([key, id]) => ({
    key,
    modelId: id,
    role: key === 'micro' ? 'gate/fast' : key === 'lite' || key === 'lite2' ? 'auditor/balanced' : 'orchestrator/complex',
    configured: Object.values(MODEL_FOR_ROLE).includes(id),
  })),
  configured: MODEL_FOR_ROLE,
  mode: NOVA_MODE,
}));

// GET /metrics — Nova engine performance metrics
fastify.get('/metrics', async () => ({
  service: 'module13-nova',
  timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  calls: {
    total: metrics.totalCalls,
    success: metrics.successCalls,
    failed: metrics.failedCalls,
    successRate: metrics.totalCalls > 0 ? ((metrics.successCalls / metrics.totalCalls) * 100).toFixed(1) + '%' : 'N/A',
  },
  tokens: {
    input: metrics.totalInputTokens,
    output: metrics.totalOutputTokens,
    total: metrics.totalInputTokens + metrics.totalOutputTokens,
  },
  latency: {
    totalMs: metrics.totalLatencyMs,
    avgMs: metrics.totalCalls > 0 ? Math.round(metrics.totalLatencyMs / metrics.totalCalls) : 0,
  },
  byModel: metrics.byModel,
  byRole: metrics.byRole,
}));

// GET /history — recent call history
fastify.get('/history', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 200);
  const role = q['role'];
  let history = callHistory;
  if (role) history = history.filter(c => c.role === role);
  return { total: history.length, calls: history.slice(0, limit) };
});

// POST /call — direct Nova call with any model
fastify.post('/call', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = DirectCallSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const { prompt, systemPrompt, model, modelId, maxTokens, temperature, topP, taskId, stream } = parsed.data;

  // Resolve model ID
  const resolvedModelId = modelId ?? (model ? NOVA_MODELS[model] : MODEL_FOR_ROLE.orchestrator);

  if (stream) {
    // Streaming response via SSE
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');

    let fullContent = '';
    try {
      const stats = await callNovaStream(
        { modelId: resolvedModelId, systemPrompt, userMessage: prompt, maxTokens, temperature, topP, role: 'direct' },
        (chunk) => {
          fullContent += chunk;
          reply.raw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
      );
      reply.raw.write(`data: ${JSON.stringify({ done: true, ...stats, content: fullContent })}\n\n`);
      void emitEvent('nova.call_complete', { modelId: resolvedModelId, role: 'direct', tokens: stats.inputTokens + stats.outputTokens }, taskId);
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: String(err).slice(0, 200) })}\n\n`);
    }
    reply.raw.end();
    return reply;
  }

  // Standard response
  try {
    const result = await callNovaWithRetry({
      modelId: resolvedModelId,
      systemPrompt,
      userMessage: prompt,
      maxTokens,
      temperature,
      topP,
      role: 'direct',
    });

    void persistNovaCall(crypto.randomUUID(), resolvedModelId, 'direct', taskId, result.inputTokens, result.outputTokens, result.latencyMs, true);
    void emitEvent('nova.call_complete', { modelId: resolvedModelId, inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs }, taskId);

    return reply.send({
      content: result.content,
      modelId: result.modelId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      stopReason: result.stopReason,
    });
  } catch (err) {
    fastify.log.error({ requestId, err }, 'Nova direct call failed');
    return reply.status(502).send({ error: 'Nova call failed: ' + String(err).slice(0, 300) });
  }
});

// POST /gate/check — Nova as relevance gate (same contract as module1 /check)
fastify.post('/gate/check', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = GateCheckSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const gateReq: RelevanceRequest = { ...parsed.data, submittedAt: getTodayISO() };
  const result = await novaGateCheck(gateReq, requestId);

  // Persist to DB (same table as module1)
  try {
    await internalFetch('module6-database', '/gate-decisions', {
      method: 'POST',
      body: JSON.stringify({
        taskId: parsed.data.taskId ?? null,
        contentType: gateReq.contentType,
        approved: result.approved,
        score: result.score,
        reason: result.reason,
        flaggedIssues: result.flaggedIssues,
        checkedAt: result.checkedAt,
        relevanceDate: result.relevanceDate,
        submittedBy: 'module13-nova',
      }),
    }, 3_000);
  } catch { /* best-effort */ }

  reply.header('X-Gate-Score', String(result.score));
  reply.header('X-Gate-Approved', String(result.approved));
  reply.header('X-Nova-Model', MODEL_FOR_ROLE.gate);
  return reply.status(result.approved ? 200 : 422).send(result);
});

// POST /audit — Nova as auditor (same contract as module2 /audit)
fastify.post('/audit', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = AuditSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const auditReq: AuditRequest = { ...parsed.data, auditDate: getTodayDate() };
  const result = await novaAudit(auditReq, requestId);

  // Persist to DB (same table as module2)
  try {
    await internalFetch('module6-database', '/audit-logs', {
      method: 'POST',
      body: JSON.stringify({ taskId: result.taskId, auditDate: result.auditDate, auditedAt: result.auditedAt, passed: result.passed, recommendation: result.recommendation, summary: result.summary, findings: result.findings, userId: parsed.data.userId ?? null }),
    }, 3_000);
  } catch { /* best-effort */ }

  void emitEvent(result.passed ? 'task.completed' : 'task.rejected_by_audit', { taskId: result.taskId, passed: result.passed, recommendation: result.recommendation, source: 'nova' });

  reply.header('X-Audit-Passed', String(result.passed));
  reply.header('X-Audit-Recommendation', result.recommendation);
  reply.header('X-Nova-Model', MODEL_FOR_ROLE.auditor);
  return reply.status(result.passed ? 200 : 422).send(result);
});

// POST /task — Nova as orchestrator (same contract as module3 /task)
fastify.post('/task', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = OrchestrateSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const task: OrchestratorTask = {
    taskId: crypto.randomUUID(),
    instruction: parsed.data.instruction,
    priority: parsed.data.priority,
    requiresAudit: parsed.data.requiresAudit,
    useMcp: parsed.data.useMcp,
    createdAt: getTodayISO(),
    requestedBy: 'human',
    userId: parsed.data.userId,
    chainId: parsed.data.chainId,
    walletAddress: parsed.data.walletAddress,
  };

  try {
    const result = await novaPipeline(task, requestId);

    // Persist task
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
          relevanceScore: result.relevanceCheck?.score ?? 0,
          auditPassed: result.auditResult?.passed ?? null,
          auditRecommendation: result.auditResult?.recommendation ?? null,
          userId: task.userId ?? null,
          fullOutput: result.output,
        }),
      }, 5_000);
    } catch { /* best-effort */ }

    void emitEvent(
      result.status === 'completed' ? 'task.completed' : result.status === 'rejected_by_gate' ? 'task.rejected_by_gate' : result.status === 'rejected_by_audit' ? 'task.rejected_by_audit' : 'task.failed',
      { taskId: task.taskId, status: result.status, source: 'nova', durationMs: result.durationMs },
      task.taskId
    );

    reply.header('X-Task-Id', task.taskId);
    reply.header('X-Task-Status', result.status);
    reply.header('X-Nova-Model', MODEL_FOR_ROLE.orchestrator);
    return reply.status(result.status === 'completed' ? 200 : 422).send(result);
  } catch (err) {
    fastify.log.error({ taskId: task.taskId, err }, 'Nova pipeline threw');
    return reply.status(500).send({ taskId: task.taskId, status: 'failed', error: String(err).slice(0, 300) });
  }
});

// POST /compare — run the same instruction through both Claude AND Nova, return both results
fastify.post('/compare', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = CompareSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const { instruction, requiresAudit, userId } = parsed.data;
  const taskIdNova = crypto.randomUUID();
  const taskIdClaude = crypto.randomUUID();

  // Run both in parallel
  const [novaResult, claudeResult] = await Promise.allSettled([
    // Nova path
    novaPipeline({
      taskId: taskIdNova,
      instruction,
      priority: 'medium',
      requiresAudit,
      useMcp: false,
      createdAt: getTodayISO(),
      requestedBy: 'human',
      userId,
    }, requestId),
    // Claude path via module3
    internalFetch('module3-orchestrator', '/task', {
      method: 'POST',
      body: JSON.stringify({ instruction, priority: 'medium', requiresAudit, useMcp: false, userId }),
    }, 180_000).then(r => r.json() as Promise<OrchestratorResult>),
  ]);

  return reply.send({
    instruction: instruction.slice(0, 200),
    nova: {
      taskId: taskIdNova,
      model: MODEL_FOR_ROLE.orchestrator,
      result: novaResult.status === 'fulfilled' ? novaResult.value : { error: (novaResult as PromiseRejectedResult).reason?.message },
    },
    claude: {
      taskId: taskIdClaude,
      model: 'claude-sonnet-4-6',
      result: claudeResult.status === 'fulfilled' ? claudeResult.value : { error: (claudeResult as PromiseRejectedResult).reason?.message },
    },
    comparedAt: getTodayISO(),
  });
});

// POST /fallback/task — called by module3 when Claude fails — Nova picks it up
fastify.post('/fallback/task', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const b = req.body as OrchestratorTask;
  if (!b.taskId || !b.instruction) return reply.status(400).send({ error: 'taskId and instruction required' });

  fastify.log.info({ taskId: b.taskId }, 'Nova fallback activated for failed Claude task');
  void emitEvent('nova.fallback_activated', { taskId: b.taskId, reason: 'Claude unavailable' }, b.taskId);

  try {
    const result = await novaPipeline(b, requestId);
    reply.header('X-Nova-Fallback', 'true');
    reply.header('X-Nova-Model', MODEL_FOR_ROLE.fallback);
    return reply.status(result.status === 'completed' ? 200 : 422).send(result);
  } catch (err) {
    return reply.status(500).send({ taskId: b.taskId, status: 'failed', error: String(err).slice(0, 300) });
  }
});

// GET /mode — current operating mode and configuration
fastify.get('/mode', async () => ({
  mode: NOVA_MODE,
  description: {
    standalone: 'Nova is the primary AI engine replacing Claude',
    gate: 'Nova acts as the relevance gate replacing DeepSeek',
    auditor: 'Nova acts as the security auditor replacing Gemini',
    fallback: 'Nova activates only when primary AI (Claude) fails',
    all: 'Nova handles all roles simultaneously',
  }[NOVA_MODE] ?? 'Unknown mode',
  models: MODEL_FOR_ROLE,
  region: process.env.AWS_REGION ?? 'us-east-1',
  timestamp: getTodayISO(),
}));

// POST /mode — change operating mode at runtime
fastify.post('/mode', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const newMode = String(b['mode'] ?? '') as NovaMode;
  const validModes: NovaMode[] = ['standalone', 'gate', 'auditor', 'fallback', 'all'];
  if (!validModes.includes(newMode)) {
    return reply.status(400).send({ error: `Invalid mode. Valid: ${validModes.join(', ')}` });
  }
  process.env['NOVA_MODE'] = newMode;
  void emitEvent('nova.mode_changed', { newMode, changedAt: getTodayISO() });
  return { ok: true, mode: newMode, changedAt: getTodayISO() };
});

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    // Validate AWS credentials
    if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_ROLE_ARN) {
      fastify.log.warn('AWS_ACCESS_KEY_ID not set — will attempt IAM role / instance profile auth');
    }

    // Test Bedrock connectivity with a minimal call
    try {
      await callNova({
        modelId: NOVA_MODELS.micro,
        userMessage: 'Respond with only the word: READY',
        maxTokens: 10,
        temperature: 0,
        role: 'startup_check',
      });
      fastify.log.info('Bedrock connectivity: OK');
    } catch (err) {
      fastify.log.warn({ err }, 'Bedrock connectivity check failed — module will start but calls may fail. Check AWS credentials and model access permissions.');
    }

    await fastify.listen({ port: 3013, host: '0.0.0.0' });
    fastify.log.info('⬡  Amazon Nova Engine online — port 3013');
    fastify.log.info(`📅 ${getTodayDate()} | Mode: ${NOVA_MODE} | Region: ${process.env.AWS_REGION ?? 'us-east-1'}`);
    fastify.log.info(`🤖 Orchestrator: ${MODEL_FOR_ROLE.orchestrator}`);
    fastify.log.info(`🔒 Gate: ${MODEL_FOR_ROLE.gate}`);
    fastify.log.info(`🔍 Auditor: ${MODEL_FOR_ROLE.auditor}`);
    fastify.log.info(`⬡  Routes: /call | /gate/check | /audit | /task | /compare | /fallback/task`);
  } catch (err) { fastify.log.error(err, 'Nova Engine failed to start'); process.exit(1); }
};
start();
