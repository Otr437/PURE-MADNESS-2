'use strict';
/**
 * src/bots/base_bot.js
 * BaseBot — extended by all 7 strategy bots.
 * Provides: DB persistence, Auth0, EVM/Solana RPC, logging, alerts,
 *           heartbeat, performance snapshots, Redis pub/sub control,
 *           drawdown enforcement, daily loss limit, graceful shutdown.
 */

require('dotenv').config();
const { EventEmitter } = require('events');
const { v4: uuidv4 }   = require('uuid');
const { db, cache }    = require('../../infrastructure/db/database');
const { auth0Manager } = require('../../infrastructure/auth/auth');
const { evmClient, solanaClient, priceFeed } = require('../../infrastructure/rpc/rpc');
const { createLogger } = require('../../infrastructure/logger/logger');

class BaseBot extends EventEmitter {
  /**
   * @param {object} config
   * @param {string}  config.name                  Human-readable name
   * @param {string}  config.botType               Must match bot_type enum
   * @param {boolean} config.dryRun                Never execute real orders if true
   * @param {number}  [config.initialCapital]      Starting capital in USDT
   * @param {number}  [config.maxPositionUsdt]     Max single position size
   * @param {number}  [config.dailyLossLimitUsdt]  Stop trading if daily loss exceeds this
   * @param {number}  [config.globalStopLossPct]   Kill bot if drawdown exceeds this %
   */
  constructor(config) {
    super();
    this._validateConfig(config);

    this.config   = config;
    this.botId    = config.id || uuidv4();
    this.running  = false;
    this.stopping = false;

    this.log       = createLogger(this.botId, config.name);
    this.db        = db;
    this.cache     = cache;
    this.auth0     = auth0Manager;
    this.evm       = evmClient;
    this.solana    = solanaClient;
    this.priceFeed = priceFeed;

    // Intervals & subscriptions
    this._heartbeatTimer  = null;
    this._snapshotTimer   = null;
    this._unsubControl    = null;

    // Runtime stats — subclasses add strategy-specific fields
    this.stats = {
      trades:        0,
      wins:          0,
      losses:        0,
      totalPnlUSDT:  0,
      totalFeesUSDT: 0,
      startedAt:     null,
    };

    // Open position cache (populated from DB on restore)
    this._openPositions = new Map(); // positionId → row
  }

  // ── CONFIG VALIDATION ──────────────────────────────────────────────────────
  _validateConfig(config) {
    if (!config.name    || typeof config.name !== 'string')    throw new Error('BaseBot: config.name required');
    if (!config.botType || typeof config.botType !== 'string') throw new Error('BaseBot: config.botType required');
    if (typeof config.dryRun !== 'boolean') throw new Error('BaseBot: config.dryRun must be boolean');

    const validTypes = ['cross_exchange_arb','triangular_arb','cash_carry','dca','grid','trend_following','momentum_scalp'];
    if (!validTypes.includes(config.botType)) {
      throw new Error(`BaseBot: invalid botType "${config.botType}". Valid: ${validTypes.join(', ')}`);
    }
    if (config.globalStopLossPct !== undefined && (config.globalStopLossPct < 0 || config.globalStopLossPct > 100)) {
      throw new Error('BaseBot: globalStopLossPct must be between 0 and 100');
    }
  }

  // ── LIFECYCLE ─────────────────────────────────────────────────────────────
  async start() {
    if (this.running) throw new Error(`${this.config.name}: already running`);

    this.stats.startedAt = new Date().toISOString();
    this.running  = true;
    this.stopping = false;

    // Register in DB
    await this.db.upsertBot({
      id:              this.botId,
      name:            this.config.name,
      botType:         this.config.botType,
      config:          this.config,
      dryRun:          this.config.dryRun,
      initialCapital:  this.config.initialCapital || 0,
    });

    // Restore persisted state
    const savedState = await this.db.getAllState(this.botId);
    if (savedState && Object.keys(savedState).length) {
      this.log.info('Restoring persisted state', { keys: Object.keys(savedState) });
      await this.onRestoreState(savedState).catch(err =>
        this.log.warn('State restore failed', { error: err.message })
      );
    }

    // Restore open positions
    const openPositions = await this.db.getOpenPositions(this.botId);
    for (const pos of openPositions) this._openPositions.set(pos.id, pos);
    if (openPositions.length) this.log.info('Restored open positions', { count: openPositions.length });

    // Mark active in DB
    await this.db.setBotActive(this.botId, true);
    await this.db.clearBotError(this.botId).catch(() => {});

    // Start background tasks
    this._startHeartbeat();
    this._startSnapshotSchedule();
    await this._subscribeControlChannel();

    await this.log.alertStartup(this.config);
    this.emit('start');
    this.log.info(`Bot started (dryRun=${this.config.dryRun})`);

    try {
      await this.run();
    } catch (err) {
      this.log.fatal('Bot run() threw unhandled error', { error: err.message, stack: err.stack });
      await this.db.setBotError(this.botId, err.message).catch(() => {});
      await this.log.alertFatal(`Bot crashed: ${err.message}`);
    } finally {
      await this._shutdown();
    }
  }

  async stop() {
    if (!this.running || this.stopping) return;
    this.stopping = true;
    this.log.info('Stop requested');
  }

  async _shutdown() {
    this.running  = false;
    this.stopping = false;

    clearInterval(this._heartbeatTimer);
    clearInterval(this._snapshotTimer);
    if (this._unsubControl) this._unsubControl();

    await this.db.setBotActive(this.botId, false).catch(() => {});
    await this._saveSnapshot().catch(err => this.log.warn('Final snapshot failed', { error: err.message }));
    await this.log.alertShutdown(this.stats);
    this.emit('stop', this.stats);
    this.log.info('Bot shut down cleanly', this.stats);
  }

  // ── ABSTRACT — IMPLEMENT IN SUBCLASS ─────────────────────────────────────
  async run()                  { throw new Error('BaseBot.run() not implemented'); }
  async onRestoreState(_state) { /* optional override */ }

  // ── RISK GUARDS ───────────────────────────────────────────────────────────

  /**
   * Call at the top of every tick. Returns false if the bot must halt.
   */
  async riskCheck() {
    // Global drawdown limit
    if (this.config.globalStopLossPct) {
      const bot = await this.db.getBotById(this.botId);
      if (bot && parseFloat(bot.max_drawdown_pct) >= this.config.globalStopLossPct) {
        this.log.error('Global stop-loss triggered', {
          drawdown: bot.max_drawdown_pct,
          limit: this.config.globalStopLossPct,
        });
        await this.log.alertDrawdown({
          drawdownPct:    parseFloat(bot.max_drawdown_pct),
          currentCapital: parseFloat(bot.current_capital_usdt),
        });
        await this.stop();
        return false;
      }
    }

    // Daily loss limit
    if (await this.db.isDailyLossLimitBreached(this.botId)) {
      this.log.error('Daily loss limit breached — halting new positions for today');
      await this.stop();
      return false;
    }

    return true;
  }

  // ── ORDER HELPERS ─────────────────────────────────────────────────────────

  /**
   * Place an order: logs to DB before and after execution.
   * @param {object} opts
   * @param {string}   opts.exchange
   * @param {string}   opts.pair
   * @param {string}   opts.side       BUY | SELL
   * @param {string}   opts.type       MARKET | LIMIT | ...
   * @param {number}   opts.quantity
   * @param {number}   [opts.price]
   * @param {number}   [opts.quoteQty]
   * @param {Function} opts.execute    async fn → exchange response
   */
  async placeOrder({ exchange, pair, side, type, quantity, price, stopPrice, quoteQty, execute }) {
    if (!exchange || !pair || !side || !type || !execute) {
      throw new Error('placeOrder: exchange, pair, side, type, execute are required');
    }
    if (quantity <= 0 && !quoteQty) throw new Error('placeOrder: quantity or quoteQty must be > 0');

    // In dry-run, execute but still write order record
    const orderRecord = await this.db.insertOrder({
      botId: this.botId, exchange, pair,
      side: side.toUpperCase(), type: type.toUpperCase(),
      quantity, price, stopPrice, quoteQty, status: 'PENDING',
    });

    let response;
    const t0 = Date.now();
    try {
      response = await execute();
    } catch (err) {
      await this.db.updateOrder(orderRecord.id, {
        status:       'FAILED',
        errorMessage: err.message.slice(0, 500),
      }).catch(() => {});
      this.log.error('Order execution failed', { pair, side, type, error: err.message });
      throw err;
    }

    const execMs = Date.now() - t0;
    const execQty   = response.executedQty   ? parseFloat(response.executedQty)   : quantity;
    const execPrice = response.executedPrice ? parseFloat(response.executedPrice) : price;
    const slippage  = price && execPrice
      ? Math.abs(execPrice - price) / price * 100
      : null;

    await this.db.updateOrder(orderRecord.id, {
      executedQty:  execQty,
      executedPrice:execPrice,
      feeAmount:    response.feeAmount   ? parseFloat(response.feeAmount) : 0,
      feeAsset:     response.feeAsset,
      slippagePct:  slippage,
      status:       response.status === 'FILLED' ? 'FILLED' : 'PENDING',
      filledAt:     response.status === 'FILLED' ? new Date() : null,
    }).catch(err => this.log.warn('Order update failed', { error: err.message }));

    // Set external ID for later reference
    if (response.orderId) {
      await this.db.query(
        'UPDATE orders SET external_order_id=$2 WHERE id=$1',
        [orderRecord.id, String(response.orderId)]
      ).catch(() => {});
    }

    this.log.debug('Order placed', {
      pair, side, type, quantity: execQty, price: execPrice,
      status: response.status, execMs, slippagePct: slippage?.toFixed(4),
    });

    return { ...orderRecord, response };
  }

  // ── POSITION HELPERS ──────────────────────────────────────────────────────

  async openPosition({ pair, side, quantity, entryPrice, stopLossPrice, takeProfitPrice, entryOrderId, metadata }) {
    const pos = await this.db.openPosition({
      botId: this.botId, pair, side, quantity,
      entryPrice, stopLossPrice, takeProfitPrice,
      entryOrderId, metadata,
    });
    this._openPositions.set(pos.id, pos);
    await this.saveState('open_positions', [...this._openPositions.keys()]);

    this.log.info('Position opened', { positionId: pos.id, pair, side, entryPrice });
    await this.log.tradeOpen({ pair, side, price: entryPrice, qty: quantity, stopLoss: stopLossPrice, takeProfit: takeProfitPrice });
    this.emit('position_opened', pos);
    return pos;
  }

  async closePosition({ positionId, exitPrice, exitOrderId, realizedPnl, feeTotal, netPnl, reason = 'unknown' }) {
    await this.db.closePosition(positionId, { exitPrice, exitOrderId, realizedPnl, feeTotal, netPnl });

    const pos = this._openPositions.get(positionId) || await this.db.getPositionById(positionId);
    this._openPositions.delete(positionId);
    await this.saveState('open_positions', [...this._openPositions.keys()]);

    // Update runtime stats
    this.stats.trades++;
    this.stats.totalPnlUSDT  += netPnl  || 0;
    this.stats.totalFeesUSDT += feeTotal || 0;
    if ((netPnl || 0) > 0) this.stats.wins++;
    else                    this.stats.losses++;

    this.log.info('Position closed', { positionId, exitPrice, netPnl, reason });
    await this.log.tradeClose({
      pair:       pos?.pair || 'unknown',
      side:       pos?.side || 'unknown',
      entryPrice: pos?.entry_price,
      exitPrice, qty: pos?.quantity, netPnl, reason,
    });
    this.emit('position_closed', { positionId, netPnl, reason });
    return { positionId, netPnl };
  }

  /**
   * Update unrealised PnL on an open position (called in tick loops)
   */
  async markToMarket(positionId, currentPrice) {
    const pos = this._openPositions.get(positionId);
    if (!pos) return;
    const qty   = parseFloat(pos.quantity);
    const entry = parseFloat(pos.entry_price);
    const side  = pos.side;
    const unrealised = side === 'LONG' || side === 'NEUTRAL'
      ? (currentPrice - entry) * qty
      : (entry - currentPrice) * qty;
    await this.db.updateUnrealizedPnl(positionId, unrealised, currentPrice);
  }

  // ── STATE PERSISTENCE ─────────────────────────────────────────────────────
  async saveState(key, value) {
    await this.db.setState(this.botId, key, value);
    await this.cache.hset(`botstate:${this.botId}`, key, value);
  }

  async loadState(key) {
    const cached = await this.cache.hget(`botstate:${this.botId}`, key);
    if (cached !== null) return cached;
    return this.db.getState(this.botId, key);
  }

  async clearState(key) {
    await this.db.deleteState(this.botId, key);
    await this.cache.hdel(`botstate:${this.botId}`, key);
  }

  // ── HEARTBEAT ─────────────────────────────────────────────────────────────
  _startHeartbeat() {
    this._heartbeatTimer = setInterval(async () => {
      try {
        await this.db.heartbeat(this.botId);
        await this.cache.set(
          `heartbeat:${this.botId}`,
          { ts: Date.now(), stats: this.stats, running: this.running },
          90 // 90s TTL — if missed, key expires and dashboard shows unhealthy
        );
      } catch (err) {
        this.log.warn('Heartbeat failed', { error: err.message });
      }
    }, 30_000);
  }

  // ── PERFORMANCE SNAPSHOT ──────────────────────────────────────────────────
  _startSnapshotSchedule() {
    // Save snapshot every hour
    this._snapshotTimer = setInterval(() => this._saveSnapshot().catch(() => {}), 3_600_000);
  }

  async _saveSnapshot() {
    const today   = new Date().toISOString().split('T')[0];
    const bot     = await this.db.getBotById(this.botId).catch(() => null);
    const total   = this.stats.wins + this.stats.losses;
    const winRate = total > 0 ? (this.stats.wins / total * 100) : 0;

    await this.db.upsertPerformanceSnapshot({
      botId:         this.botId,
      date:          today,
      totalTrades:   this.stats.trades,
      winningTrades: this.stats.wins,
      losingTrades:  this.stats.losses,
      grossPnl:      this.stats.totalPnlUSDT + this.stats.totalFeesUSDT,
      totalFees:     this.stats.totalFeesUSDT,
      netPnl:        this.stats.totalPnlUSDT,
      maxDrawdown:   bot ? parseFloat(bot.max_drawdown_pct) : 0,
      capitalStart:  bot ? parseFloat(bot.initial_capital_usdt) : 0,
      capitalEnd:    bot ? parseFloat(bot.current_capital_usdt) : 0,
    });
  }

  // ── REDIS CONTROL CHANNEL ─────────────────────────────────────────────────
  async _subscribeControlChannel() {
    this._unsubControl = await this.cache.subscribe(
      `bot:${this.botId}:control`,
      async (msg) => {
        this.log.info('Control message', msg);
        if (msg.action === 'stop'  && this.running)  await this.stop();
        if (msg.action === 'pause' && this.running)  this.stopping = true;
        if (msg.action === 'resume'&& this.stopping) this.stopping = false;
      }
    );
  }

  // ── AUTH0 ────────────────────────────────────────────────────────────────
  async getAuthHeader() {
    return this.auth0.authHeader();
  }

  // ── UTILITY ───────────────────────────────────────────────────────────────
  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Sleep respecting the stopping flag — breaks early if stop() is called
   */
  async sleepInterruptible(ms) {
    const step  = 200;
    let   spent = 0;
    while (spent < ms && this.running && !this.stopping) {
      await this.sleep(Math.min(step, ms - spent));
      spent += step;
    }
  }
}

module.exports = BaseBot;
