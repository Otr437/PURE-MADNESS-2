// ============================================================
// SERVER — Production HTTP Server Wrapper
// Wraps Fastify instances with production-grade settings:
// clustering, keep-alive tuning, graceful connection draining,
// request ID propagation, and structured error handling.
// Import this instead of calling fastify.listen() directly.
// ============================================================

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cluster from 'cluster';
import os from 'os';
import crypto from 'crypto';
import { getTodayISO, getTodayDate } from './shared/date-utils.js';

// ── Server options ────────────────────────────────────────────

export interface ServerOptions {
  port: number;
  host?: string;
  serviceName: string;
  enableClustering?: boolean;       // default false — use true for gateway only
  workerCount?: number;             // default: os.cpus().length
  keepAliveTimeoutMs?: number;      // default: 65_000 (above ALB default of 60s)
  headersTimeoutMs?: number;        // default: 66_000
  requestTimeoutMs?: number;        // default: 30_000
  shutdownDrainMs?: number;         // wait for in-flight requests to complete
  trustProxy?: boolean;             // trust X-Forwarded-* headers
}

// ── Active connection tracking for graceful drain ─────────────

let activeRequests = 0;
let isShuttingDown = false;

// ── Start server with production settings ─────────────────────

export async function startServer(
  fastify: FastifyInstance,
  options: ServerOptions
): Promise<void> {
  const {
    port,
    host = '0.0.0.0',
    serviceName,
    enableClustering = false,
    workerCount = os.cpus().length,
    keepAliveTimeoutMs = 65_000,
    headersTimeoutMs = 66_000,
    shutdownDrainMs = 10_000,
    trustProxy = true,
  } = options;

  // Clustering — only use for the gateway in high-traffic production
  if (enableClustering && cluster.isPrimary) {
    fastify.log.info(`Primary ${process.pid} — forking ${workerCount} workers`);
    for (let i = 0; i < workerCount; i++) {
      cluster.fork();
    }
    cluster.on('exit', (worker, code, signal) => {
      fastify.log.warn(`Worker ${worker.process.pid} died (code=${code}, signal=${signal}) — forking replacement`);
      cluster.fork();
    });
    return;
  }

  // ── Global error handlers ─────────────────────────────────────

  process.on('uncaughtException', (err) => {
    fastify.log.error({ err }, `[${serviceName}] Uncaught exception`);
    // Don't exit — let the process recover
  });

  process.on('unhandledRejection', (reason) => {
    fastify.log.error({ reason }, `[${serviceName}] Unhandled rejection`);
  });

  // ── Request tracking hooks ────────────────────────────────────

  fastify.addHook('onRequest', async (_req: FastifyRequest, reply: FastifyReply) => {
    activeRequests++;
    // Reject new requests during shutdown
    if (isShuttingDown) {
      reply.header('Connection', 'close');
      reply.header('Retry-After', '5');
      return reply.status(503).send({ error: 'Service shutting down', retryAfter: 5 });
    }
  });

  fastify.addHook('onResponse', async () => {
    activeRequests = Math.max(0, activeRequests - 1);
  });

  // ── Standard response headers ─────────────────────────────────

  fastify.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('X-Service', serviceName);
    reply.header('X-Date', getTodayDate());
    reply.header('X-Request-Id', (req.id as string) ?? crypto.randomUUID());
    if (isShuttingDown) reply.header('Connection', 'close');
  });

  // ── Trust proxy settings (for X-Forwarded-For, X-Real-IP) ────

  if (trustProxy) {
    fastify.server.on('request', (req) => {
      const forwardedFor = req.headers['x-forwarded-for'];
      if (forwardedFor) {
        const realIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0].trim();
        (req as unknown as Record<string, unknown>)['realIp'] = realIp;
      }
    });
  }

  // ── Start listening ───────────────────────────────────────────

  await fastify.listen({ port, host });

  // ── Tune keep-alive and headers timeouts ──────────────────────
  // Must be set AFTER listen() — Node.js http.Server settings

  fastify.server.keepAliveTimeout = keepAliveTimeoutMs;
  fastify.server.headersTimeout = headersTimeoutMs;
  fastify.server.maxHeadersCount = 100;
  fastify.server.timeout = options.requestTimeoutMs ?? 30_000;

  fastify.log.info(`✅ ${serviceName} listening on ${host}:${port}`);
  fastify.log.info(`   Keep-alive: ${keepAliveTimeoutMs}ms | Headers timeout: ${headersTimeoutMs}ms`);
  fastify.log.info(`   Worker PID: ${process.pid} | Date: ${getTodayDate()}`);

  // ── Graceful shutdown handler ─────────────────────────────────

  async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    fastify.log.info(`[${serviceName}] ${signal} received — starting graceful shutdown`);
    fastify.log.info(`[${serviceName}] Active requests: ${activeRequests}`);

    // Stop accepting new connections
    fastify.server.close();

    // Drain in-flight requests
    const drainDeadline = Date.now() + shutdownDrainMs;
    while (activeRequests > 0 && Date.now() < drainDeadline) {
      fastify.log.info(`[${serviceName}] Draining — ${activeRequests} requests remaining`);
      await new Promise(r => setTimeout(r, 500));
    }

    if (activeRequests > 0) {
      fastify.log.warn(`[${serviceName}] Drain timeout — ${activeRequests} requests still active`);
    }

    await fastify.close();
    fastify.log.info(`[${serviceName}] Shutdown complete`);
    process.exit(0);
  }

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
}

// ── Health check response builder ─────────────────────────────

export function buildHealthResponse(serviceName: string, serviceStart: number, extra?: Record<string, unknown>) {
  return {
    service: serviceName,
    status: isShuttingDown ? 'shutting_down' : 'online',
    pid: process.pid,
    date: getTodayDate(),
    timestamp: getTodayISO(),
    uptime: Math.floor((Date.now() - serviceStart) / 1000),
    activeRequests,
    nodeVersion: process.version,
    memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    ...extra,
  };
}

// ── Fastify logger config ─────────────────────────────────────

export function getLoggerConfig(serviceName: string) {
  const isPretty = process.env['LOG_PRETTY'] === 'true' || process.env['NODE_ENV'] === 'development';
  const level = process.env['LOG_LEVEL'] ?? 'info';

  if (isPretty) {
    return {
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, singleLine: false, translateTime: 'SYS:HH:MM:ss' },
      },
    };
  }

  return {
    level,
    serializers: {
      req(req: FastifyRequest) {
        return { method: req.method, url: req.url, id: req.id };
      },
    },
    base: { service: serviceName, pid: process.pid },
  };
}

// ── Request ID generator ──────────────────────────────────────

export function generateRequestId(): string {
  return crypto.randomUUID();
}

// ── Standard Fastify config ───────────────────────────────────

export function getFastifyConfig(serviceName: string, requestTimeoutMs = 30_000) {
  return {
    logger: getLoggerConfig(serviceName),
    genReqId: generateRequestId,
    requestTimeout: requestTimeoutMs,
    disableRequestLogging: false,
    ajv: {
      customOptions: {
        strict: false,
        coerceTypes: false,
        allErrors: true,
      },
    },
  };
}

// ── Standard error handler ────────────────────────────────────

export function registerErrorHandler(fastify: FastifyInstance, serviceName: string) {
  fastify.setErrorHandler(async (error, _req: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      fastify.log.error({ err: error, service: serviceName }, 'Internal server error');
    } else {
      fastify.log.warn({ err: error, service: serviceName }, 'Request error');
    }

    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : error.message,
      statusCode,
      timestamp: getTodayISO(),
      requestId: (_req.id as string) ?? 'unknown',
    });
  });

  fastify.setNotFoundHandler(async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send({
      error: `Route ${req.method} ${req.url} not found`,
      statusCode: 404,
      timestamp: getTodayISO(),
    });
  });
}

// ── Memory usage monitor ──────────────────────────────────────

export function startMemoryMonitor(serviceName: string, thresholdMb = 512) {
  setInterval(() => {
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    if (heapMb > thresholdMb) {
      console.warn(`[${serviceName}] High memory usage: ${heapMb}MB (threshold: ${thresholdMb}MB)`);
    }
  }, 60_000);
}

// ── Process stats ─────────────────────────────────────────────

export function getProcessStats() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    memory: {
      heapUsedMb:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      externalMb:  Math.round(mem.external  / 1024 / 1024),
      rssMb:       Math.round(mem.rss       / 1024 / 1024),
    },
    activeRequests,
    isShuttingDown,
    nodeVersion: process.version,
  };
}
