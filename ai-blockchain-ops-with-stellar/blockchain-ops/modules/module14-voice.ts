// ============================================================
// MODULE 14: VOICE ENGINE
// Provider: ElevenLabs via @elevenlabs/elevenlabs-js
// Role: Text-to-speech for the entire system. Every module
//       that produces output can speak it. Auto-triggered by
//       module9 events for real-time voice alerts.
//
// Integrations:
//   module2  (auditor)     → speaks audit results
//   module3  (orchestrator)→ speaks AI task output
//   module9  (events)      → auto-speaks blockchain events
//   module11 (blockchain)  → tx confirmations, gas spikes
//   module13 (nova)        → speaks Nova AI output
//   module12 (frontend)    → receives audio stream for playback
//
// Routes:
//   POST /speak            → text → MP3 bytes (download/play)
//   POST /speak-stream     → text → chunked audio stream (SSE)
//   POST /speak-event      → system event payload → voice alert
//   POST /speak-result     → OrchestratorResult → full readout
//   POST /speak-audit      → AuditResult → audit readout
//   POST /speak-tx         → TransactionResult → tx readout
//   POST /speak-gas        → GasEstimate → gas report
//   GET  /voices           → list all available voices
//   GET  /voice/:id        → single voice details
//   GET  /history          → recent TTS generations
//   GET  /metrics          → usage metrics
//   GET  /health           → health + quota status
// Port: 3014
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { z } from 'zod';
import crypto from 'crypto';
import { getTodayISO, getTodayDate } from '../shared/date-utils.js';
import { internalFetch, verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';
import {
  OrchestratorResult, AuditResult, TransactionResult,
  GasEstimate, SystemEvent, HealthStatus,
} from '../shared/types.js';

const SERVICE_START = Date.now();

// ── ElevenLabs Models ─────────────────────────────────────────

export const ELEVEN_MODELS = {
  flash:         'eleven_flash_v2_5',        // ~75ms latency, 32 languages, alerts
  turbo:         'eleven_turbo_v2_5',        // ~250ms, 32 languages, interactive
  multilingual:  'eleven_multilingual_v2',   // highest quality, 70+ languages, 10k chars
  v3:            'eleven_v3',                // max expressiveness, 70+ languages, 3k chars
} as const;

type ElevenModelKey = keyof typeof ELEVEN_MODELS;

// ── Default voices (ElevenLabs built-in voice IDs) ───────────

export const PRESET_VOICES = {
  rachel:  '21m00Tcm4TlvDq8ikWAM',  // Rachel — calm, clear, US English
  domi:    'AZnzlk1XvdvUeBnXmlld',  // Domi — strong, confident
  bella:   'EXAVITQu4vr4xnSDxMaL',  // Bella — soft, warm
  arnold:  'VR6AewLTigWG4xSOukaG',  // Arnold — deep, authoritative — good for alerts
  adam:    'pNInz6obpgDQGcFmaJgB',  // Adam — deep, neutral — good for readouts
  sam:     'yoZ06aMxZJJ28mfd3POQ',  // Sam — raspy, intense
} as const;

// ── Config ────────────────────────────────────────────────────

const DEFAULT_VOICE_ID  = process.env.ELEVENLABS_VOICE_ID  ?? PRESET_VOICES.rachel;
const ALERT_VOICE_ID    = process.env.ELEVENLABS_ALERT_VOICE_ID ?? PRESET_VOICES.arnold;
const DEFAULT_MODEL     = (process.env.ELEVENLABS_MODEL ?? ELEVEN_MODELS.flash) as string;
const ALERT_MODEL       = ELEVEN_MODELS.flash; // always use flash for alerts — lowest latency

// Auto-speak settings — which events trigger automatic voice
const AUTO_SPEAK_EVENTS = new Set(
  (process.env.ELEVENLABS_AUTO_EVENTS ?? [
    'blockchain.tx_confirmed',
    'blockchain.tx_failed',
    'blockchain.contract_deployed',
    'blockchain.gas_spike',
    'blockchain.simulation_failed',
    'gate.circuit_opened',
    'gate.circuit_closed',
    'task.completed',
    'task.rejected_by_audit',
    'secret.expired',
    'system.degraded',
  ].join(',')).split(',').filter(Boolean)
);

const MAX_TEXT_LENGTH = 5000; // truncate before sending to ElevenLabs

// ── Fastify ───────────────────────────────────────────────────

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 60_000,
});

await fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGIN ?? '*',
  exposedHeaders: ['Content-Type', 'X-Voice-Id', 'X-Model-Id', 'X-Characters-Used'],
});
await fastify.register(rateLimit, { max: 60, timeWindow: '1 minute' });

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.url === '/health' || req.url === '/voices' || req.url === '/metrics' || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
});

// ── ElevenLabs client ─────────────────────────────────────────

const eleven = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY!,
  timeoutInSeconds: 30,
  maxRetries: 2,
});

// ── Audio cache — identical text+voice skips API call ─────────

const AUDIO_CACHE_MAX = parseInt(process.env.VOICE_CACHE_MAX ?? '100');
const AUDIO_CACHE_TTL_MS = parseInt(process.env.VOICE_CACHE_TTL_MS ?? String(60 * 60 * 1000)); // 1 hour

interface AudioCacheEntry { buffer: Buffer; characters: number; cachedAt: number; hits: number }
const audioCache = new Map<string, AudioCacheEntry>();

function audioCacheKey(text: string, voiceId: string, modelId: string): string {
  return crypto.createHash('sha256').update(`${voiceId}:${modelId}:${text}`).digest('hex');
}
function getAudioCached(key: string): Buffer | null {
  const e = audioCache.get(key);
  if (!e) return null;
  if (Date.now() - e.cachedAt > AUDIO_CACHE_TTL_MS) { audioCache.delete(key); return null; }
  e.hits++;
  metrics.cacheHits++;
  return e.buffer;
}
function setAudioCache(key: string, buffer: Buffer, characters: number) {
  if (audioCache.size >= AUDIO_CACHE_MAX) {
    const oldest = audioCache.keys().next().value;
    if (oldest) audioCache.delete(oldest);
  }
  audioCache.set(key, { buffer, characters, cachedAt: Date.now(), hits: 0 });
}

// ── Character quota tracking ──────────────────────────────────

const MONTHLY_CHAR_LIMIT = parseInt(process.env.ELEVENLABS_MONTHLY_CHAR_LIMIT ?? '500000');
const quotaTracker = {
  usedThisMonth: 0,
  monthStart: new Date().toISOString().slice(0, 7), // YYYY-MM
  track(chars: number) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (currentMonth !== this.monthStart) { this.usedThisMonth = 0; this.monthStart = currentMonth; }
    this.usedThisMonth += chars;
    const percentUsed = (this.usedThisMonth / MONTHLY_CHAR_LIMIT) * 100;
    if (percentUsed >= 90) fastify.log.warn({ usedThisMonth: this.usedThisMonth, limit: MONTHLY_CHAR_LIMIT, percentUsed: percentUsed.toFixed(1) }, 'ElevenLabs character quota at 90%+');
    if (percentUsed >= 100) fastify.log.error({ usedThisMonth: this.usedThisMonth, limit: MONTHLY_CHAR_LIMIT }, 'ElevenLabs character quota EXCEEDED');
  },
  get remaining() { return Math.max(0, MONTHLY_CHAR_LIMIT - this.usedThisMonth); },
  get percentUsed() { return ((this.usedThisMonth / MONTHLY_CHAR_LIMIT) * 100).toFixed(1) + '%'; },
};

// ── SSML helper — better pronunciation for addresses and hashes ─

function applySSML(text: string): string {
  // Replace Ethereum addresses with spoken version
  return text
    .replace(/0x([0-9a-fA-F]{40})/g, (_, addr) => `0x${addr.slice(0, 4)} dot dot dot ${addr.slice(-4)}`)
    .replace(/0x([0-9a-fA-F]{64})/g, (_, hash) => `hash ${hash.slice(0, 6)} dot dot dot ${hash.slice(-4)}`)
    .replace(/(\d{10,})/g, (n) => n.length > 15 ? n.slice(0, 6) + ' trillion' : n) // shorten huge numbers
    .replace(/([A-Z]{3,10})/g, (sym) => sym.split('').join(' ')); // spell out token symbols like ETH → E T H
}

// ── Metrics ───────────────────────────────────────────────────

const metrics = {
  totalGenerations: 0,
  totalCharacters: 0,
  totalAlerts: 0,
  totalStreams: 0,
  successCount: 0,
  failureCount: 0,
  cacheHits: 0,
  totalLatencyMs: 0,
  byEvent: {} as Record<string, number>,
  byVoice: {} as Record<string, number>,
  byModel: {} as Record<string, number>,
};

function trackGeneration(voiceId: string, modelId: string, chars: number, latencyMs: number, success: boolean) {
  metrics.totalGenerations++;
  metrics.totalCharacters += chars;
  if (success) metrics.successCount++; else metrics.failureCount++;
  metrics.totalLatencyMs += latencyMs;
  metrics.byVoice[voiceId] = (metrics.byVoice[voiceId] ?? 0) + 1;
  metrics.byModel[modelId] = (metrics.byModel[modelId] ?? 0) + 1;
  quotaTracker.track(chars);
}

// ── Recent generation history ─────────────────────────────────

interface GenRecord {
  genId: string;
  voiceId: string;
  modelId: string;
  textPreview: string;
  characters: number;
  latencyMs: number;
  source: string;
  generatedAt: string;
  success: boolean;
  fromCache: boolean;
}
const genHistory: GenRecord[] = [];
function recordGen(g: GenRecord) {
  genHistory.unshift(g);
  if (genHistory.length > 100) genHistory.pop();
}

// ── Emit event helper ─────────────────────────────────────────

async function emitEvent(type: string, payload: Record<string, unknown>) {
  try {
    await internalFetch('module9-events', '/emit', {
      method: 'POST',
      body: JSON.stringify({ type, source: 'module14-voice', payload, emittedAt: getTodayISO() }),
    }, 3_000);
  } catch { /* best-effort */ }
}

// ── Core TTS — returns Buffer of MP3 audio ────────────────────

interface TTSOptions {
  text: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speakerBoost?: boolean;
  source?: string;
  useSSML?: boolean;    // apply SSML preprocessing for addresses/hashes
  skipCache?: boolean;  // force regeneration even if cached
}

async function generateSpeech(opts: TTSOptions): Promise<{ buffer: Buffer; characters: number; latencyMs: number; fromCache: boolean }> {
  const t0 = Date.now();
  let text = opts.text.slice(0, MAX_TEXT_LENGTH);
  const voiceId = opts.voiceId ?? DEFAULT_VOICE_ID;
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const genId = crypto.randomUUID();

  // Apply SSML preprocessing — make addresses and hashes speakable
  if (opts.useSSML !== false) {
    text = applySSML(text);
  }

  // Check quota before hitting API
  if (quotaTracker.remaining < text.length) {
    fastify.log.error({ remaining: quotaTracker.remaining, requested: text.length, percentUsed: quotaTracker.percentUsed }, 'ElevenLabs character quota exceeded — cannot generate speech');
    throw new Error(`ElevenLabs quota exceeded. ${quotaTracker.remaining} characters remaining this month.`);
  }

  // Check audio cache
  if (!opts.skipCache) {
    const cacheKey = audioCacheKey(text, voiceId, modelId);
    const cached = getAudioCached(cacheKey);
    if (cached) {
      const latencyMs = Date.now() - t0;
      fastify.log.debug({ source: opts.source, textLen: text.length, latencyMs }, 'TTS cache hit');
      recordGen({ genId, voiceId, modelId, textPreview: text.slice(0, 80), characters: text.length, latencyMs, source: opts.source ?? 'direct', generatedAt: getTodayISO(), success: true, fromCache: true });
      return { buffer: cached, characters: text.length, latencyMs, fromCache: true };
    }
  }

  try {
    const audioStream = await eleven.textToSpeech.convert(voiceId, {
      text,
      modelId,
      voiceSettings: {
        stability: opts.stability ?? 0.5,
        similarityBoost: opts.similarityBoost ?? 0.75,
        style: opts.style ?? 0,
        useSpeakerBoost: opts.speakerBoost ?? true,
      },
    });

    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const latencyMs = Date.now() - t0;

    trackGeneration(voiceId, modelId, text.length, latencyMs, true);
    recordGen({ genId, voiceId, modelId, textPreview: text.slice(0, 80), characters: text.length, latencyMs, source: opts.source ?? 'direct', generatedAt: getTodayISO(), success: true, fromCache: false });

    // Store in audio cache
    if (!opts.skipCache) {
      setAudioCache(audioCacheKey(text, voiceId, modelId), buffer, text.length);
    }

    fastify.log.debug({ source: opts.source, textLen: text.length, audioBytes: buffer.length, latencyMs, voiceId, modelId }, 'TTS generated');

    return { buffer, characters: text.length, latencyMs, fromCache: false };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    trackGeneration(voiceId, modelId, text.length, latencyMs, false);
    recordGen({ genId, voiceId, modelId, textPreview: text.slice(0, 80), characters: text.length, latencyMs, source: opts.source ?? 'direct', generatedAt: getTodayISO(), success: false, fromCache: false });
    fastify.log.error({ source: opts.source, textLen: text.length, latencyMs, err: String(err).slice(0, 100) }, 'TTS generation failed');
    throw err;
  }
}

// ── Event → voice alert text builder ─────────────────────────

function eventToSpeech(event: SystemEvent): string | null {
  const p = event.payload ?? {};
  const type = event.type;

  switch (type) {
    case 'blockchain.tx_confirmed':
      return `Transaction confirmed on chain ${p['chainId'] ?? 'unknown'}. Hash ${String(p['txHash'] ?? '').slice(0, 10)}.`;

    case 'blockchain.tx_failed':
    case 'blockchain.tx_reverted':
      return `Warning. Transaction failed on chain ${p['chainId'] ?? 'unknown'}. ${p['error'] ? 'Error: ' + String(p['error']).slice(0, 100) : 'Check gas limit and contract.'}`;

    case 'blockchain.contract_deployed':
      return `Contract deployed successfully. Address ${String(p['contractAddress'] ?? '').slice(0, 10)} on chain ${p['chainId'] ?? 'unknown'}.`;

    case 'blockchain.gas_spike':
      return `Gas alert. Base fee is now ${p['baseFeeGwei'] ?? 'unknown'} gwei on chain ${p['chainId'] ?? 'unknown'}.`;

    case 'blockchain.simulation_failed':
      return `Transaction simulation failed. Do not send. ${p['trace'] ? String(p['trace']).slice(0, 150) : ''}`;

    case 'blockchain.simulation_passed':
      return `Simulation passed. Transaction is safe to send.`;

    case 'gate.circuit_opened':
      return `Alert. The relevance gate circuit breaker has opened. DeepSeek is failing. Nova fallback is active.`;

    case 'gate.circuit_closed':
      return `Gate circuit breaker reset. DeepSeek is back online.`;

    case 'task.completed':
      return `AI task completed. Duration ${p['durationMs'] ? Math.round(Number(p['durationMs']) / 1000) + ' seconds' : 'unknown'}.`;

    case 'task.rejected_by_audit':
      return `Task rejected by security audit. Review findings before proceeding.`;

    case 'task.rejected_by_gate':
      return `Task rejected by relevance gate. Content did not pass security checks.`;

    case 'secret.expired':
      return `Alert. Secret ${p['name'] ?? 'unknown'} has expired and must be rotated immediately.`;

    case 'secret.expiring_soon':
      return `Warning. Secret ${p['name'] ?? 'unknown'} expires in ${p['daysRemaining'] ?? 'a few'} days.`;

    case 'system.degraded':
      return `System alert. One or more modules are degraded. Check admin dashboard.`;

    case 'system.recovered':
      return `System recovered. All modules are back online.`;

    case 'nova.fallback_activated':
      return `Amazon Nova fallback activated. Claude is unavailable. Nova is handling requests.`;

    case 'auth.login_failed':
      return `Authentication failed for email ${p['email'] ? String(p['email']).split('@')[0] : 'unknown'}.`;

    default:
      return null; // no speech for unknown events
  }
}

// ── Orchestrator result → readable summary ────────────────────

function orchestratorResultToSpeech(result: OrchestratorResult): string {
  if (result.status === 'completed') {
    const outputPreview = result.output
      .replace(/```[\s\S]*?```/g, 'code block')
      .replace(/[#*`_]/g, '')
      .slice(0, 500);
    return `Task completed. Gate score: ${result.relevanceCheck?.score ?? 'unknown'} out of 100. ${result.auditResult ? 'Audit ' + result.auditResult.recommendation + '.' : ''} Output: ${outputPreview}`;
  }
  if (result.status === 'rejected_by_gate') return `Task rejected by gate. Score: ${result.relevanceCheck?.score ?? 0} out of 100. Reason: ${result.relevanceCheck?.reason ?? 'unknown'}.`;
  if (result.status === 'rejected_by_audit') return `Task rejected by security audit. ${result.auditResult?.summary?.slice(0, 200) ?? ''}`;
  return `Task failed. ${result.error?.slice(0, 200) ?? 'Unknown error.'}`;
}

// ── Audit result → readable summary ──────────────────────────

function auditResultToSpeech(result: AuditResult): string {
  const critCount = result.findings.filter(f => f.severity === 'critical').length;
  const warnCount = result.findings.filter(f => f.severity === 'warning').length;
  const baseMsg = result.passed
    ? `Audit passed. Recommendation: ${result.recommendation}.`
    : `Audit failed. Recommendation: ${result.recommendation}.`;
  const findingsMsg = result.findings.length > 0
    ? ` Found ${critCount} critical and ${warnCount} warning issues.`
    : ' No issues found.';
  const summaryMsg = result.summary ? ` Summary: ${result.summary.slice(0, 200)}` : '';
  return baseMsg + findingsMsg + summaryMsg;
}

// ── Transaction result → readable summary ────────────────────

function txResultToSpeech(result: TransactionResult): string {
  if (result.status === 'confirmed') {
    return `Transaction confirmed in block ${result.blockNumber ?? 'unknown'}. Gas used: ${result.gasUsed ?? 'unknown'}. Hash: ${(result.txHash ?? '').slice(0, 10)}.`;
  }
  if (result.status === 'submitted') return `Transaction submitted. Hash: ${(result.txHash ?? '').slice(0, 10)}. Waiting for confirmation.`;
  if (result.status === 'reverted') return `Transaction reverted. Check contract logic. Hash: ${(result.txHash ?? '').slice(0, 10)}.`;
  if (result.status === 'failed') return `Transaction failed. ${result.error?.slice(0, 150) ?? ''}`;
  return `Transaction status: ${result.status}.`;
}

// ── Gas estimate → readable summary ──────────────────────────

function gasEstimateToSpeech(gas: GasEstimate): string {
  return `Gas report for chain ${gas.chainId}. Base fee: ${parseFloat(gas.baseFeeGwei).toFixed(2)} gwei. Max fee: ${parseFloat(gas.maxFeeGwei).toFixed(2)} gwei. Transfer cost: ${gas.estimatedCostEth} ETH${gas.estimatedCostUsd ? ', approximately $' + gas.estimatedCostUsd : ''}.`;
}

// ── Schemas ───────────────────────────────────────────────────

const SpeakSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  voiceId: z.string().optional(),
  voicePreset: z.enum(['rachel', 'domi', 'bella', 'arnold', 'adam', 'sam']).optional(),
  model: z.enum(['flash', 'turbo', 'multilingual', 'v3']).optional(),
  modelId: z.string().optional(),
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speakerBoost: z.boolean().optional(),
  taskId: z.string().uuid().optional(),
  source: z.string().optional(),
});

const EventSpeakSchema = z.object({
  eventId: z.string().optional(),
  type: z.string().min(1),
  source: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  emittedAt: z.string().optional(),
  taskId: z.string().uuid().optional(),
  voiceId: z.string().optional(),
  model: z.enum(['flash', 'turbo', 'multilingual', 'v3']).optional(),
});

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => ({
  service: 'module14-voice',
  agent: 'elevenlabs',
  status: 'online',
  date: getTodayDate(),
  timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  version: JSON.stringify({
    defaultVoice: DEFAULT_VOICE_ID,
    alertVoice: ALERT_VOICE_ID,
    defaultModel: DEFAULT_MODEL,
    autoSpeakEvents: AUTO_SPEAK_EVENTS.size,
  }),
  dependencies: {
    events: getServiceUrl('module9-events'),
    database: getServiceUrl('module6-database'),
  },
}));

// GET /voices — list all available ElevenLabs voices
fastify.get('/voices', async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const result = await eleven.voices.search({});
    return reply.send({
      voices: result.voices?.map(v => ({
        voiceId: v.voiceId,
        name: v.name,
        category: v.category,
        labels: v.labels,
        previewUrl: v.previewUrl,
      })) ?? [],
      presets: Object.entries(PRESET_VOICES).map(([key, id]) => ({ key, voiceId: id })),
      count: result.voices?.length ?? 0,
    });
  } catch (err) {
    return reply.status(502).send({ error: 'Failed to fetch voices: ' + String(err).slice(0, 200) });
  }
});

// GET /voice/:voiceId — single voice details
fastify.get('/voice/:voiceId', async (req: FastifyRequest<{ Params: { voiceId: string } }>, reply: FastifyReply) => {
  try {
    const voice = await eleven.voices.get(req.params.voiceId);
    return reply.send(voice);
  } catch (err) {
    return reply.status(404).send({ error: 'Voice not found: ' + String(err).slice(0, 100) });
  }
});

// GET /models — list available TTS models
fastify.get('/models', async () => ({
  models: Object.entries(ELEVEN_MODELS).map(([key, id]) => ({
    key,
    modelId: id,
    latency: key === 'flash' ? '~75ms' : key === 'turbo' ? '~250ms' : 'standard',
    maxChars: key === 'v3' ? 3000 : key === 'multilingual' ? 10000 : 40000,
    languages: key === 'flash' || key === 'turbo' ? 32 : 70,
    bestFor: key === 'flash' ? 'alerts, real-time' : key === 'turbo' ? 'interactive' : key === 'v3' ? 'expressive, creative' : 'long-form, quality',
  })),
  configured: { default: DEFAULT_MODEL, alert: ALERT_MODEL },
}));

// GET /metrics — TTS usage metrics
fastify.get('/metrics', async () => ({
  service: 'module14-voice',
  timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  generations: {
    total: metrics.totalGenerations,
    success: metrics.successCount,
    failed: metrics.failureCount,
    successRate: metrics.totalGenerations > 0 ? ((metrics.successCount / metrics.totalGenerations) * 100).toFixed(1) + '%' : 'N/A',
    totalCharacters: metrics.totalCharacters,
    totalAlerts: metrics.totalAlerts,
    totalStreams: metrics.totalStreams,
    cacheHits: metrics.cacheHits,
    avgLatencyMs: metrics.totalGenerations > 0 ? Math.round(metrics.totalLatencyMs / metrics.totalGenerations) : 0,
  },
  quota: {
    usedThisMonth: quotaTracker.usedThisMonth,
    monthlyLimit: MONTHLY_CHAR_LIMIT,
    remaining: quotaTracker.remaining,
    percentUsed: quotaTracker.percentUsed,
    month: quotaTracker.monthStart,
  },
  cache: {
    size: audioCache.size,
    maxSize: AUDIO_CACHE_MAX,
    ttlMs: AUDIO_CACHE_TTL_MS,
    hits: metrics.cacheHits,
    hitRate: metrics.totalGenerations > 0 ? ((metrics.cacheHits / metrics.totalGenerations) * 100).toFixed(1) + '%' : 'N/A',
  },
  byVoice: metrics.byVoice,
  byModel: metrics.byModel,
  byEvent: metrics.byEvent,
  autoSpeakEvents: [...AUTO_SPEAK_EVENTS],
}));

// GET /quota — character quota status
fastify.get('/quota', async () => ({
  usedThisMonth: quotaTracker.usedThisMonth,
  monthlyLimit: MONTHLY_CHAR_LIMIT,
  remaining: quotaTracker.remaining,
  percentUsed: quotaTracker.percentUsed,
  month: quotaTracker.monthStart,
  timestamp: getTodayISO(),
}));

// DELETE /cache — clear audio cache
fastify.delete('/cache', async (_req: FastifyRequest, reply: FastifyReply) => {
  const size = audioCache.size;
  audioCache.clear();
  metrics.cacheHits = 0;
  return reply.send({ ok: true, cleared: size, timestamp: getTodayISO() });
});

// GET /history — recent generation history
fastify.get('/history', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '20'), 100);
  return { total: genHistory.length, generations: genHistory.slice(0, limit) };
});

// POST /speak — text → MP3 audio buffer (for download or direct play)
fastify.post('/speak', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = SpeakSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const { text, voicePreset, model, modelId, voiceId, stability, similarityBoost, style, speakerBoost, source } = parsed.data;

  const resolvedVoiceId = voiceId ?? (voicePreset ? PRESET_VOICES[voicePreset] : DEFAULT_VOICE_ID);
  const resolvedModelId = modelId ?? (model ? ELEVEN_MODELS[model] : DEFAULT_MODEL);

  try {
    const { buffer, characters, latencyMs } = await generateSpeech({
      text, voiceId: resolvedVoiceId, modelId: resolvedModelId,
      stability, similarityBoost, style, speakerBoost,
      source: source ?? 'api',
    });

    void emitEvent('voice.generated', { characters, latencyMs, voiceId: resolvedVoiceId, modelId: resolvedModelId, source: source ?? 'api' });

    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Content-Length', buffer.length);
    reply.header('X-Voice-Id', resolvedVoiceId);
    reply.header('X-Model-Id', resolvedModelId);
    reply.header('X-Characters-Used', characters);
    reply.header('X-Latency-Ms', latencyMs);
    return reply.send(buffer);
  } catch (err) {
    fastify.log.error({ err }, 'TTS generation failed');
    return reply.status(502).send({ error: 'TTS failed: ' + String(err).slice(0, 200) });
  }
});

// POST /speak-stream — text → chunked audio stream via SSE (lowest latency)
fastify.post('/speak-stream', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = SpeakSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const { text, voicePreset, model, modelId, voiceId } = parsed.data;
  const resolvedVoiceId = voiceId ?? (voicePreset ? PRESET_VOICES[voicePreset] : DEFAULT_VOICE_ID);
  const resolvedModelId = modelId ?? (model ? ELEVEN_MODELS[model] : DEFAULT_MODEL);

  reply.raw.setHeader('Content-Type', 'audio/mpeg');
  reply.raw.setHeader('Transfer-Encoding', 'chunked');
  reply.raw.setHeader('X-Voice-Id', resolvedVoiceId);
  reply.raw.setHeader('X-Model-Id', resolvedModelId);
  reply.raw.setHeader('X-Accel-Buffering', 'no');

  const t0 = Date.now();
  metrics.totalStreams++;

  try {
    const audioStream = await eleven.textToSpeech.stream(resolvedVoiceId, {
      text: text.slice(0, MAX_TEXT_LENGTH),
      modelId: resolvedModelId,
      voiceSettings: {
        stability: parsed.data.stability ?? 0.5,
        similarityBoost: parsed.data.similarityBoost ?? 0.75,
      },
    });

    let totalBytes = 0;
    for await (const chunk of audioStream) {
      const buf = Buffer.from(chunk);
      reply.raw.write(buf);
      totalBytes += buf.length;
    }

    const latencyMs = Date.now() - t0;
    trackGeneration(resolvedVoiceId, resolvedModelId, text.length, latencyMs, true);
    recordGen({ genId: crypto.randomUUID(), voiceId: resolvedVoiceId, modelId: resolvedModelId, textPreview: text.slice(0, 80), characters: text.length, latencyMs, source: 'stream', generatedAt: getTodayISO(), success: true });
  } catch (err) {
    fastify.log.error({ err }, 'TTS stream failed');
  }

  reply.raw.end();
  return reply;
});

// POST /speak-event — system event → auto voice alert
fastify.post('/speak-event', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = EventSpeakSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const event = parsed.data as unknown as SystemEvent;
  const speechText = eventToSpeech(event);

  if (!speechText) {
    return reply.status(204).send(); // No speech for this event type
  }

  const voiceId = parsed.data.voiceId ?? ALERT_VOICE_ID;
  const modelId = parsed.data.model ? ELEVEN_MODELS[parsed.data.model] : ALERT_MODEL;

  metrics.totalAlerts++;
  metrics.byEvent[event.type] = (metrics.byEvent[event.type] ?? 0) + 1;

  try {
    const { buffer, characters, latencyMs } = await generateSpeech({
      text: speechText, voiceId, modelId, stability: 0.6, similarityBoost: 0.8, source: 'event:' + event.type,
    });

    fastify.log.info({ eventType: event.type, characters, latencyMs }, 'Voice alert generated');

    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Content-Length', buffer.length);
    reply.header('X-Event-Type', event.type);
    reply.header('X-Voice-Id', voiceId);
    reply.header('X-Latency-Ms', latencyMs);
    return reply.send(buffer);
  } catch (err) {
    fastify.log.error({ err, eventType: event.type }, 'Voice alert failed');
    return reply.status(502).send({ error: 'Voice alert failed: ' + String(err).slice(0, 200) });
  }
});

// POST /speak-result — OrchestratorResult → full AI output readout
fastify.post('/speak-result', async (req: FastifyRequest, reply: FastifyReply) => {
  const result = req.body as OrchestratorResult;
  if (!result?.taskId) return reply.status(400).send({ error: 'OrchestratorResult required' });

  const speechText = orchestratorResultToSpeech(result);
  const voiceId = DEFAULT_VOICE_ID;

  try {
    const { buffer, latencyMs } = await generateSpeech({
      text: speechText, voiceId, modelId: DEFAULT_MODEL, source: 'orchestrator-result',
    });
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('X-Task-Id', result.taskId);
    reply.header('X-Latency-Ms', latencyMs);
    return reply.send(buffer);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /speak-audit — AuditResult → audit findings readout
fastify.post('/speak-audit', async (req: FastifyRequest, reply: FastifyReply) => {
  const result = req.body as AuditResult;
  if (!result?.taskId) return reply.status(400).send({ error: 'AuditResult required' });

  const speechText = auditResultToSpeech(result);
  const voiceId = result.passed ? DEFAULT_VOICE_ID : ALERT_VOICE_ID;
  const modelId = ELEVEN_MODELS.flash;

  try {
    const { buffer, latencyMs } = await generateSpeech({
      text: speechText, voiceId, modelId, stability: 0.5, source: 'audit-result',
    });
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('X-Audit-Passed', String(result.passed));
    reply.header('X-Latency-Ms', latencyMs);
    return reply.send(buffer);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /speak-tx — TransactionResult → transaction status readout
fastify.post('/speak-tx', async (req: FastifyRequest, reply: FastifyReply) => {
  const result = req.body as TransactionResult;
  if (!result?.taskId) return reply.status(400).send({ error: 'TransactionResult required' });

  const speechText = txResultToSpeech(result);
  const isAlert = result.status === 'failed' || result.status === 'reverted';
  const voiceId = isAlert ? ALERT_VOICE_ID : DEFAULT_VOICE_ID;

  try {
    const { buffer, latencyMs } = await generateSpeech({
      text: speechText, voiceId, modelId: ALERT_MODEL, source: 'tx-result',
    });
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('X-Tx-Status', result.status);
    reply.header('X-Latency-Ms', latencyMs);
    return reply.send(buffer);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /speak-gas — GasEstimate → gas price readout
fastify.post('/speak-gas', async (req: FastifyRequest, reply: FastifyReply) => {
  const gas = req.body as GasEstimate;
  if (!gas?.chainId) return reply.status(400).send({ error: 'GasEstimate required' });

  const speechText = gasEstimateToSpeech(gas);

  try {
    const { buffer, latencyMs } = await generateSpeech({
      text: speechText, voiceId: DEFAULT_VOICE_ID, modelId: ALERT_MODEL, source: 'gas-estimate',
    });
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('X-Chain-Id', gas.chainId);
    reply.header('X-Latency-Ms', latencyMs);
    return reply.send(buffer);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /speak-text — simple text with optional voice override (alias for /speak)
fastify.post('/speak-text', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const text = String(b['text'] ?? '').slice(0, MAX_TEXT_LENGTH);
  if (!text) return reply.status(400).send({ error: 'text required' });

  const voiceId = String(b['voiceId'] ?? DEFAULT_VOICE_ID);
  const modelId = String(b['modelId'] ?? DEFAULT_MODEL);

  try {
    const { buffer, latencyMs } = await generateSpeech({ text, voiceId, modelId, source: 'text' });
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('X-Latency-Ms', latencyMs);
    return reply.send(buffer);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /configure/auto-events — add or remove events from auto-speak list
fastify.post('/configure/auto-events', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const add = Array.isArray(b['add']) ? b['add'].map(String) : [];
  const remove = Array.isArray(b['remove']) ? b['remove'].map(String) : [];
  add.forEach(e => AUTO_SPEAK_EVENTS.add(e));
  remove.forEach(e => AUTO_SPEAK_EVENTS.delete(e));
  return reply.send({ autoSpeakEvents: [...AUTO_SPEAK_EVENTS], added: add, removed: remove });
});

// ── Module9 event subscription — auto-speak blockchain events ─
// Poll module9 events and speak them as they arrive

async function startEventListener() {
  const eventsUrl = `${getServiceUrl('module9-events')}/stream`;

  const reconnect = async () => {
    try {
      const res = await fetch(eventsUrl, {
        headers: { [INTERNAL_HEADER]: process.env.INTERNAL_SERVICE_TOKEN! },
      });
      if (!res.body) throw new Error('No SSE body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      fastify.log.info('Voice engine connected to event stream');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const lines = text.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          try {
            const event = JSON.parse(line.slice(6)) as SystemEvent;
            if (AUTO_SPEAK_EVENTS.has(event.type)) {
              // Fire and forget — don't await so we don't block the stream reader
              void speakEventAsync(event);
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      fastify.log.warn({ err }, 'Event stream disconnected — reconnecting in 5s');
    }
    await new Promise(r => setTimeout(r, 5_000));
    void reconnect();
  };

  // Start after a short delay to let other modules come online
  setTimeout(() => void reconnect(), 8_000);
}

async function speakEventAsync(event: SystemEvent) {
  const speechText = eventToSpeech(event);
  if (!speechText) return;

  try {
    const voiceId = ALERT_VOICE_ID;
    const modelId = ALERT_MODEL;
    metrics.totalAlerts++;
    metrics.byEvent[event.type] = (metrics.byEvent[event.type] ?? 0) + 1;

    await generateSpeech({ text: speechText, voiceId, modelId, source: 'auto:' + event.type });

    fastify.log.info({ eventType: event.type }, 'Auto-voice alert generated');

    // Notify frontend via events that audio is ready
    void emitEvent('voice.alert_generated', {
      eventType: event.type,
      text: speechText,
      voiceId,
      modelId,
    });
  } catch (err) {
    fastify.log.warn({ err, eventType: event.type }, 'Auto-voice alert failed');
  }
}

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is required');

    // Test API key validity
    try {
      await eleven.voices.search({});
      fastify.log.info('ElevenLabs API: connected');
    } catch (err) {
      fastify.log.warn({ err }, 'ElevenLabs API test failed — check API key and quota');
    }

    await fastify.listen({ port: 3014, host: '0.0.0.0' });
    fastify.log.info('🎙️  Voice Engine online — port 3014');
    fastify.log.info(`📅 ${getTodayDate()} | Default voice: ${DEFAULT_VOICE_ID} | Model: ${DEFAULT_MODEL}`);
    fastify.log.info(`🔔 Auto-speak events: ${[...AUTO_SPEAK_EVENTS].join(', ')}`);

    // Start listening to module9 event stream for auto-alerts
    void startEventListener();
  } catch (err) { fastify.log.error(err, 'Voice Engine failed to start'); process.exit(1); }
};
start();
