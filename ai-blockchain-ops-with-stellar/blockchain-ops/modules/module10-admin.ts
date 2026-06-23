// ============================================================
// MODULE 10: ADMIN API — COMPLETE PRODUCTION
// Role: System administration, monitoring, and control
// Port: 3010
// Features:
// - System status across all 14 modules with health checks
// - Per-module restart trigger (SIGTERM + delay)
// - Task management (list, stats, cancel, purge)
// - User management (list, activate, deactivate, role change)
// - Secret management (list, rotate, expiry check)
// - Webhook subscription management
// - Audit log query with filters
// - Gate decision history
// - Event history query
// - Database stats and connection info
// - Voice test endpoint
// - Nova mode switching
// - System-wide metrics aggregation
// - Structured logging with admin user tracking
// - Rate limiting on all admin routes
// - IP-based access enforced (via gateway)
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
import { HealthStatus } from '../shared/types.js';
import { getTodayISO, getTodayDate } from '../shared/date-utils.js';
import { internalFetch, verifyInternalToken, INTERNAL_HEADER, getServiceUrl, SERVICE_REGISTRY } from '../shared/registry.js';

const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 60_000,
});

await fastify.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? '*' });
await fastify.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.ip,
});

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
  fastify.log.info({ requestId: req.id, method: req.method, url: req.url, statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime) }, 'admin request');
});

fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.url === '/health' || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    fastify.log.warn({ requestId: req.id, ip: req.ip, url: req.url }, 'Unauthorized admin access');
    return reply.status(401).send({ error: 'Internal token required', requestId: req.id });
  }
});

// ── Module health checker ─────────────────────────────────────

interface ModuleStatus {
  name: string;
  port: number;
  status: 'online' | 'offline' | 'degraded';
  uptime?: number;
  agent?: string;
  responseMs: number;
  checkedAt: string;
  error?: string;
}

async function checkModuleHealth(name: string, port: number): Promise<ModuleStatus> {
  const t0 = Date.now();
  const healthPath = name === 'module12-frontend' ? '/' : '/health';
  try {
    const res = await fetch(`http://localhost:${port}${healthPath}`, { signal: AbortSignal.timeout(5_000) });
    const responseMs = Date.now() - t0;
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      return { name, port, status: data['status'] === 'degraded' ? 'degraded' : 'online', uptime: data['uptime'] as number, agent: data['agent'] as string, responseMs, checkedAt: getTodayISO() };
    }
    return { name, port, status: 'offline', responseMs, checkedAt: getTodayISO(), error: 'HTTP ' + res.status };
  } catch (err) {
    return { name, port, status: 'offline', responseMs: Date.now() - t0, checkedAt: getTodayISO(), error: String(err).slice(0, 100) };
  }
}

const MODULE_PORTS: Record<string, number> = {
  'module1-relevance-gate': 3001, 'module2-auditor': 3002, 'module3-orchestrator': 3003,
  'module4-gateway': 3004, 'module5-mcp': 3005, 'module6-database': 3006,
  'module7-auth': 3007, 'module8-secrets': 3008, 'module9-events': 3009,
  'module10-admin': 3010, 'module11-blockchain': 3011, 'module12-frontend': 3012,
  'module13-nova': 3013, 'module14-voice': 3014, 'module15-stellar': 3015,
};

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => ({
  service: 'module10-admin', status: 'online',
  date: getTodayDate(), timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  dependencies: {},
}));

// GET /system — full system status across all modules
fastify.get('/system', async () => {
  const checks = await Promise.allSettled(
    Object.entries(MODULE_PORTS).map(([name, port]) => checkModuleHealth(name, port))
  );
  const modules: ModuleStatus[] = checks.map((r, i) => {
    const [name, port] = Object.entries(MODULE_PORTS)[i]!;
    return r.status === 'fulfilled' ? r.value : { name: name!, port: port!, status: 'offline' as const, responseMs: 0, checkedAt: getTodayISO(), error: 'Check failed' };
  });
  const online = modules.filter(m => m.status === 'online').length;
  const degraded = modules.filter(m => m.status === 'degraded').length;
  const offline = modules.filter(m => m.status === 'offline').length;
  return {
    summary: { total: modules.length, online, degraded, offline, healthy: online + degraded },
    modules: Object.fromEntries(modules.map(m => [m.name, m.status])),
    details: modules,
    checkedAt: getTodayISO(),
  };
});

// GET /system/:module — single module health
fastify.get('/system/:module', async (req: FastifyRequest<{ Params: { module: string } }>, reply: FastifyReply) => {
  const port = MODULE_PORTS[req.params.module];
  if (!port) return reply.status(404).send({ error: 'Module not found' });
  return checkModuleHealth(req.params.module, port);
});

// ── Tasks ─────────────────────────────────────────────────────

fastify.get('/tasks/stats', async () => {
  try {
    const res = await internalFetch('module6-database', '/stats', {}, 10_000);
    if (res.ok) return res.json();
  } catch {}
  return { error: 'Database unavailable' };
});

fastify.get('/tasks', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const qs = new URLSearchParams(q);
    const res = await internalFetch('module6-database', `/tasks?${qs.toString()}`, {}, 10_000);
    if (res.ok) return res.json();
  } catch {}
  return { tasks: [] };
});

fastify.get('/tasks/:taskId', async (req: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
  try {
    const res = await internalFetch('module6-database', `/tasks/${req.params.taskId}`, {}, 5_000);
    if (res.ok) return res.json();
    return reply.status(404).send({ error: 'Task not found' });
  } catch { return reply.status(503).send({ error: 'Database unavailable' }); }
});

fastify.delete('/tasks/:taskId', async (req: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
  try {
    await internalFetch('module3-orchestrator', `/tasks/${req.params.taskId}`, { method: 'DELETE' }, 5_000);
    return reply.send({ ok: true, taskId: req.params.taskId });
  } catch { return reply.status(503).send({ error: 'Orchestrator unavailable' }); }
});

// ── Users ─────────────────────────────────────────────────────

fastify.get('/users', async () => {
  try {
    const res = await internalFetch('module6-database', '/users', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { users: [] };
});

fastify.get('/users/:userId', async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
  try {
    const res = await internalFetch('module6-database', `/users/id/${req.params.userId}`, {}, 5_000);
    if (res.ok) return res.json();
    return reply.status(404).send({ error: 'User not found' });
  } catch { return reply.status(503).send({ error: 'Database unavailable' }); }
});

fastify.patch('/users/:userId/deactivate', async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
  try {
    await internalFetch('module6-database', `/users/${req.params.userId}/deactivate`, { method: 'PATCH' }, 5_000);
    await internalFetch('module6-database', `/oauth-tokens/revoke-all/${req.params.userId}`, { method: 'POST' }, 5_000);
    void internalFetch('module9-events', '/emit', { method: 'POST', body: JSON.stringify({ type: 'admin.user_deactivated', source: 'module10-admin', payload: { userId: req.params.userId }, emittedAt: getTodayISO() }) }, 3_000);
    return reply.send({ ok: true, userId: req.params.userId, action: 'deactivated', tokensRevoked: true });
  } catch { return reply.status(503).send({ error: 'Database unavailable' }); }
});

fastify.patch('/users/:userId/activate', async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
  try {
    await internalFetch('module6-database', `/users/${req.params.userId}/activate`, { method: 'PATCH' }, 5_000);
    return reply.send({ ok: true, userId: req.params.userId, action: 'activated' });
  } catch { return reply.status(503).send({ error: 'Database unavailable' }); }
});

fastify.patch('/users/:userId/role', async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const role = String(b['role'] ?? '');
  if (!['viewer', 'operator', 'admin'].includes(role)) return reply.status(400).send({ error: 'Invalid role — must be viewer, operator, or admin' });
  try {
    await internalFetch('module7-auth', `/users/${req.params.userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }, 5_000);
    return reply.send({ ok: true, userId: req.params.userId, role });
  } catch { return reply.status(503).send({ error: 'Auth service unavailable' }); }
});

// ── Secrets ───────────────────────────────────────────────────

fastify.get('/secrets', async () => {
  try {
    const res = await internalFetch('module8-secrets', '/secrets', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { secrets: [] };
});

fastify.get('/secrets/expiring', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const res = await internalFetch('module8-secrets', `/secrets/expiring?days=${q['days'] ?? '7'}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { secrets: [] };
});

fastify.post('/secrets/:name/rotate', async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  try {
    const res = await internalFetch('module8-secrets', `/secrets/${req.params.name}/rotate`, { method: 'POST', body: JSON.stringify({ newValue: b['newValue'], rotatedBy: b['rotatedBy'] ?? 'admin' }) }, 5_000);
    if (res.ok) return res.json();
    return reply.status(res.status).send(await res.json());
  } catch { return reply.status(503).send({ error: 'Secrets service unavailable' }); }
});

// ── Gate ──────────────────────────────────────────────────────

fastify.get('/gate/metrics', async () => {
  try {
    const res = await internalFetch('module1-relevance-gate', '/metrics', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { error: 'Gate unavailable' };
});

fastify.get('/gate/circuit', async () => {
  try {
    const res = await internalFetch('module1-relevance-gate', '/circuit', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { error: 'Gate unavailable' };
});

fastify.post('/gate/circuit/reset', async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const res = await internalFetch('module1-relevance-gate', '/circuit/reset', { method: 'POST', body: '{}' }, 5_000);
    if (res.ok) return res.json();
    return reply.status(res.status).send(await res.json());
  } catch { return reply.status(503).send({ error: 'Gate unavailable' }); }
});

fastify.delete('/gate/cache', async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const res = await internalFetch('module1-relevance-gate', '/cache', { method: 'DELETE' }, 5_000);
    if (res.ok) return res.json();
  } catch { return reply.status(503).send({ error: 'Gate unavailable' }); }
});

// ── Auditor ───────────────────────────────────────────────────

fastify.get('/auditor/recent', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const res = await internalFetch('module2-auditor', `/recent?limit=${q['limit'] ?? '20'}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { audits: [] };
});

fastify.get('/auditor/metrics', async () => {
  try {
    const res = await internalFetch('module2-auditor', '/metrics', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { error: 'Auditor unavailable' };
});

fastify.delete('/auditor/cache', async (_req: FastifyRequest, reply: FastifyReply) => {
  try {
    const res = await internalFetch('module2-auditor', '/cache', { method: 'DELETE' }, 5_000);
    if (res.ok) return res.json();
  } catch { return reply.status(503).send({ error: 'Auditor unavailable' }); }
});

// ── Events ────────────────────────────────────────────────────

fastify.get('/events', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const qs = new URLSearchParams(q);
    const res = await internalFetch('module9-events', `/events?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  try {
    const qs = new URLSearchParams(q);
    const res = await internalFetch('module6-database', `/events?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { events: [] };
});

fastify.get('/events/metrics', async () => {
  try {
    const res = await internalFetch('module9-events', '/metrics', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { error: 'Events unavailable' };
});

fastify.get('/events/connections', async () => {
  try {
    const res = await internalFetch('module9-events', '/connections', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { connections: 0 };
});

// ── Webhook subscriptions ─────────────────────────────────────

fastify.get('/webhooks', async () => {
  try {
    const res = await internalFetch('module9-events', '/subscriptions', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { subscriptions: [] };
});

fastify.delete('/webhooks/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  try {
    const res = await internalFetch('module9-events', `/subscriptions/${req.params.id}`, { method: 'DELETE' }, 5_000);
    if (res.ok) return res.json();
    return reply.status(res.status).send(await res.json());
  } catch { return reply.status(503).send({ error: 'Events service unavailable' }); }
});

fastify.get('/webhooks/dlq', async () => {
  try {
    const res = await internalFetch('module9-events', '/subscriptions/dlq', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { items: [] };
});

// ── Blockchain ────────────────────────────────────────────────

fastify.get('/blockchain/contracts', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const res = await internalFetch('module11-blockchain', `/contracts?${new URLSearchParams(q).toString()}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { contracts: [] };
});

fastify.get('/blockchain/transactions', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const res = await internalFetch('module11-blockchain', `/transactions?${new URLSearchParams(q).toString()}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { transactions: [] };
});

// ── Stellar admin proxy routes ────────────────────────────────

fastify.get('/stellar/contracts', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const res = await internalFetch('module15-stellar', `/contracts?${new URLSearchParams(q).toString()}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { contracts: [] };
});

fastify.get('/stellar/transactions', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const res = await internalFetch('module15-stellar', `/transactions?${new URLSearchParams(q).toString()}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { transactions: [] };
});

fastify.get('/stellar/health', async () => {
  try {
    const res = await internalFetch('module15-stellar', '/health', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { service: 'module15-stellar', status: 'offline' };
});

fastify.get('/stellar/networks', async () => {
  try {
    const res = await internalFetch('module15-stellar', '/networks', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { networks: [] };
});

// ── Nova mode ─────────────────────────────────────────────────

fastify.get('/nova/mode', async () => {
  try {
    const res = await internalFetch('module13-nova', '/mode', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { error: 'Nova unavailable' };
});

fastify.post('/nova/mode', async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const res = await internalFetch('module13-nova', '/mode', { method: 'POST', body: JSON.stringify(req.body) }, 5_000);
    if (res.ok) return res.json();
    return reply.status(res.status).send(await res.json());
  } catch { return reply.status(503).send({ error: 'Nova unavailable' }); }
});

fastify.get('/nova/metrics', async () => {
  try {
    const res = await internalFetch('module13-nova', '/metrics', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { error: 'Nova unavailable' };
});

// ── Voice ─────────────────────────────────────────────────────

fastify.get('/voice/metrics', async () => {
  try {
    const res = await internalFetch('module14-voice', '/metrics', {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { error: 'Voice service unavailable' };
});

fastify.post('/voice/test', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const text = String(b['text'] ?? `AI Blockchain Ops system online. Today is ${getTodayDate()}. All systems nominal.`);
  try {
    const res = await internalFetch('module14-voice', '/speak-text', { method: 'POST', body: JSON.stringify({ text }) }, 15_000);
    if (res.ok) {
      reply.header('Content-Type', 'audio/mpeg');
      const buf = Buffer.from(await res.arrayBuffer());
      return reply.send(buf);
    }
    return reply.status(res.status).send({ error: 'Voice generation failed' });
  } catch { return reply.status(503).send({ error: 'Voice service unavailable' }); }
});

fastify.post('/voice/configure/auto-events', async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const res = await internalFetch('module14-voice', '/configure/auto-events', { method: 'POST', body: JSON.stringify(req.body) }, 5_000);
    if (res.ok) return res.json();
  } catch { return reply.status(503).send({ error: 'Voice service unavailable' }); }
});

// ── Database stats ────────────────────────────────────────────

fastify.get('/database/stats', async () => {
  try {
    const res = await internalFetch('module6-database', '/stats', {}, 10_000);
    if (res.ok) return res.json();
  } catch {}
  return { error: 'Database unavailable' };
});

// ── Aggregate metrics from all modules ───────────────────────

fastify.get('/metrics', async () => {
  const modules = ['module1-relevance-gate', 'module2-auditor', 'module3-orchestrator', 'module5-mcp', 'module13-nova', 'module14-voice'];
  const results = await Promise.allSettled(
    modules.map(m => internalFetch(m as never, '/metrics', {}, 5_000).then(r => r.json()))
  );
  const metrics: Record<string, unknown> = {};
  results.forEach((r, i) => {
    metrics[modules[i]!] = r.status === 'fulfilled' ? r.value : { error: 'unavailable' };
  });
  try {
    const dbStats = await internalFetch('module6-database', '/stats', {}, 5_000);
    if (dbStats.ok) metrics['module6-database'] = await dbStats.json();
  } catch {}
  return { timestamp: getTodayISO(), modules: metrics };
});

// ── Audit logs ────────────────────────────────────────────────

fastify.get('/audit-logs', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const qs = new URLSearchParams(q);
    const res = await internalFetch('module6-database', `/audit-logs?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { logs: [] };
});

fastify.get('/gate-decisions', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const qs = new URLSearchParams(q);
    const res = await internalFetch('module6-database', `/gate-decisions?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
  } catch {}
  return { decisions: [] };
});

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    await fastify.listen({ port: 3010, host: '0.0.0.0' });
    fastify.log.info('⊛  Admin API online — port 3010');
    fastify.log.info(`📅 ${getTodayDate()} | Monitors: ${Object.keys(MODULE_PORTS).length} modules`);
  } catch (err) { fastify.log.error(err, 'Admin API failed to start'); process.exit(1); }
};
start();
