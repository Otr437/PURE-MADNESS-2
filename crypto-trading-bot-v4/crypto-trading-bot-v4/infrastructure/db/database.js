'use strict';
/**
 * infrastructure/db/database.js
 * PostgreSQL connection pool + Redis client + all query helpers.
 * Singleton pattern — one pool and one Redis client shared across the process.
 */

require('dotenv').config();
const { Pool }  = require('pg');
const Redis     = require('ioredis');

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const MAX_RETRIES      = 3;
const RETRY_DELAY_MS   = 500;
const QUERY_TIMEOUT_MS = 30000;
const LOG_SLOW_MS      = 500; // warn on queries slower than this

// ── POSTGRESQL ───────────────────────────────────────────────────────────────
let _pgPool = null;

function getPgPool() {
  if (_pgPool) return _pgPool;

  if (!process.env.POSTGRES_USER || !process.env.POSTGRES_PASSWORD) {
    throw new Error('[DB] POSTGRES_USER and POSTGRES_PASSWORD must be set');
  }

  _pgPool = new Pool({
    host:                    process.env.POSTGRES_HOST     || 'localhost',
    port:                    parseInt(process.env.POSTGRES_PORT || '5432'),
    database:                process.env.POSTGRES_DB       || 'crypto_bot',
    user:                    process.env.POSTGRES_USER,
    password:                process.env.POSTGRES_PASSWORD,
    ssl:                     process.env.POSTGRES_SSL === 'true'
                               ? { rejectUnauthorized: true }
                               : false,
    min:                     parseInt(process.env.POSTGRES_POOL_MIN  || '2'),
    max:                     parseInt(process.env.POSTGRES_POOL_MAX  || '20'),
    idleTimeoutMillis:       30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout:       QUERY_TIMEOUT_MS,
    application_name:        'crypto-trading-bot',
  });

  _pgPool.on('error',   (err, client) => {
    console.error('[DB] Idle client error:', err.message);
    // force-remove broken client from pool
    try { client.release(true); } catch (_) {}
  });
  _pgPool.on('connect', ()  => console.log('[DB] New client connected to PostgreSQL'));
  _pgPool.on('remove',  ()  => console.log('[DB] Client removed from pool'));

  return _pgPool;
}

// ── REDIS ─────────────────────────────────────────────────────────────────────
let _redis    = null;
let _redisSub = null;

const REDIS_OPTS = () => ({
  host:                 process.env.REDIS_HOST     || 'localhost',
  port:                 parseInt(process.env.REDIS_PORT || '6379'),
  password:             process.env.REDIS_PASSWORD || undefined,
  db:                   parseInt(process.env.REDIS_DB   || '0'),
  tls:                  process.env.REDIS_TLS === 'true' ? { rejectUnauthorized: true } : undefined,
  retryStrategy:        (times) => Math.min(times * 200, 5000),
  enableReadyCheck:     true,
  maxRetriesPerRequest: 3,
  connectTimeout:       10_000,
  commandTimeout:       5_000,
  lazyConnect:          false,
  keepAlive:            30000,
});

function getRedis() {
  if (_redis) return _redis;
  _redis = new Redis(REDIS_OPTS());
  _redis.on('error',        (e)  => console.error('[REDIS] Error:', e.message));
  _redis.on('connect',      ()   => console.log('[REDIS] Connected'));
  _redis.on('reconnecting', (ms) => console.warn(`[REDIS] Reconnecting in ${ms}ms`));
  _redis.on('ready',        ()   => console.log('[REDIS] Ready'));
  return _redis;
}

function getRedisSub() {
  if (_redisSub) return _redisSub;
  _redisSub = new Redis(REDIS_OPTS());
  _redisSub.on('error', (e) => console.error('[REDIS-SUB] Error:', e.message));
  return _redisSub;
}

// ── INTERNAL: retry wrapper ───────────────────────────────────────────────────
async function withRetry(fn, label = 'query') {
  let lastErr;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry constraint violations or syntax errors
      const code = err.code || '';
      if (['23000','23001','23502','23503','23505','23514','42601','42703'].includes(code)) throw err;
      if (i < MAX_RETRIES - 1) {
        console.warn(`[DB] ${label} failed (attempt ${i+1}/${MAX_RETRIES}): ${err.message}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ── QUERY HELPER ─────────────────────────────────────────────────────────────
async function rawQuery(sql, params = [], label = '') {
  const pool  = getPgPool();
  const start = Date.now();
  const res   = await withRetry(() => pool.query(sql, params), label || sql.slice(0, 40));
  const ms    = Date.now() - start;
  if (ms > LOG_SLOW_MS) {
    console.warn(`[DB] Slow query (${ms}ms): ${sql.slice(0, 80)}`);
  }
  return res;
}

// ── DB OBJECT ────────────────────────────────────────────────────────────────
const db = {
  // ── Raw query (all params are parameterised — no string interpolation) ────
  async query(sql, params = []) {
    return rawQuery(sql, params);
  },

  // ── Transactional block with automatic rollback ───────────────────────────
  async transaction(fn) {
    const pool   = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  // ── BOTS ─────────────────────────────────────────────────────────────────
  async upsertBot({ id, name, botType, config, dryRun, initialCapital = 0 }) {
    if (!id || !name || !botType) throw new Error('upsertBot: id, name, botType required');
    // Sanitise config — strip any sensitive keys before persisting
    const safeConfig = { ...config };
    for (const k of ['apiKey','apiSecret','privateKey','clientSecret']) delete safeConfig[k];

    const res = await db.query(
      `INSERT INTO bots (id, name, bot_type, config, dry_run, initial_capital_usdt, current_capital_usdt)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (id) DO UPDATE
         SET config     = EXCLUDED.config,
             dry_run    = EXCLUDED.dry_run,
             updated_at = NOW()
       RETURNING *`,
      [id, name.trim(), botType, JSON.stringify(safeConfig), dryRun, initialCapital]
    );
    return res.rows[0];
  },

  async setBotActive(botId, active) {
    if (!botId) throw new Error('setBotActive: botId required');
    await db.query(
      `UPDATE bots SET
         is_active  = $2,
         status     = $3,
         ${active ? 'started_at' : 'stopped_at'} = NOW(),
         updated_at = NOW()
       WHERE id = $1`,
      [botId, active, active ? 'running' : 'idle']
    );
  },

  async setBotError(botId, message) {
    await db.query(
      `UPDATE bots SET
         status = 'error', error_message = $2,
         consecutive_errors = consecutive_errors + 1,
         updated_at = NOW()
       WHERE id = $1`,
      [botId, message.slice(0, 2000)]
    );
  },

  async clearBotError(botId) {
    await db.query(
      `UPDATE bots SET
         status = 'running', error_message = NULL,
         consecutive_errors = 0, updated_at = NOW()
       WHERE id = $1`,
      [botId]
    );
  },

  async heartbeat(botId) {
    await db.query(
      `UPDATE bots SET last_heartbeat = NOW() WHERE id = $1`,
      [botId]
    );
  },

  async getBotById(botId) {
    const res = await db.query(`SELECT * FROM bots WHERE id = $1`, [botId]);
    return res.rows[0] ?? null;
  },

  async listBots({ active, type } = {}) {
    const conditions = [];
    const params     = [];
    if (active !== undefined) { params.push(active); conditions.push(`is_active = $${params.length}`); }
    if (type)                 { params.push(type);   conditions.push(`bot_type = $${params.length}`);  }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await db.query(`SELECT * FROM bots ${where} ORDER BY created_at DESC`, params);
    return res.rows;
  },

  // Check daily loss limit — returns true if limit breached
  async isDailyLossLimitBreached(botId) {
    const res = await db.query(
      `SELECT
         b.daily_loss_limit_usdt,
         COALESCE(SUM(p.net_pnl) FILTER (WHERE p.net_pnl < 0), 0) AS daily_loss
       FROM bots b
       LEFT JOIN positions p ON p.bot_id = b.id
         AND p.status = 'CLOSED'
         AND p.closed_at >= CURRENT_DATE
       WHERE b.id = $1
       GROUP BY b.daily_loss_limit_usdt`,
      [botId]
    );
    if (!res.rows[0]) return false;
    const { daily_loss_limit_usdt, daily_loss } = res.rows[0];
    if (!daily_loss_limit_usdt) return false;
    return Math.abs(parseFloat(daily_loss)) >= parseFloat(daily_loss_limit_usdt);
  },

  // ── BOT STATE ─────────────────────────────────────────────────────────────
  async setState(botId, key, value) {
    if (!botId || !key) throw new Error('setState: botId and key required');
    if (!/^[a-zA-Z0-9_:.-]+$/.test(key)) throw new Error(`setState: invalid key "${key}"`);
    await db.query(
      `INSERT INTO bot_state (bot_id, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (bot_id, key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = NOW()`,
      [botId, key, JSON.stringify(value)]
    );
  },

  async getState(botId, key) {
    const res = await db.query(
      `SELECT value FROM bot_state WHERE bot_id = $1 AND key = $2`,
      [botId, key]
    );
    return res.rows[0]?.value ?? null;
  },

  async getAllState(botId) {
    const res = await db.query(
      `SELECT key, value FROM bot_state WHERE bot_id = $1`,
      [botId]
    );
    return Object.fromEntries(res.rows.map(r => [r.key, r.value]));
  },

  async deleteState(botId, key) {
    await db.query(`DELETE FROM bot_state WHERE bot_id = $1 AND key = $2`, [botId, key]);
  },

  // ── ORDERS ───────────────────────────────────────────────────────────────
  async insertOrder({ botId, exchange, externalOrderId, pair, side, type, quantity, price, stopPrice, quoteQty, status, rawResponse }) {
    if (!exchange || !pair || !side || !type || !quantity) {
      throw new Error('insertOrder: exchange, pair, side, type, quantity required');
    }
    if (quantity <= 0) throw new Error('insertOrder: quantity must be > 0');

    const res = await db.query(
      `INSERT INTO orders
         (bot_id, exchange, external_order_id, pair, side, type,
          quantity, price, stop_price, quote_qty, status, raw_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [botId, exchange.toLowerCase(), externalOrderId, pair.toUpperCase(),
       side.toUpperCase(), type.toUpperCase(), quantity, price, stopPrice,
       quoteQty, status || 'PENDING', JSON.stringify(rawResponse)]
    );
    return res.rows[0];
  },

  async updateOrder(orderId, { executedQty, executedPrice, feeAmount, feeAsset, slippagePct, status, filledAt, errorMessage }) {
    if (!orderId) throw new Error('updateOrder: orderId required');
    const validStatuses = ['PENDING','OPEN','FILLED','PARTIAL','CANCELLED','FAILED','EXPIRED'];
    if (status && !validStatuses.includes(status)) throw new Error(`updateOrder: invalid status ${status}`);

    await db.query(
      `UPDATE orders SET
         executed_qty    = COALESCE($2, executed_qty),
         executed_price  = COALESCE($3, executed_price),
         fee_amount      = COALESCE($4, fee_amount),
         fee_asset       = COALESCE($5, fee_asset),
         slippage_pct    = COALESCE($6, slippage_pct),
         status          = COALESCE($7, status),
         filled_at       = CASE WHEN $7 = 'FILLED' THEN COALESCE($8, NOW()) ELSE filled_at END,
         cancelled_at    = CASE WHEN $7 = 'CANCELLED' THEN NOW() ELSE cancelled_at END,
         error_message   = COALESCE($9, error_message)
       WHERE id = $1`,
      [orderId, executedQty, executedPrice, feeAmount, feeAsset, slippagePct,
       status, filledAt, errorMessage]
    );
  },

  async getOrdersByBot(botId, { limit = 100, status, pair } = {}) {
    const params = [botId, Math.min(limit, 1000)];
    const conditions = ['bot_id = $1'];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (pair)   { params.push(pair.toUpperCase()); conditions.push(`pair = $${params.length}`); }
    const res = await db.query(
      `SELECT * FROM orders WHERE ${conditions.join(' AND ')} ORDER BY placed_at DESC LIMIT $2`,
      params
    );
    return res.rows;
  },

  async getOrderByExternalId(exchange, externalOrderId) {
    const res = await db.query(
      `SELECT * FROM orders WHERE exchange = $1 AND external_order_id = $2`,
      [exchange.toLowerCase(), externalOrderId]
    );
    return res.rows[0] ?? null;
  },

  // ── POSITIONS ─────────────────────────────────────────────────────────────
  async openPosition({ botId, pair, side, quantity, entryPrice, stopLossPrice, takeProfitPrice, entryOrderId, metadata }) {
    if (!pair || !side || !quantity || !entryPrice) {
      throw new Error('openPosition: pair, side, quantity, entryPrice required');
    }
    if (quantity <= 0)   throw new Error('openPosition: quantity must be > 0');
    if (entryPrice <= 0) throw new Error('openPosition: entryPrice must be > 0');

    // Enforce max_position_usdt if set
    const notional = quantity * entryPrice;
    const bot = await db.getBotById(botId);
    if (bot?.max_position_usdt && notional > parseFloat(bot.max_position_usdt)) {
      throw new Error(`openPosition: notional $${notional.toFixed(2)} exceeds max_position_usdt $${bot.max_position_usdt}`);
    }

    // Check daily loss limit
    if (await db.isDailyLossLimitBreached(botId)) {
      throw new Error('openPosition: daily loss limit breached — no new positions allowed today');
    }

    const res = await db.query(
      `INSERT INTO positions
         (bot_id, pair, side, quantity, entry_price,
          stop_loss_price, take_profit_price, entry_order_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [botId, pair.toUpperCase(), side.toUpperCase(), quantity, entryPrice,
       stopLossPrice, takeProfitPrice, entryOrderId, JSON.stringify(metadata || {})]
    );
    return res.rows[0];
  },

  async closePosition(positionId, { exitPrice, exitOrderId, realizedPnl, feeTotal, netPnl }) {
    if (!positionId || !exitPrice) throw new Error('closePosition: positionId and exitPrice required');
    if (exitPrice <= 0) throw new Error('closePosition: exitPrice must be > 0');

    // Verify position is actually open before closing (prevents double-close at app layer too)
    const existing = await db.query(
      `SELECT id, status FROM positions WHERE id = $1 FOR UPDATE`,
      [positionId]
    );
    if (!existing.rows[0]) throw new Error(`closePosition: position ${positionId} not found`);
    if (existing.rows[0].status === 'CLOSED') throw new Error(`closePosition: position ${positionId} already closed`);

    await db.query(
      `UPDATE positions SET
         status         = 'CLOSED',
         exit_price     = $2,
         exit_order_id  = $3,
         realized_pnl   = $4,
         fee_total      = $5,
         net_pnl        = $6,
         closed_at      = NOW()
       WHERE id = $1`,
      [positionId, exitPrice, exitOrderId, realizedPnl, feeTotal, netPnl]
    );
  },

  async updateUnrealizedPnl(positionId, unrealizedPnl, currentPrice) {
    await db.query(
      `UPDATE positions SET
         unrealized_pnl       = $2,
         max_adverse_price    = CASE WHEN $3 < COALESCE(max_adverse_price, $3) THEN $3 ELSE max_adverse_price END,
         max_favourable_price = CASE WHEN $3 > COALESCE(max_favourable_price, $3) THEN $3 ELSE max_favourable_price END
       WHERE id = $1 AND status = 'OPEN'`,
      [positionId, unrealizedPnl, currentPrice]
    );
  },

  async getOpenPositions(botId) {
    const res = await db.query(
      `SELECT * FROM positions WHERE bot_id = $1 AND status = 'OPEN' ORDER BY opened_at`,
      [botId]
    );
    return res.rows;
  },

  async getPositionById(positionId) {
    const res = await db.query(`SELECT * FROM positions WHERE id = $1`, [positionId]);
    return res.rows[0] ?? null;
  },

  async getClosedPositions(botId, { limit = 100, since } = {}) {
    const params = [botId, Math.min(limit, 1000)];
    let sql = `SELECT * FROM positions WHERE bot_id = $1 AND status = 'CLOSED'`;
    if (since) { params.push(since); sql += ` AND closed_at >= $${params.length}`; }
    sql += ` ORDER BY closed_at DESC LIMIT $2`;
    const res = await db.query(sql, params);
    return res.rows;
  },

  // ── DCA PURCHASES ─────────────────────────────────────────────────────────
  async insertDCAPurchase({ botId, asset, pair, quantity, priceUsdt, costUsdt, multiplier, smaAtPurchase, orderId }) {
    if (quantity <= 0 || priceUsdt <= 0 || costUsdt <= 0) {
      throw new Error('insertDCAPurchase: quantity, priceUsdt, costUsdt must be > 0');
    }
    const pctBelowSma = smaAtPurchase
      ? ((smaAtPurchase - priceUsdt) / smaAtPurchase) * 100
      : null;

    const res = await db.query(
      `INSERT INTO dca_purchases
         (bot_id, asset, pair, quantity, price_usdt, cost_usdt, multiplier, sma_at_purchase, pct_below_sma, order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [botId, asset.toUpperCase(), pair.toUpperCase(), quantity, priceUsdt,
       costUsdt, multiplier, smaAtPurchase, pctBelowSma, orderId]
    );
    return res.rows[0];
  },

  async getDCASummary(botId, asset) {
    const res = await db.query(
      `SELECT
         asset,
         COUNT(*)                                              AS purchase_count,
         SUM(quantity)                                         AS total_qty,
         SUM(cost_usdt)                                        AS total_cost,
         SUM(cost_usdt) / NULLIF(SUM(quantity), 0)            AS avg_cost_basis,
         MIN(price_usdt)                                       AS lowest_price,
         MAX(price_usdt)                                       AS highest_price,
         MAX(purchased_at)                                     AS last_purchase_at
       FROM dca_purchases
       WHERE bot_id = $1 AND asset = $2
       GROUP BY asset`,
      [botId, asset.toUpperCase()]
    );
    return res.rows[0] ?? null;
  },

  async getAllDCASummaries(botId) {
    const res = await db.query(
      `SELECT
         asset,
         COUNT(*)                                     AS purchase_count,
         SUM(quantity)                                AS total_qty,
         SUM(cost_usdt)                               AS total_cost,
         SUM(cost_usdt) / NULLIF(SUM(quantity), 0)   AS avg_cost_basis,
         MAX(purchased_at)                            AS last_purchase_at
       FROM dca_purchases WHERE bot_id = $1 GROUP BY asset`,
      [botId]
    );
    return res.rows;
  },

  // ── GRID LEVELS ───────────────────────────────────────────────────────────
  async upsertGridLevel({ botId, levelIndex, price, side, orderId }) {
    if (price <= 0) throw new Error('upsertGridLevel: price must be > 0');
    await db.query(
      `INSERT INTO grid_levels (bot_id, level_index, price, side, order_id, updated_at)
       VALUES ($1,$2,$3,$4,$5, NOW())
       ON CONFLICT (bot_id, level_index) DO UPDATE
         SET order_id       = EXCLUDED.order_id,
             side           = EXCLUDED.side,
             is_active      = true,
             fills          = grid_levels.fills + 1,
             last_filled_at = NOW(),
             updated_at     = NOW()`,
      [botId, levelIndex, price, side.toUpperCase(), orderId]
    );
  },

  async recordGridProfit(botId, levelIndex, profitUsdt) {
    await db.query(
      `UPDATE grid_levels SET total_profit = total_profit + $3, updated_at = NOW()
       WHERE bot_id = $1 AND level_index = $2`,
      [botId, levelIndex, profitUsdt]
    );
  },

  async getGridLevels(botId) {
    const res = await db.query(
      `SELECT * FROM grid_levels WHERE bot_id = $1 AND is_active = true ORDER BY level_index`,
      [botId]
    );
    return res.rows;
  },

  async deactivateGridLevels(botId) {
    await db.query(
      `UPDATE grid_levels SET is_active = false, updated_at = NOW() WHERE bot_id = $1`,
      [botId]
    );
  },

  // ── FUNDING PAYMENTS ──────────────────────────────────────────────────────
  async insertFundingPayment({ botId, positionId, symbol, fundingRate, paymentUsdt, isReceived = true }) {
    await db.query(
      `INSERT INTO funding_payments (bot_id, position_id, symbol, funding_rate, payment_usdt, is_received)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [botId, positionId, symbol.toUpperCase(), fundingRate, paymentUsdt, isReceived]
    );
  },

  async getTotalFundingForPosition(positionId) {
    const res = await db.query(
      `SELECT
         COALESCE(SUM(payment_usdt) FILTER (WHERE is_received), 0)  AS received,
         COALESCE(SUM(payment_usdt) FILTER (WHERE NOT is_received), 0) AS paid,
         COALESCE(SUM(CASE WHEN is_received THEN payment_usdt ELSE -payment_usdt END), 0) AS net
       FROM funding_payments WHERE position_id = $1`,
      [positionId]
    );
    return res.rows[0];
  },

  // ── PERFORMANCE SNAPSHOTS ─────────────────────────────────────────────────
  async upsertPerformanceSnapshot({ botId, date, totalTrades, winningTrades, losingTrades, grossPnl, totalFees, netPnl, maxDrawdown, capitalStart, capitalEnd }) {
    await db.query(
      `INSERT INTO performance_snapshots
         (bot_id, snapshot_date, total_trades, winning_trades, losing_trades,
          gross_pnl, total_fees, net_pnl, max_drawdown, capital_start, capital_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (bot_id, snapshot_date) DO UPDATE SET
         total_trades    = EXCLUDED.total_trades,
         winning_trades  = EXCLUDED.winning_trades,
         losing_trades   = EXCLUDED.losing_trades,
         gross_pnl       = EXCLUDED.gross_pnl,
         total_fees      = EXCLUDED.total_fees,
         net_pnl         = EXCLUDED.net_pnl,
         max_drawdown    = EXCLUDED.max_drawdown,
         capital_start   = COALESCE(performance_snapshots.capital_start, EXCLUDED.capital_start),
         capital_end     = EXCLUDED.capital_end`,
      [botId, date, totalTrades, winningTrades, losingTrades,
       grossPnl, totalFees, netPnl, maxDrawdown, capitalStart, capitalEnd]
    );
  },

  async getPerformanceHistory(botId, days = 30) {
    const res = await db.query(
      `SELECT * FROM performance_snapshots
       WHERE bot_id = $1 AND snapshot_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
       ORDER BY snapshot_date DESC`,
      [botId, days]
    );
    return res.rows;
  },

  // ── ALERTS ────────────────────────────────────────────────────────────────
  async insertAlert({ botId, type, message, context }) {
    const res = await db.query(
      `INSERT INTO alerts (bot_id, type, message, context)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [botId, type, message.slice(0, 2000), JSON.stringify(context || {})]
    );
    return res.rows[0].id;
  },

  async markAlertDelivered(alertId) {
    await db.query(
      `UPDATE alerts SET delivered = true, delivered_at = NOW() WHERE id = $1`,
      [alertId]
    );
  },

  async getPendingAlerts(limit = 50) {
    const res = await db.query(
      `SELECT * FROM alerts WHERE delivered = false ORDER BY created_at ASC LIMIT $1`,
      [limit]
    );
    return res.rows;
  },

  // ── LOGS ──────────────────────────────────────────────────────────────────
  async log(botId, level, message, context = {}) {
    // Truncate to prevent runaway log sizes
    const safeMsg = String(message).slice(0, 4000);
    const safeCtx = JSON.stringify(context).slice(0, 8000);

    await rawQuery(
      `INSERT INTO system_logs (bot_id, level, message, context) VALUES ($1,$2,$3,$4)`,
      [botId, level.toUpperCase(), safeMsg, safeCtx]
    ).catch(e => console.error('[DB LOG ERROR]', e.message)); // never throw on log failure
  },

  async getLogs(botId, { level, limit = 100, since } = {}) {
    const params = [botId, Math.min(limit, 5000)];
    let sql = `SELECT * FROM system_logs WHERE bot_id = $1`;
    const levels = ['DEBUG','INFO','WARN','ERROR','FATAL'];
    if (level) {
      const idx = levels.indexOf(level.toUpperCase());
      if (idx > -1) {
        const allowed = levels.slice(idx);
        sql += ` AND level = ANY($${params.length + 1}::log_level[])`;
        params.push(allowed);
      }
    }
    if (since) { params.push(since); sql += ` AND logged_at >= $${params.length}`; }
    sql += ` ORDER BY logged_at DESC LIMIT $2`;
    const res = await rawQuery(sql, params);
    return res.rows;
  },
};

// ── REDIS CACHE HELPERS ───────────────────────────────────────────────────────
const cache = {
  async get(key) {
    try {
      const val = await getRedis().get(key);
      return val ? JSON.parse(val) : null;
    } catch (e) {
      console.error('[CACHE] get error:', e.message);
      return null;
    }
  },

  async set(key, value, ttlSeconds = null) {
    try {
      const r   = getRedis();
      const str = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await r.setex(key, ttlSeconds, str);
      } else {
        await r.set(key, str);
      }
    } catch (e) {
      console.error('[CACHE] set error:', e.message);
    }
  },

  async del(...keys) {
    if (!keys.length) return;
    try { await getRedis().del(...keys); }
    catch (e) { console.error('[CACHE] del error:', e.message); }
  },

  async exists(key) {
    try { return (await getRedis().exists(key)) === 1; }
    catch (e) { return false; }
  },

  async incr(key, ttlSeconds = null) {
    const r   = getRedis();
    const val = await r.incr(key);
    if (ttlSeconds && val === 1) await r.expire(key, ttlSeconds);
    return val;
  },

  async publish(channel, message) {
    try { await getRedis().publish(channel, JSON.stringify(message)); }
    catch (e) { console.error('[CACHE] publish error:', e.message); }
  },

  async subscribe(channel, handler) {
    const sub = getRedisSub();
    await sub.subscribe(channel);
    sub.on('message', (ch, msg) => {
      if (ch !== channel) return;
      try { handler(JSON.parse(msg)); }
      catch (e) { console.error('[CACHE] subscribe handler error:', e.message); }
    });
    return () => sub.unsubscribe(channel); // return unsubscribe fn
  },

  async hset(key, field, value) {
    try { await getRedis().hset(key, field, JSON.stringify(value)); }
    catch (e) { console.error('[CACHE] hset error:', e.message); }
  },

  async hget(key, field) {
    try {
      const val = await getRedis().hget(key, field);
      return val ? JSON.parse(val) : null;
    } catch (e) { return null; }
  },

  async hgetall(key) {
    try {
      const data = await getRedis().hgetall(key);
      if (!data) return null;
      return Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, JSON.parse(v)])
      );
    } catch (e) { return null; }
  },

  async hdel(key, ...fields) {
    try { await getRedis().hdel(key, ...fields); }
    catch (e) { console.error('[CACHE] hdel error:', e.message); }
  },

  // Atomic lock using SET NX EX
  async acquireLock(key, ttlSeconds = 30) {
    const token = `${Date.now()}-${Math.random()}`;
    const ok    = await getRedis().set(`lock:${key}`, token, 'EX', ttlSeconds, 'NX');
    return ok === 'OK' ? token : null;
  },

  async releaseLock(key, token) {
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await getRedis().eval(lua, 1, `lock:${key}`, token);
  },
};

// ── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
async function closeAll() {
  const errs = [];
  if (_pgPool)   { try { await _pgPool.end();          } catch (e) { errs.push(e); } _pgPool   = null; }
  if (_redis)    { try { await _redis.quit();           } catch (e) { errs.push(e); } _redis    = null; }
  if (_redisSub) { try { await _redisSub.quit();        } catch (e) { errs.push(e); } _redisSub = null; }
  if (errs.length) console.error('[DB] Errors during closeAll:', errs.map(e => e.message));
}

module.exports = { db, cache, getPgPool, getRedis, getRedisSub, closeAll };
