'use strict';
/**
 * api/routes/bots.js — /api/bots/* endpoints
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, cache }  = require('../../infrastructure/db/database');
const { requireScope, requireAdmin, requireDryRunOff } = require('../../infrastructure/auth/auth');

const router = Router();

// ── Input validation helpers ─────────────────────────────────────────────────
const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TYPES = ['cross_exchange_arb','triangular_arb','cash_carry','dca','grid','trend_following','momentum_scalp'];

function validateUUID(id, label = 'id') {
  if (!UUID_RE.test(id)) throw Object.assign(new Error(`Invalid ${label} format`), { status: 400 });
}

function parseIntParam(val, name, { min = 1, max = 1000 } = {}) {
  const n = parseInt(val);
  if (isNaN(n) || n < min || n > max) throw Object.assign(new Error(`${name} must be integer between ${min} and ${max}`), { status: 400 });
  return n;
}

// ── GET /api/bots ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { active, type } = req.query;

  if (active !== undefined && !['true','false'].includes(active)) {
    return res.status(400).json({ error: 'active must be "true" or "false"' });
  }
  if (type && !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  const bots = await db.listBots({
    active: active !== undefined ? active === 'true' : undefined,
    type,
  });

  // Strip config.apiSecret etc before sending to client
  const safe = bots.map(b => ({
    ...b,
    config: sanitiseConfig(b.config),
  }));

  res.json({ bots: safe, total: safe.length });
});

// ── GET /api/bots/:id ─────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  validateUUID(req.params.id);
  const bot = await db.getBotById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json({ bot: { ...bot, config: sanitiseConfig(bot.config) } });
});

// ── GET /api/bots/:id/performance ─────────────────────────────────────────────
router.get('/:id/performance', async (req, res) => {
  validateUUID(req.params.id);
  const { id } = req.params;
  const days    = parseIntParam(req.query.days || '30', 'days', { min: 1, max: 365 });

  const [perfRes, histRes, openRes] = await Promise.all([
    db.query('SELECT * FROM bot_performance WHERE id = $1', [id]),
    db.getPerformanceHistory(id, days),
    db.getOpenPositions(id),
  ]);

  if (!perfRes.rows.length) return res.status(404).json({ error: 'Bot not found' });

  res.json({
    performance:     perfRes.rows[0],
    history:         histRes,
    openPositions:   openRes,
  });
});

// ── GET /api/bots/:id/state ───────────────────────────────────────────────────
router.get('/:id/state', async (req, res) => {
  validateUUID(req.params.id);
  const state = await db.getAllState(req.params.id);
  // Redact sensitive keys from state
  const safeState = Object.fromEntries(
    Object.entries(state).filter(([k]) => !k.includes('secret') && !k.includes('key'))
  );
  res.json({ state: safeState });
});

// ── POST /api/bots/:id/start ──────────────────────────────────────────────────
router.post('/:id/start', requireScope('write:bots'), async (req, res) => {
  validateUUID(req.params.id);
  const { id } = req.params;

  const bot = await db.getBotById(id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.is_active) return res.status(409).json({ error: 'Bot is already running' });

  await db.setBotActive(id, true);
  await cache.publish(`bot:${id}:control`, {
    action:      'start',
    initiatedBy: req.clientId,
    ts:          new Date().toISOString(),
  });

  res.json({ ok: true, message: `Start signal sent to bot ${id}`, botId: id });
});

// ── POST /api/bots/:id/stop ───────────────────────────────────────────────────
router.post('/:id/stop', requireScope('write:bots'), async (req, res) => {
  validateUUID(req.params.id);
  const { id } = req.params;

  const bot = await db.getBotById(id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (!bot.is_active) return res.status(409).json({ error: 'Bot is not running' });

  await db.setBotActive(id, false);
  await cache.publish(`bot:${id}:control`, {
    action:      'stop',
    initiatedBy: req.clientId,
    ts:          new Date().toISOString(),
  });

  res.json({ ok: true, message: `Stop signal sent to bot ${id}`, botId: id });
});

// ── PATCH /api/bots/:id/config ───────────────────────────────────────────────
router.patch('/:id/config', requireScope('write:bots'), requireAdmin, async (req, res) => {
  validateUUID(req.params.id);
  const { id }     = req.params;
  const { config } = req.body;

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'config must be a non-null object' });
  }

  const bot = await db.getBotById(id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.is_active) return res.status(409).json({ error: 'Cannot update config while bot is running. Stop the bot first.' });

  // Strip sensitive fields the caller might accidentally include
  const safe = sanitiseConfig(config);
  await db.query('UPDATE bots SET config = $2, updated_at = NOW() WHERE id = $1', [id, JSON.stringify(safe)]);

  res.json({ ok: true, config: safe });
});

// ── GET /api/bots/:id/orders ──────────────────────────────────────────────────
router.get('/:id/orders', async (req, res) => {
  validateUUID(req.params.id);
  const limit  = parseIntParam(req.query.limit || '100', 'limit', { min: 1, max: 500 });
  const status = req.query.status;
  const pair   = req.query.pair;

  const VALID_STATUSES = ['PENDING','OPEN','FILLED','PARTIAL','CANCELLED','FAILED','EXPIRED'];
  if (status && !VALID_STATUSES.includes(status.toUpperCase())) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const orders = await db.getOrdersByBot(req.params.id, { limit, status, pair });
  res.json({ orders, total: orders.length });
});

// ── GET /api/bots/:id/positions ───────────────────────────────────────────────
router.get('/:id/positions', async (req, res) => {
  validateUUID(req.params.id);
  const status = (req.query.status || 'OPEN').toUpperCase();
  const limit  = parseIntParam(req.query.limit || '100', 'limit', { min: 1, max: 500 });
  const since  = req.query.since ? new Date(req.query.since) : null;

  if (!['OPEN','CLOSED','LIQUIDATED','CANCELLED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (req.query.since && isNaN(since)) {
    return res.status(400).json({ error: 'since must be a valid ISO date' });
  }

  if (status === 'OPEN') {
    const positions = await db.getOpenPositions(req.params.id);
    return res.json({ positions, total: positions.length });
  }

  const positions = await db.getClosedPositions(req.params.id, { limit, since });
  res.json({ positions, total: positions.length });
});

// ── GET /api/bots/:id/logs ────────────────────────────────────────────────────
router.get('/:id/logs', requireScope('read:logs'), async (req, res) => {
  validateUUID(req.params.id);
  const level = req.query.level;
  const limit = parseIntParam(req.query.limit || '100', 'limit', { min: 1, max: 5000 });
  const since = req.query.since ? new Date(req.query.since) : null;

  const VALID_LEVELS = ['DEBUG','INFO','WARN','ERROR','FATAL'];
  if (level && !VALID_LEVELS.includes(level.toUpperCase())) {
    return res.status(400).json({ error: `level must be one of: ${VALID_LEVELS.join(', ')}` });
  }

  const logs = await db.getLogs(req.params.id, { level, limit, since });
  res.json({ logs, total: logs.length });
});

// ── GET /api/bots/:id/dca/summary ─────────────────────────────────────────────
router.get('/:id/dca/summary', async (req, res) => {
  validateUUID(req.params.id);
  const summaries = await db.getAllDCASummaries(req.params.id);
  res.json({ summary: summaries });
});

// ── GET /api/bots/:id/grid ────────────────────────────────────────────────────
router.get('/:id/grid', async (req, res) => {
  validateUUID(req.params.id);
  const levels = await db.getGridLevels(req.params.id);
  const totalFills  = levels.reduce((s, l) => s + parseInt(l.fills || 0), 0);
  const totalProfit = levels.reduce((s, l) => s + parseFloat(l.total_profit || 0), 0);
  res.json({ levels, stats: { totalFills, totalProfit } });
});

// ── GET /api/bots/:id/funding ─────────────────────────────────────────────────
router.get('/:id/funding', async (req, res) => {
  validateUUID(req.params.id);
  const res2 = await db.query(
    `SELECT
       COALESCE(SUM(payment_usdt) FILTER (WHERE is_received), 0) AS total_received,
       COALESCE(SUM(payment_usdt) FILTER (WHERE NOT is_received), 0) AS total_paid,
       COUNT(*) AS payment_count,
       MAX(paid_at) AS last_payment
     FROM funding_payments WHERE bot_id = $1`,
    [req.params.id]
  );
  res.json({ funding: res2.rows[0] });
});

// ── POST /api/bots (create) ───────────────────────────────────────────────────
router.post('/', requireScope('write:bots'), requireAdmin, async (req, res) => {
  const { name, botType, config = {}, dryRun = true, initialCapital = 0 } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'name must be at least 2 characters' });
  }
  if (!VALID_TYPES.includes(botType)) {
    return res.status(400).json({ error: `botType must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (typeof dryRun !== 'boolean') {
    return res.status(400).json({ error: 'dryRun must be boolean' });
  }
  if (initialCapital < 0) {
    return res.status(400).json({ error: 'initialCapital must be >= 0' });
  }

  const bot = await db.upsertBot({
    id: uuidv4(), name: name.trim(), botType,
    config: sanitiseConfig(config), dryRun, initialCapital,
  });

  res.status(201).json({ bot: { ...bot, config: sanitiseConfig(bot.config) } });
});

// ── DELETE /api/bots/:id ──────────────────────────────────────────────────────
router.delete('/:id', requireScope('write:bots'), requireAdmin, requireDryRunOff, async (req, res) => {
  validateUUID(req.params.id);
  const bot = await db.getBotById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  if (bot.is_active) return res.status(409).json({ error: 'Cannot delete a running bot. Stop it first.' });

  // Soft delete — mark inactive, don't drop rows (preserve trade history)
  await db.query(
    'UPDATE bots SET is_active = false, status = $2, updated_at = NOW() WHERE id = $1',
    [req.params.id, 'idle']
  );
  res.json({ ok: true, message: `Bot ${req.params.id} deactivated` });
});

// ── Utility ───────────────────────────────────────────────────────────────────
function sanitiseConfig(config = {}) {
  if (!config || typeof config !== 'object') return {};
  const sensitive = ['apiKey','apiSecret','privateKey','clientSecret','password','secret','token'];
  const out = JSON.parse(JSON.stringify(config));
  const redact = (obj) => {
    for (const k of Object.keys(obj)) {
      if (sensitive.some(s => k.toLowerCase().includes(s))) {
        obj[k] = '***';
      } else if (typeof obj[k] === 'object' && obj[k] !== null) {
        redact(obj[k]);
      }
    }
  };
  redact(out);
  return out;
}

module.exports = router;
