// ============================================================
// MODULE 9: EVENTS BUS — COMPLETE PRODUCTION
// Role: SSE event bus + webhook delivery for entire system
// Port: 3009
// Features:
// - SSE broadcast to all connected clients
// - Webhook subscriptions with delivery tracking
// - Webhook retry with exponential backoff (max 5 attempts)
// - Dead letter queue for failed webhook deliveries
// - Event deduplication by content hash
// - Event persistence to module6 database
// - Per-event-type subscriber tracking
// - Connection health monitoring (ping every 30s)
// - Webhook signature verification
// - Bulk event emit endpoint
// - Subscription management (create, list, delete)
// - Webhook delivery history
// - Connection count metrics
// - Graceful shutdown — notify all SSE clients
// - Structured logging with no secrets
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
import { z } from 'zod';
import { SystemEvent, HealthStatus } from '../shared/types.js';
import { getTodayISO, getTodayDate } from '../shared/date-utils.js';
import { internalFetch, verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';

const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 0, // SSE connections must not timeout
});

await fastify.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? '*' });
await fastify.register(rateLimit, { max: 200, timeWindow: '1 minute', keyGenerator: (req) => req.ip });

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.url !== '/stream') {
    fastify.log.info({ requestId: req.id, method: req.method, url: req.url, statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) }, 'events request');
  }
});

// Internal-only for emit routes
fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  const publicPaths = ['/health', '/metrics', '/connections', '/stream'];
  if (publicPaths.some(p => req.url.startsWith(p)) || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    fastify.log.warn({ requestId: req.id, ip: req.ip, url: req.url }, 'Unauthorized events access');
    return reply.status(401).send({ error: 'Internal token required', requestId: req.id });
  }
});

// ── SSE connection registry ───────────────────────────────────

interface SSEClient {
  id: string;
  res: FastifyReply['raw'];
  connectedAt: string;
  lastPingAt: string;
  eventTypes: string[]; // empty = all events
  userId?: string;
}
const sseClients = new Map<string, SSEClient>();

// ── Event deduplication ───────────────────────────────────────

const seenEventHashes = new Map<string, number>(); // hash → timestamp
const DEDUP_TTL_MS = 5000; // 5 second dedup window

function isDuplicate(event: SystemEvent): boolean {
  const hash = crypto.createHash('sha256')
    .update(event.type + ':' + JSON.stringify(event.payload))
    .digest('hex');
  const now = Date.now();
  // Cleanup old entries
  for (const [h, t] of seenEventHashes) {
    if (now - t > DEDUP_TTL_MS) seenEventHashes.delete(h);
  }
  if (seenEventHashes.has(hash)) return true;
  seenEventHashes.set(hash, now);
  return false;
}

// ── Event ring buffer ─────────────────────────────────────────

const eventHistory: SystemEvent[] = [];
const EVENT_HISTORY_MAX = 1000;
function recordEvent(event: SystemEvent) {
  eventHistory.unshift(event);
  if (eventHistory.length > EVENT_HISTORY_MAX) eventHistory.pop();
}

// ── Metrics ───────────────────────────────────────────────────

const metrics = {
  totalEmitted: 0,
  deduplicated: 0,
  webhookDeliveries: 0,
  webhookFailures: 0,
  webhookDLQ: 0,
  byType: {} as Record<string, number>,
  totalConnections: 0,
};

// ── Webhook subscription store ────────────────────────────────

interface WebhookSubscription {
  subscriptionId: string;
  targetUrl: string;
  events: string[]; // event type prefixes to subscribe to, e.g. 'blockchain.*'
  secret: string;
  isActive: boolean;
  createdAt: string;
  failureCount: number;
  lastDeliveredAt?: string;
  lastFailedAt?: string;
}

const webhookSubs = new Map<string, WebhookSubscription>();

// ── Dead letter queue ─────────────────────────────────────────

interface DLQEntry {
  dlqId: string;
  subscriptionId: string;
  targetUrl: string;
  event: SystemEvent;
  attempts: number;
  lastAttemptAt: string;
  lastError: string;
  enqueuedAt: string;
}
const deadLetterQueue: DLQEntry[] = [];
const DLQ_MAX = 500;

// ── Broadcast event to all SSE clients ───────────────────────

function broadcastSSE(event: SystemEvent) {
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  const dead: string[] = [];

  for (const [id, client] of sseClients) {
    // Filter by event type subscription
    if (client.eventTypes.length > 0 && !client.eventTypes.some(t => event.type.startsWith(t))) continue;
    try {
      client.res.write(payload);
    } catch {
      dead.push(id);
    }
  }

  for (const id of dead) {
    sseClients.delete(id);
    fastify.log.debug({ clientId: id }, 'SSE client removed — write failed');
  }
}

// ── Webhook delivery with retry ───────────────────────────────

async function deliverWebhook(sub: WebhookSubscription, event: SystemEvent, attempt = 1): Promise<void> {
  const MAX_ATTEMPTS = 5;
  const payload = JSON.stringify({ eventId: event.eventId, type: event.type, source: event.source, payload: event.payload, emittedAt: event.emittedAt });
  const sig = 'sha256=' + crypto.createHmac('sha256', sub.secret).update(payload).digest('hex');

  try {
    const res = await fetch(sub.targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AIOps-Signature': sig, 'X-AIOps-Event': event.type, 'X-AIOps-Delivery': event.eventId ?? crypto.randomUUID() },
      body: payload,
      signal: AbortSignal.timeout(parseInt(process.env.WEBHOOK_TIMEOUT_MS ?? '15000')),
    });

    if (res.ok) {
      metrics.webhookDeliveries++;
      sub.failureCount = 0;
      sub.lastDeliveredAt = getTodayISO();
      void persistWebhookDelivery(sub.subscriptionId, event, true, res.status, undefined);
      return;
    }
    throw new Error('HTTP ' + res.status);
  } catch (err) {
    const errMsg = String(err).slice(0, 200);
    metrics.webhookFailures++;
    sub.failureCount++;
    sub.lastFailedAt = getTodayISO();

    fastify.log.warn({ subscriptionId: sub.subscriptionId, targetUrl: sub.targetUrl, attempt, err: errMsg }, 'Webhook delivery failed');

    void persistWebhookDelivery(sub.subscriptionId, event, false, undefined, errMsg);

    if (attempt < MAX_ATTEMPTS) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 60_000);
      setTimeout(() => void deliverWebhook(sub, event, attempt + 1), delay);
    } else {
      // Move to dead letter queue
      metrics.webhookDLQ++;
      if (deadLetterQueue.length < DLQ_MAX) {
        deadLetterQueue.unshift({
          dlqId: crypto.randomUUID(),
          subscriptionId: sub.subscriptionId,
          targetUrl: sub.targetUrl,
          event,
          attempts: MAX_ATTEMPTS,
          lastAttemptAt: getTodayISO(),
          lastError: errMsg,
          enqueuedAt: getTodayISO(),
        });
      }
      // Disable subscription after too many failures
      if (sub.failureCount >= 20) {
        sub.isActive = false;
        fastify.log.error({ subscriptionId: sub.subscriptionId, failureCount: sub.failureCount }, 'Webhook subscription auto-disabled after 20 failures');
        void emitEvent('webhook.subscription_disabled', { subscriptionId: sub.subscriptionId, targetUrl: sub.targetUrl, reason: 'Too many delivery failures' });
      }
    }
  }
}

async function persistWebhookDelivery(subscriptionId: string, event: SystemEvent, success: boolean, statusCode: number | undefined, error: string | undefined) {
  try {
    await internalFetch('module6-database', '/webhook-deliveries', {
      method: 'POST',
      body: JSON.stringify({ subscriptionId, eventId: event.eventId, targetUrl: '', success, statusCode: statusCode ?? null, responseMs: null, error: error ?? null }),
    }, 3_000);
  } catch { /* best-effort */ }
}

// ── Persist event to database ─────────────────────────────────

async function persistEvent(event: SystemEvent) {
  try {
    await internalFetch('module6-database', '/events', {
      method: 'POST',
      body: JSON.stringify({
        eventId: event.eventId, type: event.type, source: event.source,
        payload: event.payload, taskId: event.taskId ?? null, emittedAt: event.emittedAt,
      }),
    }, 3_000);
  } catch { /* best-effort */ }
}

async function emitEvent(type: string, payload: Record<string, unknown>) {
  const event: SystemEvent = {
    eventId: crypto.randomUUID(), type, source: 'module9-events',
    payload, emittedAt: getTodayISO(),
  };
  broadcastSSE(event);
}

// ── SSE ping to detect dead connections ───────────────────────

setInterval(() => {
  const ping = ': ping\n\n';
  const dead: string[] = [];
  for (const [id, client] of sseClients) {
    try {
      client.res.write(ping);
      client.lastPingAt = getTodayISO();
    } catch {
      dead.push(id);
    }
  }
  dead.forEach(id => sseClients.delete(id));
  if (dead.length > 0) fastify.log.debug({ removed: dead.length, remaining: sseClients.size }, 'Removed dead SSE clients');
}, parseInt(process.env.SSE_PING_INTERVAL_MS ?? '30000'));

// ── Schemas ───────────────────────────────────────────────────

const EmitSchema = z.object({
  type: z.string().min(1).max(200),
  source: z.string().min(1).max(100),
  payload: z.record(z.unknown()).default({}),
  taskId: z.string().uuid().optional(),
  emittedAt: z.string().optional(),
});

const SubscribeSchema = z.object({
  targetUrl: z.string().url(),
  events: z.array(z.string()).min(1).max(50),
  secret: z.string().min(16).optional(),
});

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => ({
  service: 'module9-events', status: 'online',
  date: getTodayDate(), timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  dependencies: { database: getServiceUrl('module6-database') },
  connections: sseClients.size,
  webhookSubscriptions: webhookSubs.size,
}));

fastify.get('/metrics', async () => ({
  service: 'module9-events', timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  events: {
    total: metrics.totalEmitted,
    deduplicated: metrics.deduplicated,
    historySize: eventHistory.length,
    byType: metrics.byType,
  },
  connections: { active: sseClients.size, totalEver: metrics.totalConnections },
  webhooks: {
    subscriptions: webhookSubs.size,
    activeSubscriptions: [...webhookSubs.values()].filter(s => s.isActive).length,
    deliveries: metrics.webhookDeliveries,
    failures: metrics.webhookFailures,
    dlqSize: deadLetterQueue.length,
  },
}));

fastify.get('/connections', async () => ({
  active: sseClients.size,
  clients: [...sseClients.values()].map(c => ({ id: c.id, connectedAt: c.connectedAt, lastPingAt: c.lastPingAt, userId: c.userId ?? null, eventTypes: c.eventTypes })),
}));

// GET /stream — SSE stream for real-time events
fastify.get('/stream', async (req: FastifyRequest, reply: FastifyReply) => {
  const clientId = crypto.randomUUID();
  const q = req.query as Record<string, string>;
  const eventTypes = q['types'] ? q['types'].split(',').filter(Boolean) : [];

  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.setHeader('Access-Control-Allow-Origin', '*');

  // Send client ID and recent history on connect
  reply.raw.write(`data: ${JSON.stringify({ type: 'connected', clientId, timestamp: getTodayISO() })}\n\n`);

  // Send last 20 events from history
  const recentSlice = eventHistory.slice(0, 20).reverse();
  for (const ev of recentSlice) {
    if (eventTypes.length === 0 || eventTypes.some(t => ev.type.startsWith(t))) {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  }

  const client: SSEClient = {
    id: clientId,
    res: reply.raw,
    connectedAt: getTodayISO(),
    lastPingAt: getTodayISO(),
    eventTypes,
    userId: q['userId'],
  };
  sseClients.set(clientId, client);
  metrics.totalConnections++;
  fastify.log.info({ clientId, eventTypes, total: sseClients.size }, 'SSE client connected');

  req.raw.on('close', () => {
    sseClients.delete(clientId);
    fastify.log.debug({ clientId, remaining: sseClients.size }, 'SSE client disconnected');
  });

  // Keep alive
  return reply;
});

// POST /emit — emit a single event
fastify.post('/emit', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = EmitSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid event', issues: parsed.error.issues });

  const event: SystemEvent = {
    eventId: crypto.randomUUID(),
    type: parsed.data.type,
    source: parsed.data.source,
    payload: parsed.data.payload,
    taskId: parsed.data.taskId,
    emittedAt: parsed.data.emittedAt ?? getTodayISO(),
  };

  // Deduplication
  if (isDuplicate(event)) {
    metrics.deduplicated++;
    return reply.status(204).send();
  }

  metrics.totalEmitted++;
  metrics.byType[event.type] = (metrics.byType[event.type] ?? 0) + 1;
  recordEvent(event);
  broadcastSSE(event);
  void persistEvent(event);

  // Deliver to matching webhook subscriptions
  for (const sub of webhookSubs.values()) {
    if (!sub.isActive) continue;
    if (sub.events.some(t => event.type.startsWith(t) || t === '*')) {
      void deliverWebhook(sub, event);
    }
  }

  return reply.status(202).send({ eventId: event.eventId, broadcasted: sseClients.size });
});

// POST /emit-bulk — emit multiple events at once
fastify.post('/emit-bulk', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const items = Array.isArray(b['events']) ? b['events'] as unknown[] : [];
  if (items.length === 0) return reply.status(400).send({ error: 'events array required' });
  if (items.length > 100) return reply.status(400).send({ error: 'Max 100 events per bulk emit' });

  let emitted = 0;
  let deduplicated = 0;
  for (const item of items) {
    const parsed = EmitSchema.safeParse(item);
    if (!parsed.success) continue;
    const event: SystemEvent = {
      eventId: crypto.randomUUID(), type: parsed.data.type, source: parsed.data.source,
      payload: parsed.data.payload, taskId: parsed.data.taskId, emittedAt: parsed.data.emittedAt ?? getTodayISO(),
    };
    if (isDuplicate(event)) { deduplicated++; continue; }
    metrics.totalEmitted++;
    metrics.byType[event.type] = (metrics.byType[event.type] ?? 0) + 1;
    recordEvent(event);
    broadcastSSE(event);
    void persistEvent(event);
    for (const sub of webhookSubs.values()) {
      if (!sub.isActive) continue;
      if (sub.events.some(t => event.type.startsWith(t) || t === '*')) void deliverWebhook(sub, event);
    }
    emitted++;
  }

  return reply.status(202).send({ emitted, deduplicated, total: items.length });
});

// GET /events — query event history
fastify.get('/events', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '100'), 1000);
  const type = q['type'];
  const taskId = q['taskId'];
  let events = eventHistory;
  if (type) events = events.filter(e => e.type.startsWith(type));
  if (taskId) events = events.filter(e => e.taskId === taskId);
  return { total: events.length, events: events.slice(0, limit) };
});

// POST /subscriptions — create webhook subscription
fastify.post('/subscriptions', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = SubscribeSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid subscription', issues: parsed.error.issues });

  const sub: WebhookSubscription = {
    subscriptionId: crypto.randomUUID(),
    targetUrl: parsed.data.targetUrl,
    events: parsed.data.events,
    secret: parsed.data.secret ?? crypto.randomBytes(32).toString('hex'),
    isActive: true,
    createdAt: getTodayISO(),
    failureCount: 0,
  };
  webhookSubs.set(sub.subscriptionId, sub);

  try {
    await internalFetch('module6-database', '/webhook-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ subscriptionId: sub.subscriptionId, targetUrl: sub.targetUrl, events: sub.events, isActive: true }),
    }, 3_000);
  } catch { /* best-effort */ }

  fastify.log.info({ subscriptionId: sub.subscriptionId, targetUrl: sub.targetUrl, events: sub.events }, 'Webhook subscription created');
  return reply.status(201).send({ subscriptionId: sub.subscriptionId, secret: sub.secret, events: sub.events, targetUrl: sub.targetUrl });
});

// GET /subscriptions — list all webhook subscriptions
fastify.get('/subscriptions', async () => ({
  total: webhookSubs.size,
  subscriptions: [...webhookSubs.values()].map(s => ({
    subscriptionId: s.subscriptionId, targetUrl: s.targetUrl, events: s.events,
    isActive: s.isActive, createdAt: s.createdAt, failureCount: s.failureCount,
    lastDeliveredAt: s.lastDeliveredAt ?? null, lastFailedAt: s.lastFailedAt ?? null,
  })),
}));

// DELETE /subscriptions/:id — deactivate subscription
fastify.delete('/subscriptions/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const sub = webhookSubs.get(req.params.id);
  if (!sub) return reply.status(404).send({ error: 'Subscription not found' });
  sub.isActive = false;
  webhookSubs.delete(req.params.id);
  return reply.send({ ok: true, subscriptionId: req.params.id });
});

// GET /subscriptions/dlq — dead letter queue
fastify.get('/subscriptions/dlq', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  return { total: deadLetterQueue.length, items: deadLetterQueue.slice(0, limit) };
});

// POST /subscriptions/dlq/:dlqId/retry — retry a dead letter entry
fastify.post('/subscriptions/dlq/:dlqId/retry', async (req: FastifyRequest<{ Params: { dlqId: string } }>, reply: FastifyReply) => {
  const idx = deadLetterQueue.findIndex(d => d.dlqId === req.params.dlqId);
  if (idx === -1) return reply.status(404).send({ error: 'DLQ entry not found' });
  const entry = deadLetterQueue.splice(idx, 1)[0]!;
  const sub = webhookSubs.get(entry.subscriptionId);
  if (!sub) return reply.status(404).send({ error: 'Subscription no longer exists' });
  sub.isActive = true;
  sub.failureCount = 0;
  void deliverWebhook(sub, entry.event);
  return reply.send({ ok: true, dlqId: entry.dlqId, retrying: true });
});

let shuttingDown = false;
process.on('SIGTERM', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Notify all SSE clients
  const closeMsg = `data: ${JSON.stringify({ type: 'server.shutdown', message: 'Server shutting down — reconnect in 5s' })}\n\n`;
  for (const client of sseClients.values()) {
    try { client.res.write(closeMsg); client.res.end(); } catch {}
  }
  sseClients.clear();
  await fastify.close();
  process.exit(0);
});
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    await fastify.listen({ port: 3009, host: '0.0.0.0' });
    fastify.log.info('📡 Events Bus online — port 3009');
    fastify.log.info(`📅 ${getTodayDate()} | SSE broadcast | Webhook retry: 5 attempts | DLQ: ${DLQ_MAX} | Dedup window: 5s`);
  } catch (err) { fastify.log.error(err, 'Events bus failed to start'); process.exit(1); }
};
start();
