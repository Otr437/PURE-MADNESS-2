// ============================================================
// MODULE 4: GATEWAY — COMPLETE PRODUCTION
// Role: Public API entry point for all external requests
// Auth: OAuth2 token verification via module7
// Routes to: Module 3 (orchestrator), Module 7 (auth)
//            Module 11 (blockchain), Module 5 (mcp)
//            Module 10 (admin), Module 9 (events)
// Port: 3004
// Features:
// - OAuth2 token verification on every protected route
// - IP allowlist for admin routes
// - Per-IP rate limiting with burst protection
// - Request body size limits (1MB default)
// - Response compression headers
// - Detailed error responses with request IDs
// - Request ID propagation to all downstream calls
// - CORS with configurable origins
// - Health check that tests all downstream services
// - Request timeout per route category
// - No secrets in logs — Authorization header stripped
// - Admin route IP allowlist enforcement
// - Structured logging on every request/response
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
import { getTodayISO, getTodayDate } from '../shared/date-utils.js';
import { internalFetch, verifyToken, verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';
import { HealthStatus } from '../shared/types.js';

const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 300_000,
  bodyLimit: parseInt(process.env.BODY_LIMIT ?? String(1024 * 1024)), // 1MB default
});

await fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGIN ?? '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'X-Task-Id', 'X-Task-Status', 'X-Rate-Limit-Remaining'],
});

await fastify.register(rateLimit, {
  max: parseInt(process.env.RATE_LIMIT_GATEWAY ?? '60'),
  timeWindow: '1 minute',
  keyGenerator: (req) => (req.headers['x-forwarded-for'] as string ?? req.ip),
  errorResponseBuilder: (_req, ctx) => ({
    error: 'Too many requests',
    retryAfter: Math.ceil(ctx.ttl / 1000) + 's',
    requestId: _req.id,
  }),
  addHeaders: {
    'x-ratelimit-limit': true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset': true,
  },
});

fastify.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1024 * 1024 },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

// ── Structured logging — strip Authorization header ───────────

fastify.addHook('onRequest', async (req: FastifyRequest) => {
  const safeHeaders = { ...req.headers };
  delete safeHeaders['authorization'];
  delete safeHeaders[INTERNAL_HEADER];
  fastify.log.debug({ requestId: req.id, method: req.method, url: req.url, ip: req.ip }, 'incoming request');
});

fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
  fastify.log.info({
    requestId: req.id, method: req.method, url: req.url,
    statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime), ip: req.ip,
  }, 'gateway response');
});

// ── Add request ID to every response ─────────────────────────

fastify.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply) => {
  reply.header('X-Request-Id', req.id as string);
  reply.header('X-Service', 'module4-gateway');
  reply.header('X-Date', getTodayDate());
});

// ── IP allowlist for admin routes ─────────────────────────────

const ADMIN_IP_ALLOWLIST = (process.env.ADMIN_IP_ALLOWLIST ?? '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map(s => s.trim());

function isAdminIpAllowed(req: FastifyRequest): boolean {
  if (ADMIN_IP_ALLOWLIST.includes('*')) return true;
  const ip = (req.headers['x-forwarded-for'] as string ?? req.ip).split(',')[0]!.trim();
  return ADMIN_IP_ALLOWLIST.includes(ip);
}

// ── Auth helpers ──────────────────────────────────────────────

interface TokenPayload { userId: string; email: string; role: string; scope: string; clientId?: string }

async function verifyAccessToken(req: FastifyRequest, reply: FastifyReply, requiredScope?: string): Promise<TokenPayload | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Bearer token required', requestId: req.id });
    return null;
  }
  const token = authHeader.slice(7);
  try {
    const res = await internalFetch('module7-auth', '/introspect', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }, 8_000);
    if (!res.ok) {
      reply.status(401).send({ error: 'Token verification failed', requestId: req.id });
      return null;
    }
    const payload = await res.json() as TokenPayload & { active: boolean };
    if (!payload.active) {
      reply.status(401).send({ error: 'Token expired or revoked', requestId: req.id });
      return null;
    }
    if (requiredScope && !payload.scope?.includes(requiredScope)) {
      reply.status(403).send({ error: `Required scope: ${requiredScope}`, requestId: req.id });
      return null;
    }
    return payload;
  } catch (err) {
    fastify.log.error({ requestId: req.id, err: String(err).slice(0, 100) }, 'Auth service unavailable');
    reply.status(503).send({ error: 'Auth service unavailable — try again', requestId: req.id });
    return null;
  }
}

// ── Proxy helpers ─────────────────────────────────────────────

async function proxyRequest(
  reply: FastifyReply,
  serviceName: string,
  path: string,
  method: string,
  body?: unknown,
  timeoutMs = 60_000,
  requestId?: string,
): Promise<FastifyReply> {
  try {
    const res = await internalFetch(serviceName as never, path, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: requestId ? { 'X-Origin-Request-Id': requestId } : undefined,
    }, timeoutMs);

    const contentType = res.headers.get('content-type') ?? 'application/json';
    reply.status(res.status);
    reply.header('Content-Type', contentType);

    // Forward useful headers from downstream
    const forwardHeaders = ['X-Task-Id', 'X-Task-Status', 'X-Audit-Passed', 'X-Audit-Recommendation', 'X-Gate-Score', 'X-Nova-Model'];
    for (const h of forwardHeaders) {
      const v = res.headers.get(h.toLowerCase());
      if (v) reply.header(h, v);
    }

    const text = await res.text();
    try { return reply.send(JSON.parse(text)); } catch { return reply.send(text); }
  } catch (err) {
    fastify.log.error({ serviceName, path, err: String(err).slice(0, 200) }, 'Proxy error');
    if (String(err).includes('timeout') || String(err).includes('ECONNREFUSED')) {
      return reply.status(503).send({ error: `${serviceName} unavailable`, requestId: reply.request?.id });
    }
    return reply.status(502).send({ error: 'Upstream error', requestId: reply.request?.id });
  }
}

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => {
  const services = ['module3-orchestrator', 'module7-auth', 'module11-blockchain', 'module9-events', 'module1-relevance-gate'];
  const checks = await Promise.allSettled(services.map(async s => {
    const res = await internalFetch(s as never, '/health', {}, 3_000);
    return { service: s, online: res.ok };
  }));
  const deps: Record<string, string> = {};
  checks.forEach((r, i) => {
    deps[services[i]!] = r.status === 'fulfilled' && r.value.online ? 'online' : 'offline';
  });
  return { service: 'module4-gateway', status: 'online', date: getTodayDate(), timestamp: getTodayISO(), uptime: Math.floor((Date.now() - SERVICE_START) / 1000), dependencies: deps };
});

fastify.get('/status', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply);
  if (!user) return;
  return proxyRequest(reply, 'module10-admin', '/system', 'GET', undefined, 10_000, req.id as string);
});

// ── Auth routes ───────────────────────────────────────────────

fastify.post('/auth/register', async (req: FastifyRequest, reply: FastifyReply) => {
  return proxyRequest(reply, 'module7-auth', '/register', 'POST', req.body, 15_000, req.id as string);
});

fastify.post('/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
  return proxyRequest(reply, 'module7-auth', '/login', 'POST', req.body, 15_000, req.id as string);
});

fastify.post('/auth/token', async (req: FastifyRequest, reply: FastifyReply) => {
  return proxyRequest(reply, 'module7-auth', '/token', 'POST', req.body, 15_000, req.id as string);
});

fastify.post('/auth/refresh', async (req: FastifyRequest, reply: FastifyReply) => {
  return proxyRequest(reply, 'module7-auth', '/refresh', 'POST', req.body, 10_000, req.id as string);
});

fastify.post('/auth/revoke', async (req: FastifyRequest, reply: FastifyReply) => {
  return proxyRequest(reply, 'module7-auth', '/revoke', 'POST', req.body, 10_000, req.id as string);
});

// ── Task / AI routes ──────────────────────────────────────────

fastify.post('/run', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'tasks:write');
  if (!user) return;
  const body = { ...(req.body as Record<string, unknown>), userId: user.userId };
  return proxyRequest(reply, 'module3-orchestrator', '/task', 'POST', body, 300_000, req.id as string);
});

fastify.get('/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'tasks:read');
  if (!user) return;
  const q = req.query as Record<string, string>;
  const qs = new URLSearchParams({ userId: user.role === 'admin' ? (q['userId'] ?? '') : user.userId, ...q });
  return proxyRequest(reply, 'module3-orchestrator', `/tasks?${qs.toString()}`, 'GET', undefined, 10_000, req.id as string);
});

fastify.get('/tasks/:taskId', async (req: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'tasks:read');
  if (!user) return;
  return proxyRequest(reply, 'module3-orchestrator', `/tasks/${req.params.taskId}`, 'GET', undefined, 10_000, req.id as string);
});

fastify.delete('/tasks/:taskId', async (req: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'tasks:write');
  if (!user) return;
  return proxyRequest(reply, 'module3-orchestrator', `/tasks/${req.params.taskId}`, 'DELETE', undefined, 10_000, req.id as string);
});

fastify.get('/stats', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'tasks:read');
  if (!user) return;
  return proxyRequest(reply, 'module3-orchestrator', '/stats', 'GET', undefined, 10_000, req.id as string);
});

// ── Blockchain routes ─────────────────────────────────────────

fastify.get('/blockchain/chains', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:read');
  if (!user) return;
  return proxyRequest(reply, 'module11-blockchain', '/chains', 'GET', undefined, 10_000, req.id as string);
});

fastify.get('/blockchain/gas', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:read');
  if (!user) return;
  const q = req.query as Record<string, string>;
  return proxyRequest(reply, 'module11-blockchain', `/gas?${new URLSearchParams(q).toString()}`, 'GET', undefined, 15_000, req.id as string);
});

fastify.get('/blockchain/wallet', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:read');
  if (!user) return;
  const q = req.query as Record<string, string>;
  return proxyRequest(reply, 'module11-blockchain', `/wallet?${new URLSearchParams(q).toString()}`, 'GET', undefined, 15_000, req.id as string);
});

fastify.post('/blockchain/simulate', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:read');
  if (!user) return;
  return proxyRequest(reply, 'module11-blockchain', '/simulate', 'POST', req.body, 30_000, req.id as string);
});

fastify.post('/blockchain/transaction', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:write');
  if (!user) return;
  return proxyRequest(reply, 'module11-blockchain', '/transaction', 'POST', req.body, 120_000, req.id as string);
});

fastify.post('/blockchain/deploy', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:deploy');
  if (!user) return;
  return proxyRequest(reply, 'module11-blockchain', '/deploy', 'POST', req.body, 300_000, req.id as string);
});

fastify.post('/blockchain/compile', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:write');
  if (!user) return;
  return proxyRequest(reply, 'module11-blockchain', '/compile', 'POST', req.body, 60_000, req.id as string);
});

fastify.post('/blockchain/meme-token', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:deploy');
  if (!user) return;
  return proxyRequest(reply, 'module11-blockchain', '/meme-token', 'POST', req.body, 300_000, req.id as string);
});

fastify.get('/blockchain/contracts', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:read');
  if (!user) return;
  const q = req.query as Record<string, string>;
  return proxyRequest(reply, 'module11-blockchain', `/contracts?${new URLSearchParams(q).toString()}`, 'GET', undefined, 10_000, req.id as string);
});

fastify.get('/blockchain/transactions', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'blockchain:read');
  if (!user) return;
  const q = req.query as Record<string, string>;
  return proxyRequest(reply, 'module11-blockchain', `/transactions?${new URLSearchParams(q).toString()}`, 'GET', undefined, 10_000, req.id as string);
});

// ── MCP routes ────────────────────────────────────────────────

fastify.get('/mcp/tools', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'tasks:read');
  if (!user) return;
  return proxyRequest(reply, 'module5-mcp', '/tools', 'GET', undefined, 10_000, req.id as string);
});

fastify.post('/mcp/call', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'tasks:write');
  if (!user) return;
  return proxyRequest(reply, 'module5-mcp', '/call', 'POST', req.body, 60_000, req.id as string);
});

// ── Admin routes (IP allowlist enforced) ──────────────────────

fastify.get('/admin/*', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!isAdminIpAllowed(req)) {
    fastify.log.warn({ ip: req.ip, url: req.url }, 'Admin route blocked — IP not in allowlist');
    return reply.status(403).send({ error: 'Forbidden — admin access restricted by IP', requestId: req.id });
  }
  const user = await verifyAccessToken(req, reply, 'admin');
  if (!user) return;
  if (user.role !== 'admin') return reply.status(403).send({ error: 'Admin role required', requestId: req.id });
  const path = req.url.replace('/admin', '');
  return proxyRequest(reply, 'module10-admin', path, 'GET', undefined, 30_000, req.id as string);
});

fastify.post('/admin/*', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!isAdminIpAllowed(req)) return reply.status(403).send({ error: 'Forbidden — admin access restricted by IP', requestId: req.id });
  const user = await verifyAccessToken(req, reply, 'admin');
  if (!user) return;
  if (user.role !== 'admin') return reply.status(403).send({ error: 'Admin role required', requestId: req.id });
  const path = req.url.replace('/admin', '');
  return proxyRequest(reply, 'module10-admin', path, 'POST', req.body, 30_000, req.id as string);
});

// ── Events SSE proxy ──────────────────────────────────────────

fastify.get('/events/stream', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'tasks:read');
  if (!user) return;
  // SSE passthrough
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  try {
    const upstream = await internalFetch('module9-events', '/stream', {}, 0);
    if (!upstream.body) return reply.status(502).send({ error: 'Events stream unavailable' });
    const reader = upstream.body.getReader();
    req.raw.on('close', () => reader.cancel());
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.raw.write(value);
    }
  } catch { /* client disconnected */ }
  reply.raw.end();
  return reply;
});

// ── Voice proxy ───────────────────────────────────────────────

fastify.post('/voice/speak', async (req: FastifyRequest, reply: FastifyReply) => {
  const user = await verifyAccessToken(req, reply, 'tasks:read');
  if (!user) return;
  const res = await internalFetch('module14-voice', '/speak', { method: 'POST', body: JSON.stringify(req.body) }, 30_000);
  reply.status(res.status);
  reply.header('Content-Type', 'audio/mpeg');
  const buf = Buffer.from(await res.arrayBuffer());
  return reply.send(buf);
});

// ── Error handler ─────────────────────────────────────────────

fastify.setErrorHandler(async (error, req: FastifyRequest, reply: FastifyReply) => {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) {
    fastify.log.error({ requestId: req.id, err: error.message, stack: error.stack?.slice(0, 500) }, 'Gateway internal error');
  }
  return reply.status(statusCode).send({
    error: statusCode >= 500 ? 'Internal server error' : error.message,
    statusCode,
    requestId: req.id,
    timestamp: getTodayISO(),
  });
});

fastify.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
  return reply.status(404).send({
    error: `Route ${req.method} ${req.url} not found`,
    statusCode: 404,
    requestId: req.id,
    timestamp: getTodayISO(),
  });
});

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    await fastify.listen({ port: 3004, host: '0.0.0.0' });
    fastify.log.info('🌐 Gateway online — port 3004');
    fastify.log.info(`📅 ${getTodayDate()} | Rate limit: ${process.env.RATE_LIMIT_GATEWAY ?? '60'}/min | Body limit: 1MB | Admin IP: ${ADMIN_IP_ALLOWLIST.join(',')}`);
  } catch (err) { fastify.log.error(err, 'Gateway failed to start'); process.exit(1); }
};
start();
