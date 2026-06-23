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
SHA-256:  4FE22543C0616F7C19CF938CF0A8C45A051A30BD962186E652FAC979C2F3DD80
SHA-512:  9E65713EB421E30AE12DA8CC8CAC9D7F48AE7C6D2EBCA6094A5CEC7141F4091F3C195A31AAC5E15CD84D30DBA27E43FCA33342DF8723C02BB7DC68C9C796E900
MD5:      F045778ECE8AFC34A671C03B854D5FB9
File Size: 18159 bytes

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
// MODULE 7: AUTH SERVICE
// Role: OAuth2 server — issues and validates all tokens.
//       Every module calls /introspect to verify requests.
//       Human users: authorization_code flow
//       Service-to-service: client_credentials flow
// Knows about: Module 6 (all auth data persisted there)
//              Module 9 (emits auth events)
// Port: 3007
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import crypto from 'crypto';
import { getTodayISO, getTodayDate } from '../shared/date-utils.js';
import { verifyInternalToken, INTERNAL_HEADER, internalFetch, getServiceUrl } from '../shared/registry.js';
import { OAuthScope, TokenIntrospectResult, HealthStatus } from '../shared/types.js';

const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 15_000,
});

await fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGIN ?? '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

await fastify.register(rateLimit, {
  max: 30,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.headers['x-forwarded-for'] as string ?? req.ip,
});

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

// ── Crypto helpers ────────────────────────────────────────────

const ACCESS_TOKEN_TTL_SECONDS = 3600;        // 1 hour
const REFRESH_TOKEN_TTL_SECONDS = 30 * 86400; // 30 days

function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
}

function generateSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Passwords stored as "salt:hash"
function createPasswordHash(password: string): string {
  const salt = generateSalt();
  return `${salt}:${hashPassword(password, salt)}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const attempt = hashPassword(password, salt);
  if (attempt.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < attempt.length; i++) {
    diff |= attempt.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return diff === 0;
}

// ── Scope validation ──────────────────────────────────────────

const VALID_SCOPES: OAuthScope[] = [
  'tasks:read', 'tasks:write', 'tasks:admin',
  'audit:read', 'gate:read', 'gate:admin',
  'mcp:use', 'events:read', 'admin:full',
];

function validateScopes(requested: string[]): OAuthScope[] {
  return requested.filter((s): s is OAuthScope => VALID_SCOPES.includes(s as OAuthScope));
}

function scopeAllows(tokenScopes: OAuthScope[], required: OAuthScope): boolean {
  return tokenScopes.includes('admin:full') || tokenScopes.includes(required);
}

// ── Database calls ────────────────────────────────────────────

async function dbGetUserByEmail(email: string): Promise<Record<string, unknown> | null> {
  const res = await internalFetch('module6-database', `/users/${encodeURIComponent(email)}`, {}, 5_000);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DB error looking up user: ${res.status}`);
  return res.json();
}

async function dbCreateUser(email: string, passwordHash: string, role: string): Promise<Record<string, unknown>> {
  const res = await internalFetch('module6-database', '/users', {
    method: 'POST',
    body: JSON.stringify({ email, passwordHash, role }),
  }, 5_000);
  if (!res.ok) throw new Error(`DB error creating user: ${res.status}`);
  return res.json();
}

async function dbGetClient(clientId: string): Promise<Record<string, unknown> | null> {
  const res = await internalFetch('module6-database', `/oauth-clients/${clientId}`, {}, 5_000);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DB error looking up client: ${res.status}`);
  return res.json();
}

async function dbCreateClient(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await internalFetch('module6-database', '/oauth-clients', {
    method: 'POST',
    body: JSON.stringify(data),
  }, 5_000);
  if (!res.ok) throw new Error(`DB error creating client: ${res.status}`);
  return res.json();
}

async function dbSaveToken(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await internalFetch('module6-database', '/oauth-tokens', {
    method: 'POST',
    body: JSON.stringify(data),
  }, 5_000);
  if (!res.ok) throw new Error(`DB error saving token: ${res.status}`);
  return res.json();
}

async function dbGetTokenByHash(hash: string): Promise<Record<string, unknown> | null> {
  const res = await internalFetch('module6-database', `/oauth-tokens/by-hash/${hash}`, {}, 5_000);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DB error looking up token: ${res.status}`);
  const tokenRow = await res.json() as Record<string, unknown>;
  // Enrich with user role if this is a user token
  if (tokenRow['user_id']) {
    try {
      const userRes = await internalFetch('module6-database', `/users/id/${tokenRow['user_id']}`, {}, 3_000);
      if (userRes.ok) {
        const user = await userRes.json() as Record<string, unknown>;
        tokenRow['role'] = user['role'];
      }
    } catch { /* best-effort role enrichment */ }
  }
  return tokenRow;
}

async function dbRevokeToken(tokenId: string): Promise<void> {
  await internalFetch('module6-database', `/oauth-tokens/${tokenId}`, { method: 'DELETE' }, 5_000);
}

async function dbUpdateLastLogin(userId: string): Promise<void> {
  await internalFetch('module6-database', `/users/${userId}/last-login`, { method: 'PATCH' }, 3_000);
}

async function emitEvent(type: string, payload: Record<string, unknown>) {
  try {
    await internalFetch('module9-events', '/emit', {
      method: 'POST',
      body: JSON.stringify({ type, source: 'module7-auth', payload, emittedAt: getTodayISO() }),
    }, 3_000);
  } catch { /* best-effort */ }
}

// ── Structured logging — no secrets ──────────────────────────

fastify.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
  fastify.log.info({ requestId: req.id, method: req.method, url: req.url, statusCode: reply.statusCode, durationMs: Math.round(reply.elapsedTime), ip: req.ip }, 'auth request');
});

// ── Brute force protection ────────────────────────────────────

const MAX_FAILED_ATTEMPTS = parseInt(process.env.AUTH_MAX_FAILED_ATTEMPTS ?? '5');
const LOCKOUT_DURATION_MS = parseInt(process.env.AUTH_LOCKOUT_DURATION_MS ?? String(15 * 60 * 1000));

interface LockoutEntry { failures: number; firstFailAt: number; lockedUntil: number; }
const loginAttempts = new Map<string, LockoutEntry>();

function checkBruteForce(email: string): { locked: boolean; remainingMs: number } {
  const entry = loginAttempts.get(email);
  if (!entry) return { locked: false, remainingMs: 0 };
  const now = Date.now();
  if (now - entry.firstFailAt > LOCKOUT_DURATION_MS * 2) { loginAttempts.delete(email); return { locked: false, remainingMs: 0 }; }
  if (entry.lockedUntil > now) return { locked: true, remainingMs: entry.lockedUntil - now };
  return { locked: false, remainingMs: 0 };
}

function recordFailedLogin(email: string, ip: string) {
  const now = Date.now();
  const entry = loginAttempts.get(email) ?? { failures: 0, firstFailAt: now, lockedUntil: 0 };
  entry.failures++;
  if (entry.failures >= MAX_FAILED_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    fastify.log.warn({ email, ip, failures: entry.failures }, 'Account locked — too many failed attempts');
    void emitEvent('auth.account_locked', { email, ip, failures: entry.failures, lockedUntilMinutes: Math.ceil(LOCKOUT_DURATION_MS / 60000) });
  }
  loginAttempts.set(email, entry);
}

function clearFailedLogin(email: string) { loginAttempts.delete(email); }

setInterval(() => {
  const now = Date.now();
  for (const [email, entry] of loginAttempts) {
    if (now - entry.firstFailAt > LOCKOUT_DURATION_MS * 2) loginAttempts.delete(email);
  }
}, 30 * 60 * 1000);


// ── Schemas ───────────────────────────────────────────────────

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  role: z.enum(['admin', 'operator', 'viewer']).default('viewer'),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const ClientCreateSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()),
  redirectUris: z.array(z.string().url()).default([]),
  grantTypes: z.array(z.enum(['authorization_code', 'client_credentials', 'refresh_token']))
    .default(['client_credentials']),
});

const TokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('client_credentials'),
    client_id: z.string(),
    client_secret: z.string(),
    scope: z.string().optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    client_id: z.string(),
    client_secret: z.string(),
    refresh_token: z.string(),
  }),
]);

const IntrospectSchema = z.object({
  token: z.string(),
  required_scope: z.string().optional(),
});

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => ({
  service: 'module7-auth',
  status: 'online',
  date: getTodayDate(),
  timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  dependencies: {
    database: getServiceUrl('module6-database'),
    events: getServiceUrl('module9-events'),
  },
}));

// POST /register — create human user account
fastify.post('/register', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  }
  const { email, password, role } = parsed.data;

  const existing = await dbGetUserByEmail(email);
  if (existing) return reply.status(409).send({ error: 'Email already registered' });

  const passwordHash = createPasswordHash(password);
  const user = await dbCreateUser(email, passwordHash, role);
  await emitEvent('auth.user_registered', { email, role });

  return reply.status(201).send({
    userId: user['user_id'],
    email: user['email'],
    role: user['role'],
    createdAt: user['created_at'],
  });
});

// POST /login — issue token for human user with brute force protection
fastify.post('/login', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues, requestId: req.id });

  const { email, password } = parsed.data;
  const ip = req.headers['x-forwarded-for'] as string ?? req.ip;

  // Check brute force lockout BEFORE hitting database
  const bruteForce = checkBruteForce(email);
  if (bruteForce.locked) {
    fastify.log.warn({ email, ip, remainingMs: bruteForce.remainingMs, requestId: req.id }, 'Login blocked — account locked');
    return reply.status(429).send({
      error: 'Account temporarily locked due to too many failed attempts',
      retryAfterSeconds: Math.ceil(bruteForce.remainingMs / 1000),
      requestId: req.id,
    });
  }

  let user: Record<string, unknown> | null;
  try {
    user = await dbGetUserByEmail(email);
  } catch {
    return reply.status(503).send({ error: 'Auth service temporarily unavailable', requestId: req.id });
  }

  if (!user || !verifyPassword(password, String(user['password_hash']))) {
    recordFailedLogin(email, ip);
    fastify.log.warn({ email, ip, attempts: loginAttempts.get(email)?.failures ?? 0, requestId: req.id }, 'Login failed — invalid credentials');
    await emitEvent('auth.login_failed', { email, ip, attempts: loginAttempts.get(email)?.failures ?? 0 });
    return reply.status(401).send({ error: 'Invalid credentials', requestId: req.id });
  }

  if (!user['is_active']) {
    fastify.log.warn({ email, ip, requestId: req.id }, 'Login blocked — account deactivated');
    return reply.status(403).send({ error: 'Account disabled — contact administrator', requestId: req.id });
  }

  // Clear failed login counter on success
  clearFailedLogin(email);

  const roleScopes: Record<string, OAuthScope[]> = {
    admin:    ['tasks:read', 'tasks:write', 'tasks:admin', 'audit:read', 'gate:read', 'gate:admin', 'mcp:use', 'events:read', 'admin:full', 'blockchain:read', 'blockchain:write', 'blockchain:deploy', 'admin'],
    operator: ['tasks:read', 'tasks:write', 'audit:read', 'gate:read', 'mcp:use', 'events:read', 'blockchain:read', 'blockchain:write'],
    viewer:   ['tasks:read', 'audit:read', 'gate:read', 'events:read', 'blockchain:read'],
  };
  const scopes = roleScopes[String(user['role'])] ?? ['tasks:read'];
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  const userClientId = '00000000-0000-0000-0000-000000000001';

  await dbSaveToken({
    accessTokenHash: hashToken(accessToken),
    refreshTokenHash: hashToken(refreshToken),
    clientId: userClientId,
    userId: String(user['user_id']),
    scopes,
    expiresAt,
  });

  void dbUpdateLastLogin(String(user['user_id']));
  fastify.log.info({ email, userId: user['user_id'], role: user['role'], ip, requestId: req.id }, 'Login successful');
  await emitEvent('auth.token_issued', { userId: user['user_id'], email, scopes, type: 'login', ip });

  return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, scope: scopes.join(' ') };
});

// POST /change-password — invalidates ALL tokens on password change
fastify.post('/change-password', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const userId = String(b['userId'] ?? '');
  const oldPassword = String(b['oldPassword'] ?? '');
  const newPassword = String(b['newPassword'] ?? '');
  if (!userId || !oldPassword || !newPassword) return reply.status(400).send({ error: 'userId, oldPassword, and newPassword required' });
  if (newPassword.length < 12) return reply.status(400).send({ error: 'newPassword must be at least 12 characters' });

  try {
    const userRes = await internalFetch('module6-database', `/users/id/${userId}`, {}, 5_000);
    if (!userRes.ok) return reply.status(404).send({ error: 'User not found' });
    const user = await userRes.json() as Record<string, unknown>;
    if (!verifyPassword(oldPassword, String(user['password_hash']))) {
      return reply.status(401).send({ error: 'Current password incorrect' });
    }
    const newHash = createPasswordHash(newPassword);
    await internalFetch('module6-database', `/users/${userId}/password`, { method: 'PATCH', body: JSON.stringify({ passwordHash: newHash }) }, 5_000);
    // Revoke ALL active tokens — session invalidation on password change
    await internalFetch('module6-database', `/oauth-tokens/revoke-all/${userId}`, { method: 'POST' }, 5_000);
    fastify.log.info({ userId, requestId: req.id }, 'Password changed — all tokens revoked');
    void emitEvent('auth.password_changed', { userId, tokensRevoked: true });
    return reply.send({ ok: true, message: 'Password changed. All active sessions terminated. Please login again.' });
  } catch (err) {
    fastify.log.error({ err: String(err).slice(0, 100), requestId: req.id }, 'Password change failed');
    return reply.status(503).send({ error: 'Service temporarily unavailable' });
  }
});

// GET /lockouts — view current lockout state (internal only)
fastify.get('/lockouts', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) return reply.status(401).send({ error: 'Internal token required' });
  const now = Date.now();
  const lockouts = [...loginAttempts.entries()].map(([email, e]) => ({
    email, failures: e.failures,
    locked: e.lockedUntil > now,
    lockedUntil: e.lockedUntil > now ? new Date(e.lockedUntil).toISOString() : null,
    remainingSeconds: e.lockedUntil > now ? Math.ceil((e.lockedUntil - now) / 1000) : 0,
  }));
  return { total: lockouts.length, locked: lockouts.filter(l => l.locked).length, lockouts };
});

// POST /lockouts/:email/clear — manually clear a lockout (internal only)
fastify.post('/lockouts/:email/clear', async (req: FastifyRequest<{ Params: { email: string } }>, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) return reply.status(401).send({ error: 'Internal token required' });
  loginAttempts.delete(req.params.email);
  fastify.log.info({ email: req.params.email, requestId: req.id }, 'Lockout manually cleared');
  void emitEvent('auth.lockout_cleared', { email: req.params.email, clearedBy: 'admin' });
  return reply.send({ ok: true, email: req.params.email });
});

// POST /clients — register an OAuth2 client (admin only, internal)
fastify.post('/clients', async (req: FastifyRequest, reply: FastifyReply) => {
  // Must be called internally or with admin token
  const internalToken = req.headers[INTERNAL_HEADER] as string;
  const isInternal = verifyInternalToken(internalToken);
  if (!isInternal) {
    // Check admin bearer token
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return reply.status(401).send({ error: 'Unauthorized' });
    const tokenHash = hashToken(auth.slice(7));
    const tokenRow = await dbGetTokenByHash(tokenHash);
    if (!tokenRow) return reply.status(401).send({ error: 'Invalid token' });
    const scopes = tokenRow['scopes'] as OAuthScope[];
    if (!scopeAllows(scopes, 'admin:full')) return reply.status(403).send({ error: 'Requires admin:full scope' });
  }

  const parsed = ClientCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  }

  const clientSecret = generateToken(48);
  const clientSecretHash = hashToken(clientSecret);
  const validScopes = validateScopes(parsed.data.scopes);

  const client = await dbCreateClient({
    clientSecretHash,
    name: parsed.data.name,
    scopes: validScopes,
    redirectUris: parsed.data.redirectUris,
    grantTypes: parsed.data.grantTypes,
  });

  await emitEvent('auth.client_registered', { clientId: client['client_id'], name: parsed.data.name });

  return reply.status(201).send({
    clientId: client['client_id'],
    clientSecret,            // shown ONCE — not stored in plaintext
    name: client['name'],
    scopes: validScopes,
    grantTypes: parsed.data.grantTypes,
    createdAt: client['created_at'],
  });
});

// POST /token — OAuth2 token endpoint (client_credentials + refresh_token)
fastify.post('/token', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = TokenRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'invalid_request', issues: parsed.error.issues });
  }

  const clientRow = await dbGetClient(parsed.data.client_id);
  if (!clientRow) return reply.status(401).send({ error: 'invalid_client' });

  const secretHash = hashToken(parsed.data.client_secret);
  if (secretHash !== String(clientRow['client_secret_hash'])) {
    return reply.status(401).send({ error: 'invalid_client' });
  }

  if (parsed.data.grant_type === 'client_credentials') {
    const grantTypes = clientRow['grant_types'] as string[];
    if (!grantTypes.includes('client_credentials')) {
      return reply.status(400).send({ error: 'unauthorized_grant_type' });
    }

    const requestedScopes = parsed.data.scope?.split(' ') ?? [];
    const allowedScopes = clientRow['scopes'] as OAuthScope[];
    const grantedScopes = requestedScopes.length > 0
      ? validateScopes(requestedScopes).filter(s => allowedScopes.includes(s))
      : allowedScopes;

    const accessToken = generateToken();
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();

    await dbSaveToken({
      accessTokenHash: hashToken(accessToken),
      clientId: parsed.data.client_id,
      scopes: grantedScopes,
      expiresAt,
    });

    await emitEvent('auth.token_issued', {
      clientId: parsed.data.client_id,
      scopes: grantedScopes,
      type: 'client_credentials',
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: grantedScopes.join(' '),
    };
  }

  if (parsed.data.grant_type === 'refresh_token') {
    // lookup by refresh token hash — DB has this indexed
    const refreshHash = hashToken(parsed.data.refresh_token);
    const res = await internalFetch('module6-database', `/oauth-tokens/by-refresh-hash/${refreshHash}`, {}, 5_000);
    if (!res.ok) return reply.status(401).send({ error: 'invalid_grant' });
    const existing = await res.json() as Record<string, unknown>;

    // Revoke old token, issue new pair
    await dbRevokeToken(String(existing['token_id']));

    const newAccessToken = generateToken();
    const newRefreshToken = generateToken();
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();

    await dbSaveToken({
      accessTokenHash: hashToken(newAccessToken),
      refreshTokenHash: hashToken(newRefreshToken),
      clientId: String(existing['client_id']),
      userId: existing['user_id'] ?? null,
      scopes: existing['scopes'],
      expiresAt,
    });

    return {
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    };
  }
});

// POST /introspect — verify any token, check scope
fastify.post('/introspect', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = IntrospectSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ active: false, error: 'invalid_request' });

  const tokenHash = hashToken(parsed.data.token);
  const tokenRow = await dbGetTokenByHash(tokenHash);
  if (!tokenRow) return { active: false } satisfies TokenIntrospectResult;

  const scopes = tokenRow['scopes'] as OAuthScope[];
  const requiredScope = parsed.data.required_scope as OAuthScope | undefined;

  if (requiredScope && !scopeAllows(scopes, requiredScope)) {
    return reply.status(403).send({ active: true, error: 'insufficient_scope', required: requiredScope, granted: scopes });
  }

  const result: TokenIntrospectResult = {
    active: true,
    clientId: String(tokenRow['client_id']),
    userId: tokenRow['user_id'] ? String(tokenRow['user_id']) : undefined,
    scopes,
    expiresAt: String(tokenRow['expires_at']),
    role: tokenRow['role'] ? String(tokenRow['role']) : undefined,
  };
  return result;
});

// POST /revoke — revoke a token
fastify.post('/revoke', async (req: FastifyRequest, reply: FastifyReply) => {
  const body = req.body as Record<string, unknown>;
  const token = String(body['token'] ?? '');
  if (!token) return reply.status(400).send({ error: 'token required' });

  const tokenHash = hashToken(token);
  const tokenRow = await dbGetTokenByHash(tokenHash);
  if (!tokenRow) return { ok: true };

  await dbRevokeToken(String(tokenRow['token_id']));
  await emitEvent('auth.token_revoked', { tokenId: tokenRow['token_id'] });
  return { ok: true };
});

// GET /users — list all users (internal only)
fastify.get('/users', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
  const res = await internalFetch('module6-database', '/users', {}, 5_000);
  return reply.status(res.status).send(await res.json());
});

// PATCH /users/:userId/deactivate — deactivate a user account
fastify.patch('/users/:userId/deactivate', async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
  const res = await internalFetch('module6-database', `/users/${req.params.userId}/deactivate`, { method: 'PATCH' }, 5_000);
  if (!res.ok) return reply.status(res.status).send(await res.json());
  await emitEvent('auth.user_deactivated', { userId: req.params.userId });
  return { ok: true, userId: req.params.userId, deactivatedAt: getTodayISO() };
});

// PATCH /users/:userId/activate — reactivate a user account
fastify.patch('/users/:userId/activate', async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
  const res = await internalFetch('module6-database', `/users/${req.params.userId}/activate`, { method: 'PATCH' }, 5_000);
  if (!res.ok) return reply.status(res.status).send(await res.json());
  await emitEvent('auth.user_activated', { userId: req.params.userId });
  return { ok: true, userId: req.params.userId, activatedAt: getTodayISO() };
});

// GET /users/:email — get user by email (internal only)
fastify.get('/users/:email', async (req: FastifyRequest<{ Params: { email: string } }>, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
  const res = await internalFetch('module6-database', `/users/${encodeURIComponent(req.params.email)}`, {}, 5_000);
  if (!res.ok) return reply.status(res.status).send(await res.json());
  const user = await res.json() as Record<string, unknown>;
  // Never return password hash
  delete user['password_hash'];
  return user;
});

// POST /validate-scopes — check if a scope string is valid
fastify.post('/validate-scopes', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const scopeStr = String(b['scope'] ?? '');
  const requested = scopeStr.split(' ').filter(Boolean);
  const valid = validateScopes(requested);
  const invalid = requested.filter(s => !valid.includes(s as OAuthScope));
  return { valid, invalid, allValid: invalid.length === 0 };
});

// GET /metrics — auth service metrics
fastify.get('/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
  try {
    const [usersRes, tokensRes] = await Promise.allSettled([
      internalFetch('module6-database', '/users', {}, 5_000).then(r => r.json()),
      internalFetch('module6-database', '/oauth-tokens/stats', {}, 5_000).then(r => r.json()),
    ]);
    const users = usersRes.status === 'fulfilled' ? usersRes.value as unknown[] : [];
    const tokenStats = tokensRes.status === 'fulfilled' ? tokensRes.value : null;
    return {
      service: 'module7-auth',
      timestamp: getTodayISO(),
      uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
      users: { total: users.length, active: users.filter((u: Record<string, unknown>) => u['is_active']).length },
      tokens: tokenStats,
      ttl: { accessTokenSeconds: ACCESS_TOKEN_TTL_SECONDS, refreshTokenSeconds: REFRESH_TOKEN_TTL_SECONDS },
    };
  } catch (err) {
    return { service: 'module7-auth', error: String(err).slice(0, 200), timestamp: getTodayISO() };
  }
});

// POST /revoke-all/:userId — revoke all tokens for a user
fastify.post('/revoke-all/:userId', async (req: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
  const res = await internalFetch('module6-database', `/oauth-tokens/revoke-all/${req.params.userId}`, { method: 'POST' }, 5_000);
  await emitEvent('auth.tokens_revoked_all', { userId: req.params.userId });
  return reply.status(res.ok ? 200 : 500).send({ ok: res.ok, userId: req.params.userId, revokedAt: getTodayISO() });
});

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    await fastify.listen({ port: 3007, host: '0.0.0.0' });
    fastify.log.info('🔑 Auth Service online — port 3007');
    fastify.log.info(`📅 ${getTodayDate()} | Flows: client_credentials, refresh_token, login`);
    fastify.log.info(`🔐 Access TTL: ${ACCESS_TOKEN_TTL_SECONDS}s | Refresh TTL: ${REFRESH_TOKEN_TTL_SECONDS}s`);
  } catch (err) { fastify.log.error(err, 'Auth failed to start'); process.exit(1); }
};
start();

