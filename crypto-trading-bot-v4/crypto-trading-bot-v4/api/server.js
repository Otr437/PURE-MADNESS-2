'use strict';
/**
 * api/server.js — Express REST API
 * Security: helmet, cors, rate-limit headers, request ID, input size limits,
 *           no stack traces in production, Auth0 JWT on all /api routes.
 */

require('dotenv').config();
require('express-async-errors');

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const { randomUUID } = require('crypto');

const { db, getRedis, closeAll } = require('../infrastructure/db/database');
const { authMiddleware }         = require('../infrastructure/auth/auth');
const { createLogger }           = require('../infrastructure/logger/logger');
const botsRouter                 = require('./routes/bots');
const adminRouter                = require('./routes/admin');

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT    = parseInt(process.env.API_SERVER_PORT || process.env.PORT || '3000');
const log     = createLogger(null, 'api-server');

const app = express();

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'none'"],
      objectSrc:  ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy:   true,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  noSniff:          true,
  xssFilter:        true,
  hidePoweredBy:    true,
  frameguard:       { action: 'deny' },
}));

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.API_CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin (server-to-server), or whitelisted origins
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods:          ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders:   ['Content-Type','Authorization','X-Request-ID'],
  exposedHeaders:   ['X-RateLimit-Limit','X-RateLimit-Remaining','X-RateLimit-Reset','X-Request-ID'],
  credentials:      true,
  maxAge:           86400,
}));

// ── REQUEST ID ────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.set('X-Request-ID', req.id);
  next();
});

// ── BODY PARSING (with size limits) ──────────────────────────────────────────
app.use(express.json({
  limit:  '100kb',
  strict: true,
  verify: (req, _res, buf) => {
    // Reject empty bodies for POST/PATCH
    if ((req.method === 'POST' || req.method === 'PATCH') && buf.length === 0) {
      throw Object.assign(new Error('Empty body not allowed'), { status: 400 });
    }
  },
}));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

// ── REQUEST LOGGING ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms     = Date.now() - start;
    const level  = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log[level](`${req.method} ${req.path} ${res.statusCode}`, {
      reqId:  req.id,
      ms,
      ip:     req.ip,
      status: res.statusCode,
    });
  });
  next();
});

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  let pgOk = false, redisOk = false, pgMs = null, redisMs = null;

  const pgStart = Date.now();
  try { await db.query('SELECT 1'); pgOk = true; pgMs = Date.now() - pgStart; }
  catch (e) { log.warn('Health: Postgres failed', { error: e.message }); }

  const redisStart = Date.now();
  try { await getRedis().ping(); redisOk = true; redisMs = Date.now() - redisStart; }
  catch (e) { log.warn('Health: Redis failed', { error: e.message }); }

  const healthy = pgOk && redisOk;
  res.status(healthy ? 200 : 503).json({
    status:   healthy ? 'ok' : 'degraded',
    postgres: { ok: pgOk, latencyMs: pgMs },
    redis:    { ok: redisOk, latencyMs: redisMs },
    uptime:   Math.floor(process.uptime()),
    version:  process.env.npm_package_version || '2.0.0',
    ts:       new Date().toISOString(),
  });
});

// Readiness probe (k8s / load balancer)
app.get('/ready', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    await getRedis().ping();
    res.status(200).send('OK');
  } catch (_) {
    res.status(503).send('NOT READY');
  }
});

// ── PROTECTED ROUTES ─────────────────────────────────────────────────────────
app.use('/api', authMiddleware);
app.use('/api/bots', botsRouter);
app.use('/api',      adminRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error:   'NotFound',
    message: `Route ${req.method} ${req.path} does not exist`,
    reqId:   req.id,
  });
});

// ── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // CORS error
  if (err.message?.includes('CORS')) {
    return res.status(403).json({ error: 'CORSError', message: err.message, reqId: req.id });
  }

  // JSON parse error
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'InvalidJSON', message: 'Request body is not valid JSON', reqId: req.id });
  }

  // Body too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PayloadTooLarge', message: 'Request body exceeds size limit', reqId: req.id });
  }

  const status  = err.status || err.statusCode || 500;
  const isClient= status < 500;

  if (!isClient) {
    log.error(`${req.method} ${req.path} — ${err.message}`, {
      reqId:  req.id,
      status,
      stack:  err.stack,
    });
  }

  res.status(status).json({
    error:   err.code || (isClient ? 'ClientError' : 'InternalServerError'),
    message: isClient ? err.message : 'An unexpected error occurred',
    reqId:   req.id,
    ...(!IS_PROD && !isClient && { detail: err.message, stack: err.stack }),
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
async function startServer() {
  // Verify DB connections before accepting traffic
  try {
    await db.query('SELECT 1');
    log.info('PostgreSQL connection verified');
  } catch (err) {
    log.fatal('Cannot connect to PostgreSQL on startup', { error: err.message });
    process.exit(1);
  }

  try {
    await getRedis().ping();
    log.info('Redis connection verified');
  } catch (err) {
    log.warn('Redis unavailable on startup — some features degraded', { error: err.message });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    log.info(`API server listening on 0.0.0.0:${PORT}`, { env: process.env.NODE_ENV });
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${sig} received — starting graceful shutdown`);

    server.close(async () => {
      log.info('HTTP server closed — closing DB connections');
      await closeAll();
      log.info('Shutdown complete');
      process.exit(0);
    });

    // Force exit after 15s
    setTimeout(() => {
      log.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) startServer();
module.exports = { app, startServer };
