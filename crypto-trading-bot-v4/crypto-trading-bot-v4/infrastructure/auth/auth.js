'use strict';
/**
 * infrastructure/auth/auth.js
 * Auth0 M2M token manager + Redis-backed atomic token bucket + Express middleware.
 */

require('dotenv').config();
const axios      = require('axios');
const jwt        = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { getRedis, cache } = require('../db/database');

// ── VALIDATION ───────────────────────────────────────────────────────────────
const REQUIRED_ENV = ['AUTH0_DOMAIN','AUTH0_AUDIENCE','AUTH0_CLIENT_ID','AUTH0_CLIENT_SECRET','AUTH0_TOKEN_URL','AUTH0_JWKS_URI'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) console.warn(`[AUTH] WARNING: ${key} not set — auth will fail`);
}

// ── AUTH0 MANAGER ────────────────────────────────────────────────────────────
class Auth0Manager {
  constructor() {
    this.domain       = process.env.AUTH0_DOMAIN;
    this.audience     = process.env.AUTH0_AUDIENCE;
    this.clientId     = process.env.AUTH0_CLIENT_ID;
    this.clientSecret = process.env.AUTH0_CLIENT_SECRET;
    this.tokenUrl     = process.env.AUTH0_TOKEN_URL;
    this.algorithms   = (process.env.AUTH0_ALGORITHMS || 'RS256').split(',').map(s => s.trim());

    this._memToken      = null;
    this._memExpiresAt  = 0;
    this._fetchInFlight = null; // prevents stampede on concurrent requests

    this._jwks = jwksClient({
      jwksUri:          process.env.AUTH0_JWKS_URI,
      cache:            true,
      cacheMaxEntries:  10,
      cacheMaxAge:      600_000,   // 10 min
      rateLimit:        true,
      jwksRequestsPerMinute: 10,
      requestHeaders:   { 'User-Agent': 'crypto-trading-bot/2.0' },
    });
  }

  /**
   * Fetch a fresh M2M access token from Auth0.
   * Uses in-memory cache first, then Redis (shared across instances), then fetches.
   * Prevents stampede via in-flight promise dedup.
   */
  async getAccessToken() {
    const bufferMs = 120_000; // refresh 2 min before expiry

    // 1. In-memory (fastest)
    if (this._memToken && Date.now() < this._memExpiresAt - bufferMs) {
      return this._memToken;
    }

    // 2. Redis (shared across instances)
    const cached = await cache.get('auth0:m2m_token');
    if (cached?.token && Date.now() < cached.expiresAt - bufferMs) {
      this._memToken     = cached.token;
      this._memExpiresAt = cached.expiresAt;
      return this._memToken;
    }

    // 3. Fetch from Auth0 — deduplicate concurrent requests
    if (this._fetchInFlight) return this._fetchInFlight;

    this._fetchInFlight = (async () => {
      try {
        const res = await axios.post(
          this.tokenUrl,
          {
            grant_type:    'client_credentials',
            client_id:     this.clientId,
            client_secret: this.clientSecret,
            audience:      this.audience,
          },
          {
            timeout: 10_000,
            headers: { 'Content-Type': 'application/json' },
          }
        );

        if (!res.data?.access_token) throw new Error('Auth0 returned no access_token');

        const expiresAt = Date.now() + res.data.expires_in * 1000;
        this._memToken      = res.data.access_token;
        this._memExpiresAt  = expiresAt;

        // Persist in Redis for other instances (TTL = expires_in - 120s buffer)
        await cache.set('auth0:m2m_token', { token: this._memToken, expiresAt }, res.data.expires_in - 120);

        console.log(`[AUTH0] M2M token refreshed. Expires in ${res.data.expires_in}s`);
        return this._memToken;
      } finally {
        this._fetchInFlight = null;
      }
    })();

    return this._fetchInFlight;
  }

  /** Returns { Authorization: 'Bearer <token>' } for axios calls */
  async authHeader() {
    const token = await this.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * Verify an inbound JWT — signature, expiry, audience, issuer.
   * Returns the decoded payload or throws.
   */
  verifyToken(rawToken) {
    return new Promise((resolve, reject) => {
      if (!rawToken || typeof rawToken !== 'string') {
        return reject(new Error('Token must be a non-empty string'));
      }

      const getKey = (header, callback) => {
        if (!header.kid) return callback(new Error('Token header missing kid'));
        this._jwks.getSigningKey(header.kid, (err, key) => {
          if (err) return callback(err);
          callback(null, key.getPublicKey());
        });
      };

      jwt.verify(
        rawToken,
        getKey,
        {
          algorithms:    this.algorithms,
          audience:      this.audience,
          issuer:        `https://${this.domain}/`,
          clockTolerance: 30, // 30s clock skew tolerance
        },
        (err, decoded) => {
          if (err) return reject(err);
          resolve(decoded);
        }
      );
    });
  }

  /**
   * Check if a decoded token has a given scope.
   * Auth0 scopes are space-separated in the `scope` claim.
   */
  hasScope(decoded, scope) {
    const scopes = (decoded?.scope || '').split(' ').filter(Boolean);
    return scopes.includes(scope);
  }

  /**
   * Check if decoded token has a given role
   * (stored in custom claim set via Auth0 Action)
   */
  hasRole(decoded, role) {
    const roles = decoded?.['https://crypto-bot/roles'] || [];
    return Array.isArray(roles) && roles.includes(role);
  }

  extractBearer(authHeader) {
    if (!authHeader || typeof authHeader !== 'string') return null;
    if (!authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7).trim();
    return token.length > 0 ? token : null;
  }

  /** Invalidate cached token (e.g. on 401 from downstream) */
  async invalidateToken() {
    this._memToken     = null;
    this._memExpiresAt = 0;
    await cache.del('auth0:m2m_token');
    console.log('[AUTH0] M2M token invalidated');
  }
}

// ── TOKEN BUCKET (Redis, atomic Lua) ─────────────────────────────────────────
class TokenBucket {
  constructor({
    capacity       = parseInt(process.env.TOKEN_BUCKET_CAPACITY            || '100'),
    refillRate     = parseInt(process.env.TOKEN_BUCKET_REFILL_RATE         || '10'),
    refillInterval = parseInt(process.env.TOKEN_BUCKET_REFILL_INTERVAL_MS  || '1000'),
    keyPrefix      = 'tokenbucket',
  } = {}) {
    if (capacity <= 0)       throw new Error('TokenBucket: capacity must be > 0');
    if (refillRate <= 0)     throw new Error('TokenBucket: refillRate must be > 0');
    if (refillInterval <= 0) throw new Error('TokenBucket: refillInterval must be > 0');

    this.capacity       = capacity;
    this.refillRate     = refillRate;
    this.refillInterval = refillInterval;
    this.keyPrefix      = keyPrefix;

    // Lua script cached as a string — Redis will compile it once via EVALSHA
    this._lua = `
      local key             = KEYS[1]
      local now             = tonumber(ARGV[1])
      local capacity        = tonumber(ARGV[2])
      local refill_rate     = tonumber(ARGV[3])
      local refill_interval = tonumber(ARGV[4])
      local requested       = tonumber(ARGV[5])

      local data       = redis.call('HMGET', key, 'tokens', 'last_refill')
      local tokens     = tonumber(data[1]) or capacity
      local last_refill= tonumber(data[2]) or now

      local elapsed = now - last_refill
      local refills = math.floor(elapsed / refill_interval)
      if refills > 0 then
        tokens      = math.min(capacity, tokens + refills * refill_rate)
        last_refill = last_refill + refills * refill_interval
      end

      local allowed = 0
      if tokens >= requested then
        tokens  = tokens - requested
        allowed = 1
      end

      local ttl = math.ceil(capacity / refill_rate) * math.ceil(refill_interval / 1000) + 120
      redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
      redis.call('EXPIRE', key, ttl)

      return {allowed, tokens, last_refill}
    `;
  }

  _key(clientId) {
    // Sanitise clientId to prevent key injection
    const safe = String(clientId).replace(/[^a-zA-Z0-9@._|-]/g, '_').slice(0, 128);
    return `${this.keyPrefix}:${safe}`;
  }

  /**
   * Attempt to consume `tokens` from the bucket.
   * Returns { allowed, remaining, resetInMs, capacity }
   */
  async consume(clientId, tokens = 1) {
    if (!clientId) throw new Error('TokenBucket.consume: clientId required');
    if (tokens < 1) tokens = 1;

    const redis = getRedis();
    const key   = this._key(clientId);
    const now   = Date.now();

    let result;
    try {
      result = await redis.eval(
        this._lua, 1, key,
        now, this.capacity, this.refillRate, this.refillInterval, tokens
      );
    } catch (err) {
      // If Redis is down, fail open (allow) to avoid blocking the API
      console.error('[TOKEN BUCKET] Redis eval error — failing open:', err.message);
      return { allowed: true, remaining: this.capacity, resetInMs: this.refillInterval, capacity: this.capacity };
    }

    const allowed    = result[0] === 1;
    const remaining  = Math.max(0, result[1]);
    const lastRefill = result[2];
    const resetInMs  = Math.max(0, (lastRefill + this.refillInterval) - now);

    return { allowed, remaining, resetInMs, capacity: this.capacity };
  }

  async peek(clientId) {
    try {
      const data = await getRedis().hmget(this._key(clientId), 'tokens', 'last_refill');
      const tokens     = data[0] !== null ? parseInt(data[0]) : this.capacity;
      const lastRefill = data[1] !== null ? parseInt(data[1]) : Date.now();
      const elapsed    = Date.now() - lastRefill;
      const refills    = Math.floor(elapsed / this.refillInterval);
      const current    = Math.min(this.capacity, tokens + refills * this.refillRate);
      return { current, capacity: this.capacity, lastRefill };
    } catch (e) {
      return { current: this.capacity, capacity: this.capacity, lastRefill: Date.now() };
    }
  }

  async reset(clientId) {
    await getRedis().del(this._key(clientId));
  }

  async setCustomCapacity(clientId, capacity, ttlSeconds = 3600) {
    // Allow per-client override (e.g. premium clients get higher limits)
    await cache.set(`tokenbucket_cap:${clientId}`, capacity, ttlSeconds);
  }
}

// ── SINGLETONS ───────────────────────────────────────────────────────────────
const auth0Manager = new Auth0Manager();
const tokenBucket  = new TokenBucket();

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

/**
 * authMiddleware — verifies JWT, enforces token bucket, attaches req.user
 */
async function authMiddleware(req, res, next) {
  const raw = auth0Manager.extractBearer(req.headers.authorization);
  if (!raw) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header. Expected: Bearer <token>',
    });
  }

  let decoded;
  try {
    decoded = await auth0Manager.verifyToken(raw);
  } catch (err) {
    // Distinguish between expired and invalid
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error:   expired ? 'TokenExpired' : 'InvalidToken',
      message: expired ? 'Token has expired' : `Token validation failed: ${err.message}`,
    });
  }

  const clientId = decoded.sub || decoded.client_id;
  if (!clientId) {
    return res.status(401).json({ error: 'InvalidToken', message: 'Token missing sub/client_id claim' });
  }

  // Check per-client custom capacity override
  const customCap = await cache.get(`tokenbucket_cap:${clientId}`);
  const bucket    = customCap
    ? await new TokenBucket({ capacity: customCap, refillRate: tokenBucket.refillRate, refillInterval: tokenBucket.refillInterval }).consume(clientId, 1)
    : await tokenBucket.consume(clientId, 1);

  // Always set rate-limit headers
  res.set({
    'X-RateLimit-Limit':     bucket.capacity,
    'X-RateLimit-Remaining': bucket.remaining,
    'X-RateLimit-Reset':     Math.ceil(bucket.resetInMs / 1000),
    'X-RateLimit-Policy':    `${bucket.capacity};w=${Math.ceil(tokenBucket.refillInterval / 1000)}`,
  });

  if (!bucket.allowed) {
    return res.status(429).json({
      error:        'RateLimitExceeded',
      message:      'Too many requests. Try again after the reset window.',
      retryAfterMs: bucket.resetInMs,
    });
  }

  req.user     = decoded;
  req.clientId = clientId;
  req.isAdmin  = auth0Manager.hasRole(decoded, 'admin');
  next();
}

/**
 * requireScope — factory for scope-enforcement middleware
 * Usage: router.post('/start', requireScope('write:bots'), handler)
 */
function requireScope(...scopes) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const missing = scopes.filter(s => !auth0Manager.hasScope(req.user, s));
    if (missing.length) {
      return res.status(403).json({
        error:   'InsufficientScope',
        message: `Required scope(s): ${missing.join(', ')}`,
      });
    }
    next();
  };
}

/**
 * requireAdmin — only users with role 'admin' pass
 */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Forbidden', message: 'Admin access required' });
  }
  next();
}

/**
 * requireDryRunOff — prevents destructive actions while bot is in dry-run mode
 * Use on routes that modify live capital
 */
function requireDryRunOff(req, res, next) {
  if (process.env.DRY_RUN !== 'false') {
    return res.status(403).json({
      error:   'DryRunActive',
      message: 'This action is disabled while DRY_RUN=true. Set DRY_RUN=false to proceed.',
    });
  }
  next();
}

module.exports = {
  auth0Manager,
  tokenBucket,
  authMiddleware,
  requireScope,
  requireAdmin,
  requireDryRunOff,
};
