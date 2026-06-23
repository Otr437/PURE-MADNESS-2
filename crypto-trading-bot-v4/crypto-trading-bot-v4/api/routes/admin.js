'use strict';
/**
 * api/routes/admin.js
 * System stats, price feeds, RPC health, rate-limit admin, alerts.
 */

const { Router }  = require('express');
const { db, cache } = require('../../infrastructure/db/database');
const { tokenBucket, requireAdmin, requireScope } = require('../../infrastructure/auth/auth');
const { evmClient, solanaClient, priceFeed }      = require('../../infrastructure/rpc/rpc');

const router = Router();

// ── GET /api/stats — aggregate across all bots ───────────────────────────────
router.get('/stats', async (_req, res) => {
  const [botsRes, posRes, orderRes] = await Promise.all([
    db.query('SELECT * FROM bot_performance ORDER BY total_net_pnl DESC'),
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'OPEN')   AS open_positions,
        COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed_positions,
        COALESCE(SUM(net_pnl) FILTER (WHERE status = 'CLOSED'), 0) AS total_net_pnl
      FROM positions`),
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'FILLED') AS filled_orders,
        COUNT(*) FILTER (WHERE status = 'FAILED') AS failed_orders,
        COUNT(*) FILTER (WHERE placed_at >= CURRENT_DATE) AS today_orders
      FROM orders`),
  ]);

  const totals = botsRes.rows.reduce((acc, b) => ({
    totalPnl:    acc.totalPnl    + parseFloat(b.total_net_pnl || 0),
    totalTrades: acc.totalTrades + parseInt(b.total_positions || 0),
    totalWins:   acc.totalWins   + parseInt(b.wins || 0),
    activeBots:  acc.activeBots  + (b.is_active ? 1 : 0),
  }), { totalPnl: 0, totalTrades: 0, totalWins: 0, activeBots: 0 });

  res.json({
    bots:        botsRes.rows,
    totals,
    positions:   posRes.rows[0],
    orders:      orderRes.rows[0],
    ts:          new Date().toISOString(),
  });
});

// ── GET /api/price/:symbol ────────────────────────────────────────────────────
router.get('/price/:symbol', async (req, res) => {
  const symbol   = decodeURIComponent(req.params.symbol).toUpperCase();
  const VALID    = ['BTC/USD','ETH/USD','SOL/USD','BNB/USD'];
  if (!VALID.includes(symbol)) {
    return res.status(400).json({ error: `symbol must be one of: ${VALID.join(', ')}` });
  }

  const cacheKey = `price:${symbol}`;
  const cached   = await cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const result = await priceFeed.getAggregatedPrice(symbol);
  await cache.set(cacheKey, result, 30); // 30s TTL
  res.json({ ...result, cached: false });
});

// ── GET /api/rpc/status ───────────────────────────────────────────────────────
router.get('/rpc/status', requireAdmin, async (_req, res) => {
  const [evmRes, solRes] = await Promise.allSettled([
    evmClient.getBlockNumber(),
    solanaClient.getSlot(),
  ]);

  const evmOk  = evmRes.status  === 'fulfilled';
  const solOk  = solRes.status  === 'fulfilled';

  res.status(evmOk || solOk ? 200 : 503).json({
    evm: {
      ok:          evmOk,
      blockNumber: evmOk ? evmRes.value : null,
      error:       evmOk ? null : evmRes.reason?.message,
    },
    solana: {
      ok:    solOk,
      slot:  solOk ? solRes.value : null,
      error: solOk ? null : solRes.reason?.message,
    },
    ts: new Date().toISOString(),
  });
});

// ── GET /api/admin/rate-limit/:clientId ───────────────────────────────────────
router.get('/admin/rate-limit/:clientId', requireAdmin, async (req, res) => {
  const { clientId } = req.params;
  if (!clientId || clientId.length > 256) {
    return res.status(400).json({ error: 'Invalid clientId' });
  }
  const state = await tokenBucket.peek(clientId);
  res.json({ clientId, ...state, ts: new Date().toISOString() });
});

// ── DELETE /api/admin/rate-limit/:clientId ────────────────────────────────────
router.delete('/admin/rate-limit/:clientId', requireAdmin, async (req, res) => {
  const { clientId } = req.params;
  if (!clientId || clientId.length > 256) {
    return res.status(400).json({ error: 'Invalid clientId' });
  }
  await tokenBucket.reset(clientId);
  res.json({ ok: true, message: `Token bucket reset for client: ${clientId}` });
});

// ── GET /api/admin/alerts ─────────────────────────────────────────────────────
router.get('/admin/alerts', requireAdmin, async (req, res) => {
  const delivered = req.query.delivered === 'true';
  const limit     = Math.min(parseInt(req.query.limit || '50'), 500);

  const res2 = await db.query(
    `SELECT * FROM alerts WHERE delivered = $1 ORDER BY created_at DESC LIMIT $2`,
    [delivered, limit]
  );
  res.json({ alerts: res2.rows, total: res2.rows.length });
});

// ── POST /api/admin/alerts/:id/deliver ───────────────────────────────────────
router.post('/admin/alerts/:id/deliver', requireAdmin, async (req, res) => {
  const { id } = req.params;
  await db.markAlertDelivered(id);
  res.json({ ok: true });
});

// ── GET /api/admin/heartbeats ─────────────────────────────────────────────────
router.get('/admin/heartbeats', requireAdmin, async (_req, res) => {
  const res2 = await db.query(`
    SELECT
      id, name, bot_type, is_active,
      last_heartbeat,
      NOW() - last_heartbeat AS since_last_heartbeat,
      CASE WHEN last_heartbeat > NOW() - INTERVAL '2 minutes' THEN true ELSE false END AS healthy
    FROM bots
    WHERE is_active = true
    ORDER BY last_heartbeat DESC NULLS LAST
  `);
  res.json({ bots: res2.rows, ts: new Date().toISOString() });
});

// ── GET /api/admin/daily-pnl ──────────────────────────────────────────────────
router.get('/admin/daily-pnl', requireAdmin, async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30'), 365);
  const res2 = await db.query(
    `SELECT * FROM daily_pnl
     WHERE trade_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
     ORDER BY trade_date DESC`,
    [days]
  );
  res.json({ dailyPnl: res2.rows });
});

// ── GET /api/admin/open-risk ──────────────────────────────────────────────────
router.get('/admin/open-risk', requireAdmin, async (_req, res) => {
  const res2 = await db.query('SELECT * FROM open_position_risk ORDER BY notional_usdt DESC');
  const totalNotional = res2.rows.reduce((s, r) => s + parseFloat(r.notional_usdt || 0), 0);
  const totalMaxLoss  = res2.rows.reduce((s, r) => s + parseFloat(r.max_loss_usdt || 0), 0);
  res.json({
    positions:     res2.rows,
    summary:       { totalNotional, totalMaxLoss, count: res2.rows.length },
    ts:            new Date().toISOString(),
  });
});

// ── GET /api/admin/db-stats ───────────────────────────────────────────────────
router.get('/admin/db-stats', requireAdmin, async (_req, res) => {
  const res2 = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM bots)                  AS bots,
      (SELECT COUNT(*) FROM orders)                AS orders,
      (SELECT COUNT(*) FROM positions)             AS positions,
      (SELECT COUNT(*) FROM system_logs)           AS logs,
      (SELECT COUNT(*) FROM dca_purchases)         AS dca_purchases,
      (SELECT COUNT(*) FROM funding_payments)      AS funding_payments,
      (SELECT COUNT(*) FROM performance_snapshots) AS snapshots,
      pg_database_size(current_database())         AS db_size_bytes
  `);
  res.json({ stats: res2.rows[0], ts: new Date().toISOString() });
});

module.exports = router;

// ── GET /api/seasonal/patterns/:pair ─────────────────────────────────────────
router.get('/seasonal/patterns/:pair', async (req, res) => {
  const { pair }    = req.params;
  const interval    = req.query.interval || '1d';
  const VALID_INT   = ['1m','5m','15m','1h','4h','1d','1w'];
  if (!VALID_INT.includes(interval)) return res.status(400).json({ error: 'Invalid interval' });

  const [monthly, dows, spikeStats, currentBias, bestWindows, accumMonths] = await Promise.all([
    db.query(`SELECT * FROM seasonal_patterns WHERE pair=$1 AND interval=$2 AND month IS NOT NULL AND week_of_year IS NULL AND day_of_week IS NULL AND hour_of_day IS NULL ORDER BY month`, [pair.toUpperCase(), interval]),
    db.query(`SELECT * FROM seasonal_patterns WHERE pair=$1 AND interval=$2 AND day_of_week IS NOT NULL AND month IS NULL ORDER BY day_of_week`, [pair.toUpperCase(), interval]),
    db.query(`SELECT direction, COUNT(*) AS spikes, ROUND(AVG(ABS(pct_move)),3) AS avg_pct, ROUND(AVG(revert_24h_pct),3) AS avg_revert_24h FROM price_spikes WHERE pair=$1 AND interval=$2 GROUP BY direction`, [pair.toUpperCase(), interval]),
    db.query(`SELECT * FROM current_month_bias WHERE pair=$1 LIMIT 1`, [pair.toUpperCase()]),
    db.query(`SELECT * FROM best_seasonal_months WHERE pair=$1`, [pair.toUpperCase()]),
    db.query(`SELECT * FROM seasonal_patterns WHERE pair=$1 AND interval='1d' AND month IS NOT NULL AND avg_return_pct < 0 ORDER BY avg_return_pct ASC LIMIT 3`, [pair.toUpperCase()]),
  ]);

  res.json({
    pair:          pair.toUpperCase(),
    interval,
    currentBias:   currentBias.rows[0] ?? null,
    monthly:       monthly.rows,
    dayOfWeek:     dows.rows,
    spikeStats:    spikeStats.rows,
    bestBuyMonths: bestWindows.rows.filter(r => r.avg_return_pct > 0).slice(0, 3),
    worstMonths:   accumMonths.rows,
  });
});

// ── GET /api/seasonal/similarity/:pair ───────────────────────────────────────
router.get('/seasonal/similarity/:pair', async (req, res) => {
  const { cache } = require('../../infrastructure/db/database');
  const pair      = req.params.pair.toUpperCase();
  const sim       = await cache.get(`seasonal:path_similarity:${pair}`);
  if (!sim) return res.status(404).json({ error: 'No similarity data computed yet. Run data:ingest first.' });
  res.json(sim);
});

// ── GET /api/seasonal/spikes/:pair ────────────────────────────────────────────
router.get('/seasonal/spikes/:pair', async (req, res) => {
  const pair     = req.params.pair.toUpperCase();
  const month    = req.query.month ? parseInt(req.query.month) : null;
  const limit    = Math.min(parseInt(req.query.limit || '100'), 500);
  const params   = [pair];
  let   sql      = `SELECT * FROM price_spikes WHERE pair = $1`;
  if (month) { params.push(month); sql += ` AND month = $${params.length}`; }
  sql += ` ORDER BY spike_time DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  const res2 = await db.query(sql, params);
  res.json({ spikes: res2.rows, total: res2.rows.length });
});

// ── GET /api/seasonal/ingestion ───────────────────────────────────────────────
router.get('/seasonal/ingestion', requireAdmin, async (_req, res) => {
  const res2 = await db.query(`SELECT * FROM ingestion_log ORDER BY started_at DESC LIMIT 50`);
  res.json({ log: res2.rows });
});
