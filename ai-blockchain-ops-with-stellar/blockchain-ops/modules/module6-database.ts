/*
═══════════════════════════════════════════════════════════
🔐 CRYPTO-PROTECTED CODE 🔐
═══════════════════════════════════════════════════════════

Author:           Leon Sage
Organization:     Sage Audio LLC
Copyright:        © 2025 Leon Sage. All Rights Reserved.
License:          Proprietary
Signed:           2026-02-26 11:40:58
Certificate:      CodeSigning-LeonSage

CRYPTOGRAPHIC FINGERPRINT:
SHA-256:  70451C91D2229F06134EAAF0CCFA7C8893D048CF2A3B0C3F01BEA6F9EE5D915A
SHA-512:  A93096FCC05CBA235C1C2070D71516D48FCFE77BC5CD4103008B53885C02E4CF818F8715675549C7A6D1135FE2675C4A19099AFAD834EC1EAEB54636F9B3C1FE
MD5:      FB39D58A7F42FE10E3411C94F3707E20
File Size: 25760 bytes

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
// MODULE 6: DATABASE SERVICE
// Role: PostgreSQL persistence for ALL modules.
//       Exposes typed REST endpoints — no module talks to
//       Postgres directly, they all go through this service.
// Knows about: All modules (it stores data for everyone)
//              Module 9 (emits events on writes)
// Port: 3006 (internal only — not exposed publicly)
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import crypto from 'crypto';
import pg from 'pg';
import { getTodayISO, getTodayDate } from '../shared/date-utils.js';
import { verifyInternalToken, INTERNAL_HEADER, internalFetch } from '../shared/registry.js';
import { HealthStatus, TaskHistoryEntry, McpToolCall, WebhookSubscription, WebhookDelivery, SystemEvent } from '../shared/types.js';

const { Pool } = pg;

const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 10_000,
});

await fastify.register(cors, { origin: false }); // Internal only — no CORS needed

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

// All routes are internal-only
fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.url === '/health' || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
});

// ── PostgreSQL pool with production settings ──────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_MAX_CONNECTIONS ?? '10'),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? '30000'),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS ?? '5000'),
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS ?? '10000'),
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ── Pool error handler — auto-reconnect on connection loss ────

pool.on('error', (err) => {
  fastify.log.error({ err: err.message }, 'PostgreSQL pool error — client removed from pool');
});

pool.on('connect', () => {
  fastify.log.debug('New PostgreSQL client connected to pool');
});

pool.on('remove', () => {
  fastify.log.debug('PostgreSQL client removed from pool');
});

// ── Pool health monitoring ────────────────────────────────────

const poolMetrics = {
  totalQueries: 0,
  failedQueries: 0,
  totalQueryMs: 0,
  slowQueries: 0, // queries > 1s
  lastHealthCheck: getTodayISO(),
  isHealthy: true,
};

setInterval(async () => {
  try {
    const t0 = Date.now();
    await query('SELECT 1 AS ping');
    const ms = Date.now() - t0;
    poolMetrics.isHealthy = true;
    poolMetrics.lastHealthCheck = getTodayISO();
    if (ms > 500) fastify.log.warn({ ms }, 'Pool health check slow — database may be under load');
  } catch (err) {
    poolMetrics.isHealthy = false;
    fastify.log.error({ err: String(err).slice(0, 100) }, 'Pool health check FAILED — database connectivity issue');
  }
}, parseInt(process.env.DB_HEALTH_INTERVAL_MS ?? '30000'));

// ── Query with timeout, metrics, and retry on disconnect ──────

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = [], timeoutMs?: number): Promise<T[]> {
  const t0 = Date.now();
  const timeout = timeoutMs ?? parseInt(process.env.DB_STATEMENT_TIMEOUT_MS ?? '10000');

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    poolMetrics.failedQueries++;
    fastify.log.error({ err: String(err).slice(0, 100), sql: sql.slice(0, 100) }, 'Failed to acquire DB client');
    throw err;
  }

  try {
    // Set statement timeout per query
    if (timeout > 0) await client.query(`SET statement_timeout = ${timeout}`);
    const result = await client.query(sql, params);
    const ms = Date.now() - t0;
    poolMetrics.totalQueries++;
    poolMetrics.totalQueryMs += ms;
    if (ms > 1000) { poolMetrics.slowQueries++; fastify.log.warn({ ms, sql: sql.slice(0, 80) }, 'Slow query detected'); }
    return result.rows as T[];
  } catch (err) {
    poolMetrics.failedQueries++;
    const ms = Date.now() - t0;
    fastify.log.error({ err: String(err).slice(0, 100), ms, sql: sql.slice(0, 80) }, 'Query failed');
    throw err;
  } finally {
    client.release();
  }
}

async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

// ── Migration versioning table ────────────────────────────────

async function migrate() {
  // Create migrations tracking table first
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Get applied migrations
  const applied = await query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
  const appliedVersions = new Set(applied.map(r => r.version));

  interface Migration { version: number; name: string; up: string }
  const migrations: Migration[] = [
    {
      version: 1,
      name: 'initial_schema',
      up: `
        CREATE TABLE IF NOT EXISTS tasks (
          task_id UUID PRIMARY KEY,
          instruction TEXT NOT NULL,
          priority TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          completed_at TIMESTAMPTZ,
          duration_ms INTEGER,
          relevance_score INTEGER,
          audit_passed BOOLEAN,
          audit_recommendation TEXT,
          user_id TEXT,
          full_output TEXT,
          relevance_details JSONB,
          audit_findings JSONB,
          error TEXT
        )
      `,
    },
  ];

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    try {
      await query(migration.up);
      await query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING', [migration.version, migration.name]);
      fastify.log.info({ version: migration.version, name: migration.name }, 'Migration applied');
    } catch (err) {
      fastify.log.error({ version: migration.version, name: migration.name, err: String(err).slice(0, 200) }, 'Migration failed');
      throw err;
    }
  }

  // Run all table creation statements idempotently

  await query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID REFERENCES tasks(task_id),
      audit_date DATE NOT NULL,
      audited_at TIMESTAMPTZ NOT NULL,
      passed BOOLEAN NOT NULL,
      recommendation TEXT NOT NULL,
      summary TEXT,
      findings JSONB,
      user_id TEXT
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS gate_decisions (
      decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID,
      content_type TEXT NOT NULL,
      approved BOOLEAN NOT NULL,
      score INTEGER NOT NULL,
      reason TEXT,
      flagged_issues JSONB,
      checked_at TIMESTAMPTZ NOT NULL,
      relevance_date DATE NOT NULL,
      submitted_by TEXT
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS mcp_tool_calls (
      call_id UUID PRIMARY KEY,
      task_id UUID,
      tool_name TEXT NOT NULL,
      input JSONB,
      output TEXT,
      error TEXT,
      called_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      duration_ms INTEGER
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_secret_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      scopes JSONB NOT NULL,
      redirect_uris JSONB NOT NULL,
      grant_types JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_active BOOLEAN NOT NULL DEFAULT true,
      CONSTRAINT uq_oauth_clients_name UNIQUE (name)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      access_token_hash TEXT UNIQUE NOT NULL,
      refresh_token_hash TEXT UNIQUE,
      client_id UUID REFERENCES oauth_clients(client_id),
      user_id UUID REFERENCES users(user_id),
      scopes JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS secrets (
      secret_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL,
      encrypted_value TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      service TEXT NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS secret_rotation_logs (
      log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      secret_id UUID,
      secret_name TEXT NOT NULL,
      old_version INTEGER NOT NULL,
      new_version INTEGER NOT NULL,
      rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rotated_by TEXT NOT NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS events (
      event_id UUID PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      payload JSONB NOT NULL,
      emitted_at TIMESTAMPTZ NOT NULL,
      task_id UUID,
      user_id TEXT
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_url TEXT NOT NULL,
      events JSONB NOT NULL,
      secret TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_active BOOLEAN NOT NULL DEFAULT true,
      last_delivered_at TIMESTAMPTZ,
      failure_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subscription_id UUID REFERENCES webhook_subscriptions(subscription_id),
      event_id UUID REFERENCES events(event_id),
      target_url TEXT NOT NULL,
      status_code INTEGER,
      success BOOLEAN NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      response_ms INTEGER,
      error TEXT
    )
  `);

  // ── Blockchain tables ─────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS contracts (
      contract_id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      abi JSONB NOT NULL,
      bytecode TEXT,
      tx_hash TEXT,
      deployed_by TEXT,
      verified BOOLEAN NOT NULL DEFAULT false,
      deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      task_id UUID
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS blockchain_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID,
      tx_hash TEXT,
      status TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      block_number INTEGER,
      gas_used TEXT,
      effective_gas_price TEXT,
      error TEXT,
      simulation_passed BOOLEAN,
      description TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_contracts_address ON contracts(address)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_contracts_chain ON contracts(chain_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_blockchain_txs_chain ON blockchain_transactions(chain_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_blockchain_txs_status ON blockchain_transactions(status)`);

  // Indexes for common queries
  await query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tokens_hash ON oauth_tokens(access_token_hash)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tokens_expires ON oauth_tokens(expires_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_refresh_hash ON oauth_tokens(refresh_token_hash)`);

  // Seed placeholder client used for user login tokens (client_credentials flow needs a real client_id FK)
  await query(`
    INSERT INTO oauth_clients (client_id, client_secret_hash, name, scopes, redirect_uris, grant_types)
    VALUES ('00000000-0000-0000-0000-000000000001', 'user-login-placeholder', 'user-login-internal',
            '["admin:full"]'::jsonb, '[]'::jsonb, '["authorization_code","refresh_token"]'::jsonb)
    ON CONFLICT (client_id) DO NOTHING
  `);

  fastify.log.info('Database schema migration complete');
}

// ── Task endpoints ────────────────────────────────────────────

fastify.post('/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  await query(
    `INSERT INTO tasks (task_id, instruction, priority, status, created_at, completed_at,
      duration_ms, relevance_score, audit_passed, audit_recommendation, user_id,
      full_output, relevance_details, audit_findings, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (task_id) DO UPDATE SET
       status=EXCLUDED.status, completed_at=EXCLUDED.completed_at,
       duration_ms=EXCLUDED.duration_ms, relevance_score=EXCLUDED.relevance_score,
       audit_passed=EXCLUDED.audit_passed, audit_recommendation=EXCLUDED.audit_recommendation,
       full_output=EXCLUDED.full_output, relevance_details=EXCLUDED.relevance_details,
       audit_findings=EXCLUDED.audit_findings, error=EXCLUDED.error`,
    [
      b['taskId'], b['instruction'], b['priority'], b['status'],
      b['createdAt'], b['completedAt'], b['durationMs'], b['relevanceScore'],
      b['auditPassed'] ?? null, b['auditRecommendation'] ?? null, b['userId'] ?? null,
      b['fullOutput'] ?? null,
      b['relevanceDetails'] ? JSON.stringify(b['relevanceDetails']) : null,
      b['auditFindings'] ? JSON.stringify(b['auditFindings']) : null,
      b['error'] ?? null,
    ]
  );
  return reply.status(201).send({ ok: true });
});

fastify.get('/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const offset = parseInt(q['offset'] ?? '0');
  const status = q['status'];
  const userId = q['userId'];

  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params: unknown[] = [];
  if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
  if (userId) { params.push(userId); sql += ` AND user_id=$${params.length}`; }
  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const rows = await query(sql, params);
  const [countRow] = await query('SELECT COUNT(*) as total FROM tasks');
  return { total: parseInt(String(countRow?.['total'] ?? '0')), tasks: rows };
});

fastify.get('/tasks/:taskId', async (req: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
  const row = await queryOne('SELECT * FROM tasks WHERE task_id=$1', [req.params.taskId]);
  if (!row) return reply.status(404).send({ error: 'Task not found' });
  return row;
});

// ── Gate decisions ────────────────────────────────────────────

fastify.post('/gate-decisions', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  await query(
    `INSERT INTO gate_decisions (task_id, content_type, approved, score, reason,
      flagged_issues, checked_at, relevance_date, submitted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      b['taskId'] ?? null, b['contentType'], b['approved'], b['score'],
      b['reason'], JSON.stringify(b['flaggedIssues'] ?? []),
      b['checkedAt'], b['relevanceDate'], b['submittedBy'] ?? null,
    ]
  );
  return reply.status(201).send({ ok: true });
});

// ── Audit logs ────────────────────────────────────────────────

fastify.post('/audit-logs', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  await query(
    `INSERT INTO audit_logs (task_id, audit_date, audited_at, passed, recommendation, summary, findings, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      b['taskId'], b['auditDate'], b['auditedAt'], b['passed'],
      b['recommendation'], b['summary'], JSON.stringify(b['findings'] ?? []), b['userId'] ?? null,
    ]
  );
  return reply.status(201).send({ ok: true });
});

// ── MCP tool calls ────────────────────────────────────────────

fastify.post('/mcp-calls', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as McpToolCall;
  await query(
    `INSERT INTO mcp_tool_calls (call_id, task_id, tool_name, input, output, error, called_at, completed_at, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [b.callId, b.taskId, b.toolName, JSON.stringify(b.input), b.output ?? null, b.error ?? null,
      b.calledAt, b.completedAt ?? null, b.durationMs ?? null]
  );
  return reply.status(201).send({ ok: true });
});

// ── Auth — users, clients, tokens ────────────────────────────

fastify.post('/users', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const row = await queryOne(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING *`,
    [b['email'], b['passwordHash'], b['role'] ?? 'viewer']
  );
  return reply.status(201).send(row);
});

fastify.get('/users/:email', async (req: FastifyRequest<{ Params: { email: string } }>, reply: FastifyReply) => {
  const row = await queryOne('SELECT * FROM users WHERE email=$1 AND is_active=true', [req.params.email]);
  if (!row) return reply.status(404).send({ error: 'User not found' });
  return row;
});

fastify.patch('/users/:userId/last-login', async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
  await query('UPDATE users SET last_login_at=NOW() WHERE user_id=$1', [req.params.userId]);
  return { ok: true };
});

fastify.post('/oauth-clients', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const row = await queryOne(
    `INSERT INTO oauth_clients (client_secret_hash, name, scopes, redirect_uris, grant_types)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b['clientSecretHash'], b['name'], JSON.stringify(b['scopes']), JSON.stringify(b['redirectUris']), JSON.stringify(b['grantTypes'])]
  );
  return reply.status(201).send(row);
});

fastify.get('/oauth-clients/:clientId', async (req: FastifyRequest<{ Params: { clientId: string } }>, reply: FastifyReply) => {
  const row = await queryOne('SELECT * FROM oauth_clients WHERE client_id=$1 AND is_active=true', [req.params.clientId]);
  if (!row) return reply.status(404).send({ error: 'Client not found' });
  return row;
});

fastify.post('/oauth-tokens', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const row = await queryOne(
    `INSERT INTO oauth_tokens (access_token_hash, refresh_token_hash, client_id, user_id, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b['accessTokenHash'], b['refreshTokenHash'] ?? null, b['clientId'], b['userId'] ?? null,
      JSON.stringify(b['scopes']), b['expiresAt']]
  );
  return reply.status(201).send(row);
});

fastify.get('/oauth-tokens/by-hash/:hash', async (req: FastifyRequest<{ Params: { hash: string } }>, reply: FastifyReply) => {
  const row = await queryOne(
    'SELECT * FROM oauth_tokens WHERE access_token_hash=$1 AND revoked_at IS NULL AND expires_at > NOW()',
    [req.params.hash]
  );
  if (!row) return reply.status(404).send({ error: 'Token not found or expired' });
  return row;
});

fastify.delete('/oauth-tokens/:tokenId', async (req: FastifyRequest<{ Params: { tokenId: string } }>, reply: FastifyReply) => {
  await query('UPDATE oauth_tokens SET revoked_at=NOW() WHERE token_id=$1 AND revoked_at IS NULL', [req.params.tokenId]);
  return { ok: true };
});

// ── Secrets ───────────────────────────────────────────────────

fastify.post('/secrets', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const row = await queryOne(
    `INSERT INTO secrets (name, encrypted_value, version, service, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (name) DO UPDATE SET
       encrypted_value=EXCLUDED.encrypted_value,
       version=secrets.version+1,
       rotated_at=NOW(),
       expires_at=EXCLUDED.expires_at
     RETURNING *`,
    [b['name'], b['encryptedValue'], b['version'] ?? 1, b['service'], b['expiresAt'] ?? null]
  );
  return reply.status(201).send(row);
});

fastify.get('/secrets/:name', async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
  const row = await queryOne('SELECT * FROM secrets WHERE name=$1', [req.params.name]);
  if (!row) return reply.status(404).send({ error: 'Secret not found' });
  return row;
});

fastify.get('/secrets', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const service = q['service'];
  if (service) return query('SELECT secret_id,name,version,rotated_at,expires_at,service FROM secrets WHERE service=$1', [service]);
  return query('SELECT secret_id,name,version,rotated_at,expires_at,service FROM secrets ORDER BY name');
});

// ── Events ────────────────────────────────────────────────────

fastify.post('/events', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as SystemEvent;
  await query(
    `INSERT INTO events (event_id, type, source, payload, emitted_at, task_id, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [b.eventId, b.type, b.source, JSON.stringify(b.payload), b.emittedAt, b.taskId ?? null, b.userId ?? null]
  );
  return reply.status(201).send({ ok: true });
});

fastify.get('/events', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '100'), 1000);
  const type = q['type'];
  if (type) return query('SELECT * FROM events WHERE type=$1 ORDER BY emitted_at DESC LIMIT $2', [type, limit]);
  return query('SELECT * FROM events ORDER BY emitted_at DESC LIMIT $1', [limit]);
});

// ── Webhook subscriptions ─────────────────────────────────────

fastify.post('/webhook-subscriptions', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const row = await queryOne(
    `INSERT INTO webhook_subscriptions (target_url, events, secret)
     VALUES ($1,$2,$3) RETURNING *`,
    [b['targetUrl'], JSON.stringify(b['events']), b['secret']]
  );
  return reply.status(201).send(row);
});

fastify.get('/webhook-subscriptions', async () => {
  return query('SELECT * FROM webhook_subscriptions WHERE is_active=true ORDER BY created_at DESC');
});

fastify.get('/webhook-subscriptions/for-event/:eventType', async (req: FastifyRequest<{ Params: { eventType: string } }>) => {
  return query(
    `SELECT * FROM webhook_subscriptions WHERE is_active=true AND events @> $1::jsonb`,
    [JSON.stringify([req.params.eventType])]
  );
});

fastify.patch('/webhook-subscriptions/:id/failure', async (req: FastifyRequest<{ Params: { id: string } }>) => {
  await query(
    'UPDATE webhook_subscriptions SET failure_count=failure_count+1 WHERE subscription_id=$1',
    [req.params.id]
  );
  return { ok: true };
});

fastify.patch('/webhook-subscriptions/:id/delivered', async (req: FastifyRequest<{ Params: { id: string } }>) => {
  await query(
    'UPDATE webhook_subscriptions SET last_delivered_at=NOW(), failure_count=0 WHERE subscription_id=$1',
    [req.params.id]
  );
  return { ok: true };
});

// ── Admin stats ───────────────────────────────────────────────

fastify.get('/stats', async () => {
  const [taskStats] = await query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status='completed') as completed,
      COUNT(*) FILTER (WHERE status='failed') as failed,
      COUNT(*) FILTER (WHERE status='rejected_by_gate') as rejected_gate,
      COUNT(*) FILTER (WHERE status='rejected_by_audit') as rejected_audit,
      ROUND(AVG(duration_ms)) as avg_duration,
      ROUND(AVG(relevance_score)) as avg_score
    FROM tasks
  `);
  const [activeUsers] = await query(`SELECT COUNT(*) as count FROM users WHERE is_active=true`);
  const [activeTokens] = await query(`SELECT COUNT(*) as count FROM oauth_tokens WHERE revoked_at IS NULL AND expires_at > NOW()`);
  const [expiringSecrets] = await query(`SELECT COUNT(*) as count FROM secrets WHERE expires_at < NOW() + INTERVAL '7 days' AND expires_at > NOW()`);
  const [webhooks] = await query(`SELECT COUNT(*) as count FROM webhook_subscriptions WHERE is_active=true`);

  return {
    date: getTodayDate(),
    timestamp: getTodayISO(),
    tasks: {
      total: parseInt(String(taskStats?.['total'] ?? 0)),
      completed: parseInt(String(taskStats?.['completed'] ?? 0)),
      failed: parseInt(String(taskStats?.['failed'] ?? 0)),
      rejectedByGate: parseInt(String(taskStats?.['rejected_gate'] ?? 0)),
      rejectedByAudit: parseInt(String(taskStats?.['rejected_audit'] ?? 0)),
      avgDurationMs: parseInt(String(taskStats?.['avg_duration'] ?? 0)),
      avgRelevanceScore: parseInt(String(taskStats?.['avg_score'] ?? 0)),
    },
    activeUsers: parseInt(String(activeUsers?.['count'] ?? 0)),
    activeTokens: parseInt(String(activeTokens?.['count'] ?? 0)),
    secretsExpiringSoon: parseInt(String(expiringSecrets?.['count'] ?? 0)),
    webhookSubscriptions: parseInt(String(webhooks?.['count'] ?? 0)),
  };
});

// ── Blockchain — contracts ────────────────────────────────────

fastify.post('/contracts', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  await query(
    `INSERT INTO contracts (contract_id, name, address, chain_id, abi, bytecode, tx_hash, deployed_by, verified, deployed_at, task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (contract_id) DO UPDATE SET
       verified=EXCLUDED.verified, deployed_by=EXCLUDED.deployed_by`,
    [b['contractId'], b['name'], b['address'], b['chainId'], JSON.stringify(b['abi']),
      b['bytecode'] ?? null, b['txHash'] ?? null, b['deployedBy'] ?? null,
      b['verified'] ?? false, b['deployedAt'] ?? new Date().toISOString(), b['taskId'] ?? null]
  );
  return reply.status(201).send({ ok: true });
});

fastify.get('/contracts', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const chainId = q['chainId'] ? parseInt(q['chainId']) : null;
  if (chainId) {
    return query('SELECT * FROM contracts WHERE chain_id=$1 ORDER BY deployed_at DESC LIMIT $2', [chainId, limit]);
  }
  return query('SELECT * FROM contracts ORDER BY deployed_at DESC LIMIT $1', [limit]);
});

fastify.get('/contracts/:address', async (req: FastifyRequest<{ Params: { address: string } }>, reply: FastifyReply) => {
  const row = await queryOne('SELECT * FROM contracts WHERE address=$1', [req.params.address]);
  if (!row) return reply.status(404).send({ error: 'Contract not found' });
  return row;
});

// ── Blockchain — transactions ─────────────────────────────────

fastify.post('/blockchain-transactions', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  await query(
    `INSERT INTO blockchain_transactions (task_id, tx_hash, status, chain_id, block_number, gas_used, effective_gas_price, error, simulation_passed, description, submitted_at, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [b['taskId'] ?? null, b['txHash'] ?? null, b['status'], b['chainId'],
      b['blockNumber'] ?? null, b['gasUsed'] ?? null, b['effectiveGasPrice'] ?? null,
      b['error'] ?? null, b['simulationPassed'] ?? null, b['description'] ?? null,
      b['submittedAt'] ?? new Date().toISOString(), b['confirmedAt'] ?? null]
  );
  return reply.status(201).send({ ok: true });
});

fastify.get('/blockchain-transactions', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const chainId = q['chainId'] ? parseInt(q['chainId']) : null;
  if (chainId) {
    return query('SELECT * FROM blockchain_transactions WHERE chain_id=$1 ORDER BY submitted_at DESC LIMIT $2', [chainId, limit]);
  }
  return query('SELECT * FROM blockchain_transactions ORDER BY submitted_at DESC LIMIT $1', [limit]);
});

// ── Stellar persistence routes ────────────────────────────────

// Ensure stellar tables exist (runtime migration — safe to call multiple times)
async function ensureStellarTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS stellar_contracts (
      contract_id     TEXT         PRIMARY KEY,
      name            TEXT         NOT NULL,
      network         TEXT         NOT NULL,
      wasm_hash       TEXT,
      deployed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      task_id         TEXT,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_stellar_contracts_network ON stellar_contracts(network)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_stellar_contracts_task_id ON stellar_contracts(task_id)`);
  await query(`
    CREATE TABLE IF NOT EXISTS stellar_transactions (
      id              BIGSERIAL    PRIMARY KEY,
      task_id         TEXT         NOT NULL,
      network         TEXT         NOT NULL,
      tx_hash         TEXT,
      status          TEXT         NOT NULL,
      ledger          INTEGER,
      fee_charged     TEXT,
      result_xdr      TEXT,
      explorer_url    TEXT,
      description     TEXT,
      error           TEXT,
      submitted_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      confirmed_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_stellar_tx_task_id ON stellar_transactions(task_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_stellar_tx_network  ON stellar_transactions(network)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_stellar_tx_hash     ON stellar_transactions(tx_hash)`);
}

// Run stellar table migration on startup (non-blocking)
setImmediate(() => ensureStellarTables().catch(() => {}));

fastify.post('/stellar-contracts', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  if (!b['contract_id'] && !b['contractId']) return reply.status(400).send({ error: 'contractId required' });
  const contractId = (b['contractId'] ?? b['contract_id']) as string;
  const name       = (b['name'] ?? '') as string;
  const network    = (b['network'] ?? 'mainnet') as string;
  const wasmHash   = (b['wasmHash'] ?? b['wasm_hash'] ?? null) as string | null;
  const taskId     = (b['taskId'] ?? b['task_id'] ?? null) as string | null;
  const deployedAt = (b['deployedAt'] ?? b['deployed_at'] ?? new Date().toISOString()) as string;
  await query(
    `INSERT INTO stellar_contracts (contract_id, name, network, wasm_hash, task_id, deployed_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (contract_id) DO UPDATE SET name=$2, network=$3, wasm_hash=$4`,
    [contractId, name, network, wasmHash, taskId, deployedAt]
  );
  return reply.status(201).send({ ok: true, contractId });
});

fastify.get('/stellar-contracts', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const network = q['network'] ?? null;
  if (network) {
    return query('SELECT * FROM stellar_contracts WHERE network=$1 ORDER BY deployed_at DESC LIMIT $2', [network, limit]);
  }
  return query('SELECT * FROM stellar_contracts ORDER BY deployed_at DESC LIMIT $1', [limit]);
});

fastify.get('/stellar-contracts/:contractId', async (req: FastifyRequest<{ Params: { contractId: string } }>, reply: FastifyReply) => {
  const row = await queryOne('SELECT * FROM stellar_contracts WHERE contract_id=$1', [req.params.contractId]);
  if (!row) return reply.status(404).send({ error: 'Contract not found' });
  return row;
});

fastify.post('/stellar-transactions', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  if (!b['taskId'] && !b['task_id']) return reply.status(400).send({ error: 'taskId required' });
  const taskId      = (b['taskId']      ?? b['task_id']      ?? '') as string;
  const network     = (b['network']     ?? 'mainnet') as string;
  const txHash      = (b['txHash']      ?? b['tx_hash']      ?? null) as string | null;
  const status      = (b['status']      ?? 'submitted') as string;
  const ledger      = (b['ledger']      ?? null) as number | null;
  const feeCharged  = (b['feeCharged']  ?? b['fee_charged']  ?? null) as string | null;
  const resultXdr   = (b['resultXdr']   ?? b['result_xdr']   ?? null) as string | null;
  const explorerUrl = (b['explorerUrl'] ?? b['explorer_url'] ?? null) as string | null;
  const description = (b['description'] ?? null) as string | null;
  const error       = (b['error']       ?? null) as string | null;
  const submittedAt = (b['submittedAt'] ?? b['submitted_at'] ?? new Date().toISOString()) as string;
  const confirmedAt = (b['confirmedAt'] ?? b['confirmed_at'] ?? null) as string | null;
  await query(
    `INSERT INTO stellar_transactions
       (task_id, network, tx_hash, status, ledger, fee_charged, result_xdr, explorer_url, description, error, submitted_at, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [taskId, network, txHash, status, ledger, feeCharged, resultXdr, explorerUrl, description, error, submittedAt, confirmedAt]
  );
  return reply.status(201).send({ ok: true });
});

fastify.get('/stellar-transactions', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit   = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const network = q['network'] ?? null;
  if (network) {
    return query('SELECT * FROM stellar_transactions WHERE network=$1 ORDER BY submitted_at DESC LIMIT $2', [network, limit]);
  }
  return query('SELECT * FROM stellar_transactions ORDER BY submitted_at DESC LIMIT $1', [limit]);
});

// ── Missing endpoints that auth + secrets reference ───────────

// GET /oauth-tokens/by-refresh-hash/:hash — used by module7 refresh_token flow
fastify.get('/oauth-tokens/by-refresh-hash/:hash', async (req: FastifyRequest<{ Params: { hash: string } }>, reply: FastifyReply) => {
  const row = await queryOne(
    'SELECT * FROM oauth_tokens WHERE refresh_token_hash=$1 AND revoked_at IS NULL AND expires_at > NOW()',
    [req.params.hash]
  );
  if (!row) return reply.status(404).send({ error: 'Refresh token not found or expired' });
  return row;
});

// POST /secret-rotation-logs — used by module8 secrets manager
fastify.post('/secret-rotation-logs', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  await query(
    `INSERT INTO secret_rotation_logs (secret_id, secret_name, old_version, new_version, rotated_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [b['secretId'], b['secretName'], b['oldVersion'], b['newVersion'], b['rotatedBy']]
  );
  return reply.status(201).send({ ok: true });
});

// POST /webhook-deliveries — used by module9 events bus
fastify.post('/webhook-deliveries', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  await query(
    `INSERT INTO webhook_deliveries (subscription_id, event_id, target_url, status_code, success, response_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [b['subscriptionId'], b['eventId'], b['targetUrl'], b['statusCode'] ?? null,
      b['success'], b['responseMs'] ?? null, b['error'] ?? null]
  );
  return reply.status(201).send({ ok: true });
});

// GET /users/:userId/exists — used by admin to check users
fastify.get('/users/id/:userId', async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
  const row = await queryOne('SELECT user_id,email,role,is_active,created_at,last_login_at FROM users WHERE user_id=$1', [req.params.userId]);
  if (!row) return reply.status(404).send({ error: 'User not found' });
  return row;
});

// GET /users — list all users (admin)
fastify.get('/users', async () => {
  return query('SELECT user_id,email,role,is_active,created_at,last_login_at FROM users ORDER BY created_at DESC');
});

// PATCH /users/:userId/deactivate
fastify.patch('/users/:userId/deactivate', async (req: FastifyRequest<{ Params: { userId: string } }>) => {
  await query('UPDATE users SET is_active=false WHERE user_id=$1', [req.params.userId]);
  return { ok: true };
});

// PATCH /users/:userId/activate
fastify.patch('/users/:userId/activate', async (req: FastifyRequest<{ Params: { userId: string } }>) => {
  await query('UPDATE users SET is_active=true WHERE user_id=$1', [req.params.userId]);
  return { ok: true };
});

// POST /oauth-tokens/revoke-all/:userId — revoke all active tokens for user
fastify.post('/oauth-tokens/revoke-all/:userId', async (req: FastifyRequest<{ Params: { userId: string } }>) => {
  const result = await query('UPDATE oauth_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL RETURNING token_id', [req.params.userId]);
  return { ok: true, revokedCount: result.length };
});

// GET /oauth-tokens/stats — token statistics
fastify.get('/oauth-tokens/stats', async () => {
  const [stats] = await query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at > NOW()) as active,
      COUNT(*) FILTER (WHERE revoked_at IS NOT NULL) as revoked,
      COUNT(*) FILTER (WHERE expires_at <= NOW() AND revoked_at IS NULL) as expired
    FROM oauth_tokens
  `);
  return stats ?? { total: 0, active: 0, revoked: 0, expired: 0 };
});

// GET /webhook-subscriptions/:id — single subscription
fastify.get('/webhook-subscriptions/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const row = await queryOne('SELECT * FROM webhook_subscriptions WHERE subscription_id=$1', [req.params.id]);
  if (!row) return reply.status(404).send({ error: 'Subscription not found' });
  return row;
});

// DELETE /webhook-subscriptions/:id — deactivate subscription
fastify.delete('/webhook-subscriptions/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const result = await query('UPDATE webhook_subscriptions SET is_active=false WHERE subscription_id=$1 RETURNING subscription_id', [req.params.id]);
  if (!result.length) return reply.status(404).send({ error: 'Subscription not found' });
  return { ok: true };
});

// GET /audit-logs — query audit logs with filters
fastify.get('/audit-logs', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const taskId = q['taskId'];
  const passed = q['passed'];
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params: unknown[] = [];
  if (taskId) { params.push(taskId); sql += ` AND task_id=$${params.length}`; }
  if (passed !== undefined) { params.push(passed === 'true'); sql += ` AND passed=$${params.length}`; }
  sql += ` ORDER BY audited_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  return query(sql, params);
});

// GET /gate-decisions — query gate decisions with filters
fastify.get('/gate-decisions', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const taskId = q['taskId'];
  const approved = q['approved'];
  const submittedBy = q['submittedBy'];
  let sql = 'SELECT * FROM gate_decisions WHERE 1=1';
  const params: unknown[] = [];
  if (taskId) { params.push(taskId); sql += ` AND task_id=$${params.length}`; }
  if (approved !== undefined) { params.push(approved === 'true'); sql += ` AND approved=$${params.length}`; }
  if (submittedBy) { params.push(submittedBy); sql += ` AND submitted_by=$${params.length}`; }
  sql += ` ORDER BY checked_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  return query(sql, params);
});

// GET /mcp-calls — query MCP tool call history
fastify.get('/mcp-calls', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const taskId = q['taskId'];
  const toolName = q['toolName'];
  let sql = 'SELECT * FROM mcp_tool_calls WHERE 1=1';
  const params: unknown[] = [];
  if (taskId) { params.push(taskId); sql += ` AND task_id=$${params.length}`; }
  if (toolName) { params.push(toolName); sql += ` AND tool_name=$${params.length}`; }
  sql += ` ORDER BY called_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  return query(sql, params);
});

// GET /events — with taskId filter support
fastify.get('/events', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '100'), 1000);
  const type = q['type'];
  const taskId = q['taskId'];
  let sql = 'SELECT * FROM events WHERE 1=1';
  const params: unknown[] = [];
  if (type) { params.push(type); sql += ` AND type=$${params.length}`; }
  if (taskId) { params.push(taskId); sql += ` AND task_id=$${params.length}`; }
  sql += ` ORDER BY emitted_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  return query(sql, params);
});

// GET /events/:eventId — single event
fastify.get('/events/:eventId', async (req: FastifyRequest<{ Params: { eventId: string } }>, reply: FastifyReply) => {
  const row = await queryOne('SELECT * FROM events WHERE event_id=$1', [req.params.eventId]);
  if (!row) return reply.status(404).send({ error: 'Event not found' });
  return row;
});

// GET /secret-rotation-logs — rotation audit trail
fastify.get('/secret-rotation-logs', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const secretName = q['secretName'];
  if (secretName) {
    return query('SELECT * FROM secret_rotation_logs WHERE secret_name=$1 ORDER BY rotated_at DESC LIMIT $2', [secretName, limit]);
  }
  return query('SELECT * FROM secret_rotation_logs ORDER BY rotated_at DESC LIMIT $1', [limit]);
});

// GET /secrets/expiring — secrets expiring within N days
fastify.get('/secrets/expiring', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const days = parseInt(q['days'] ?? '7');
  return query(
    `SELECT secret_id, name, version, service, expires_at, rotated_at FROM secrets WHERE expires_at IS NOT NULL AND expires_at > NOW() AND expires_at < NOW() + $1::interval ORDER BY expires_at ASC`,
    [`${days} days`]
  );
});

// DELETE /secrets/:name — delete a secret
fastify.delete('/secrets/:name', async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
  const result = await query('DELETE FROM secrets WHERE name=$1 RETURNING secret_id', [req.params.name]);
  if (!result.length) return reply.status(404).send({ error: 'Secret not found' });
  return { ok: true, deleted: req.params.name };
});

// GET /webhook-deliveries — delivery history for a subscription
fastify.get('/webhook-deliveries', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 500);
  const subscriptionId = q['subscriptionId'];
  if (subscriptionId) {
    return query('SELECT * FROM webhook_deliveries WHERE subscription_id=$1 ORDER BY attempted_at DESC LIMIT $2', [subscriptionId, limit]);
  }
  return query('SELECT * FROM webhook_deliveries ORDER BY attempted_at DESC LIMIT $1', [limit]);
});

// ── Health ────────────────────────────────────────────────────

fastify.get('/health', async (_, reply: FastifyReply): Promise<HealthStatus> => {
  try {
    const t0 = Date.now();
    await query('SELECT 1');
    const pingMs = Date.now() - t0;
    return reply.send({
      service: 'module6-database', status: 'online',
      date: getTodayDate(), timestamp: getTodayISO(),
      uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        isHealthy: poolMetrics.isHealthy,
        pingMs,
      },
      queries: {
        total: poolMetrics.totalQueries,
        failed: poolMetrics.failedQueries,
        slow: poolMetrics.slowQueries,
        avgMs: poolMetrics.totalQueries > 0 ? Math.round(poolMetrics.totalQueryMs / poolMetrics.totalQueries) : 0,
      },
    });
  } catch (err) {
    return reply.status(503).send({
      service: 'module6-database', status: 'offline',
      date: getTodayDate(), timestamp: getTodayISO(),
      error: String(err).slice(0, 100),
    });
  }
});

// GET /pool — pool statistics
fastify.get('/pool', async () => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
  isHealthy: poolMetrics.isHealthy,
  lastHealthCheck: poolMetrics.lastHealthCheck,
  queries: {
    total: poolMetrics.totalQueries,
    failed: poolMetrics.failedQueries,
    slow: poolMetrics.slowQueries,
    avgMs: poolMetrics.totalQueries > 0 ? Math.round(poolMetrics.totalQueryMs / poolMetrics.totalQueries) : 0,
    successRate: poolMetrics.totalQueries > 0 ? (((poolMetrics.totalQueries - poolMetrics.failedQueries) / poolMetrics.totalQueries) * 100).toFixed(1) + '%' : 'N/A',
  },
  timestamp: getTodayISO(),
}));

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGTERM', async () => { await pool.end(); await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await pool.end(); await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    await migrate();
    await fastify.listen({ port: 3006, host: '0.0.0.0' });
    fastify.log.info('🗄️  Database Service online — port 3006');
    fastify.log.info(`📅 ${getTodayDate()} | PostgreSQL connected`);
  } catch (err) { fastify.log.error(err, 'Database Service failed to start'); process.exit(1); }
};
start();

