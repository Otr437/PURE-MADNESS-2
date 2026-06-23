'use strict';
/**
 * STRATEGY: Grid Trading Bot
 *
 * Business logic:
 *   - Builds an evenly-spaced price grid between lower and upper bounds
 *   - Places BUY limit orders below current price, SELL limit orders above
 *   - Each BUY fill → immediately places SELL one level up (captures the grid profit)
 *   - Each SELL fill → immediately places BUY one level down (resets for next cycle)
 *   - Profit per grid = price_step × qty − 2 × maker_fee × notional
 *   - Grid profit accumulates to DB (recordGridProfit) per level for full audit
 *   - Stop-loss: cancels all orders and exits if price falls below gridLower × (1-SL%)
 *   - Take-profit: cancels all orders if price rises above gridUpper × (1+TP%)
 *   - State persisted: survives restart with all open orders restored
 *   - Circuit breaker: if exchange fails 5 times, halts and alerts
 *   - Validates grid bounds against current price on startup (warns if misaligned)
 *
 * Run: node src/strategies/grid/index.js
 */

require('dotenv').config();
const BaseBot        = require('../../shared/base_bot');
const ExchangeClient = require('../../shared/exchange_client');

const CONFIG = {
  id:      process.env.BOT_GRID_ID || undefined,
  name:    'Grid Bot',
  botType: 'grid',
  dryRun:  process.env.DRY_RUN !== 'false',

  pair:             process.env.GRID_PAIR     || 'BTCUSDT',
  gridLower:        parseFloat(process.env.GRID_LOWER    || '80000'),
  gridUpper:        parseFloat(process.env.GRID_UPPER    || '100000'),
  gridLevels:       parseInt(process.env.GRID_LEVELS     || '10'),
  totalCapitalUSDT: parseFloat(process.env.GRID_CAPITAL  || '1000'),

  // Stop-loss: cancel all if price drops this % below gridLower
  stopLossPct:   parseFloat(process.env.GRID_STOP_LOSS_PCT   || '15'),
  // Take-profit: cancel all if price rises this % above gridUpper
  takeProfitPct: parseFloat(process.env.GRID_TAKE_PROFIT_PCT || '20'),

  // Poll interval for checking order fills
  pollIntervalMs: parseInt(process.env.GRID_POLL_INTERVAL_MS || '2000'),

  // Delay between placing individual grid orders (rate limit protection)
  orderPlacementDelayMs: 150,

  globalStopLossPct: parseFloat(process.env.GLOBAL_STOP_LOSS_PERCENT || '10'),

  exchange: {
    name:            process.env.EXCHANGE_A_NAME    || 'Exchange',
    baseUrl:         process.env.EXCHANGE_A_BASE_URL,
    apiKey:          process.env.EXCHANGE_A_API_KEY,
    apiSecret:       process.env.EXCHANGE_A_API_SECRET,
    takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
    makerFeePercent: parseFloat(process.env.EXCHANGE_A_MAKER_FEE || '0.05'),
  },
};

class GridBot extends BaseBot {
  constructor(cfg) {
    super(cfg);

    // Validate grid config
    if (cfg.gridLower <= 0)         throw new RangeError('Grid: gridLower must be > 0');
    if (cfg.gridUpper <= cfg.gridLower) throw new RangeError('Grid: gridUpper must be > gridLower');
    if (cfg.gridLevels < 3)         throw new RangeError('Grid: gridLevels must be >= 3');
    if (cfg.totalCapitalUSDT <= 0)  throw new RangeError('Grid: totalCapitalUSDT must be > 0');

    this.ex = new ExchangeClient({ ...cfg.exchange, dryRun: cfg.dryRun });

    // orderId → { levelIndex, side, price, qty, dbOrderId }
    this.orders = new Map();
    this.levels = [];

    // Per-session stats
    this._gridStats = {
      buysFilled:  0,
      sellsFilled: 0,
      totalProfit: 0,
    };
  }

  async onRestoreState(state) {
    if (state.gridOrders && Object.keys(state.gridOrders).length) {
      for (const [k, v] of Object.entries(state.gridOrders)) {
        this.orders.set(k, v);
      }
      this.log.info('Grid orders restored from state', { count: this.orders.size });
    }
  }

  // ── Build evenly-spaced grid levels ───────────────────────────────────────
  _buildGrid() {
    const { gridLower, gridUpper, gridLevels } = this.config;
    const step  = (gridUpper - gridLower) / (gridLevels - 1);
    this.levels = Array.from({ length: gridLevels }, (_, i) => ({
      index: i,
      price: parseFloat((gridLower + step * i).toFixed(2)),
    }));

    const totalNotional = this.config.totalCapitalUSDT;
    const usdtPerLevel  = totalNotional / (gridLevels - 1);
    this.log.info('Grid built', {
      levels:      gridLevels,
      lower:       gridLower,
      upper:       gridUpper,
      step:        step.toFixed(2),
      usdtPerLevel:usdtPerLevel.toFixed(2),
      gridProfit:  `~$${(step * usdtPerLevel / ((gridLower + gridUpper) / 2)).toFixed(4)} per fill`,
    });

    return this.levels;
  }

  // ── Quantity per grid level ───────────────────────────────────────────────
  _qtyPerLevel(price) {
    const usdtPerLevel = this.config.totalCapitalUSDT / (this.config.gridLevels - 1);
    return usdtPerLevel / price;
  }

  // ── Expected profit for buying at level L and selling at L+1 ─────────────
  _expectedProfitPerFill(buyPrice, sellPrice, qty) {
    const gross   = (sellPrice - buyPrice) * qty;
    const buyFee  = buyPrice  * qty * this.ex.mkrFee / 100;
    const sellFee = sellPrice * qty * this.ex.mkrFee / 100;
    return gross - buyFee - sellFee;
  }

  // ── Place one grid order and register in state ────────────────────────────
  async _placeGridOrder(level, side) {
    let qty = this._qtyPerLevel(level.price);

    // Round to lot size
    try {
      const info = await this.ex.getSymbolInfo(this.config.pair);
      qty = this.ex.roundQty(qty, info.stepSize);
      if (qty < info.minQty) return null;
    } catch (_) {}

    const res = await this.placeOrder({
      exchange: this.ex.name,
      pair:     this.config.pair,
      side,
      type:     'LIMIT',
      quantity: qty,
      price:    level.price,
      execute:  () => this.ex.limitOrder(this.config.pair, side, qty, level.price),
    });

    const oid = String(res.response.orderId || res.id);
    const entry = { levelIndex: level.index, side, price: level.price, qty, dbOrderId: res.id };
    this.orders.set(oid, entry);

    await this.db.upsertGridLevel({
      botId:      this.botId,
      levelIndex: level.index,
      price:      level.price,
      side,
      orderId:    res.id,
    });

    await this.saveState('gridOrders', Object.fromEntries(this.orders));
    return oid;
  }

  // ── Handle a filled order ─────────────────────────────────────────────────
  async _handleFill(filledOrderId, order) {
    this.orders.delete(filledOrderId);
    const { levelIndex, side, price, qty } = order;

    if (side === 'BUY') {
      this._gridStats.buysFilled++;
      const nextLevel = this.levels[levelIndex + 1];
      if (!nextLevel) {
        this.log.debug('BUY filled at top level — no SELL to place');
        return;
      }

      const profit = this._expectedProfitPerFill(price, nextLevel.price, qty);
      this._gridStats.totalProfit += profit;

      await this.db.recordGridProfit(this.botId, levelIndex, profit);

      this.log.info('Grid BUY filled', {
        level:     levelIndex,
        buyPrice:  price,
        nextSell:  nextLevel.price,
        qty:       qty.toFixed(6),
        expProfit: profit.toFixed(4),
        totalProfit: this._gridStats.totalProfit.toFixed(4),
      });

      await this._placeGridOrder(nextLevel, 'SELL');

    } else { // SELL
      this._gridStats.sellsFilled++;
      const prevLevel = this.levels[levelIndex - 1];
      if (!prevLevel) {
        this.log.debug('SELL filled at bottom level — no BUY to place');
        return;
      }

      this.log.info('Grid SELL filled', {
        level:    levelIndex,
        sellPrice:price,
        nextBuy:  prevLevel.price,
        qty:      qty.toFixed(6),
        totalFills: this._gridStats.buysFilled + this._gridStats.sellsFilled,
      });

      await this._placeGridOrder(prevLevel, 'BUY');
    }

    await this.saveState('gridOrders', Object.fromEntries(this.orders));
  }

  // ── Shutdown: cancel everything ────────────────────────────────────────────
  async _shutdown(reason) {
    this.running = false;
    this.log.info(`Grid shutting down: ${reason}`, this._gridStats);

    try {
      await this.ex.cancelAllOrders(this.config.pair);
      await this.db.deactivateGridLevels(this.botId);
      this.orders.clear();
      await this.clearState('gridOrders');
    } catch (err) {
      this.log.error('Error cancelling orders on shutdown', { error: err.message });
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async run() {
    this._buildGrid();

    const currentPrice = await this.ex.getPrice(this.config.pair);
    this.log.info('Grid Bot started', {
      pair:         this.config.pair,
      currentPrice,
      gridLower:    this.config.gridLower,
      gridUpper:    this.config.gridUpper,
      levels:       this.config.gridLevels,
      capital:      this.config.totalCapitalUSDT,
    });

    // Warn if current price is outside grid range
    if (currentPrice < this.config.gridLower) {
      this.log.warn('Current price is BELOW grid lower bound — all orders will be SELL', { currentPrice, gridLower: this.config.gridLower });
    } else if (currentPrice > this.config.gridUpper) {
      this.log.warn('Current price is ABOVE grid upper bound — all orders will be BUY', { currentPrice, gridUpper: this.config.gridUpper });
    }

    // Place initial orders (skip levels at current price)
    for (const level of this.levels) {
      if (!this.running || this.stopping) break;
      if (Math.abs(level.price - currentPrice) / currentPrice < 0.001) continue; // skip ≈current

      const side = level.price < currentPrice ? 'BUY' : 'SELL';
      await this._placeGridOrder(level, side);
      await this.sleepInterruptible(this.config.orderPlacementDelayMs);
    }

    this.log.info('Initial grid placed', { ordersCount: this.orders.size });

    // Pre-compute bounds for stop/tp check
    const slPrice = this.config.gridLower * (1 - this.config.stopLossPct  / 100);
    const tpPrice = this.config.gridUpper * (1 + this.config.takeProfitPct / 100);

    let lastPriceLog = Date.now();

    while (this.running && !this.stopping) {
      if (!await this.riskCheck()) { await this._shutdown('global_risk_check'); break; }

      try {
        const price = await this.ex.getPrice(this.config.pair);

        // Log price every 30s
        if (Date.now() - lastPriceLog > 30_000) {
          this.log.debug('Grid tick', {
            price,
            activeOrders:  this.orders.size,
            buysFilled:    this._gridStats.buysFilled,
            sellsFilled:   this._gridStats.sellsFilled,
            totalProfit:   this._gridStats.totalProfit.toFixed(4),
          });
          lastPriceLog = Date.now();
        }

        // Bounds check
        if (price <= slPrice) {
          this.log.error('Stop-loss triggered', { price, slPrice });
          await this.log.alertError(`Grid stop-loss at $${price.toFixed(2)} (limit $${slPrice.toFixed(2)})`);
          await this._shutdown('stop_loss');
          break;
        }
        if (price >= tpPrice) {
          this.log.info('Take-profit triggered', { price, tpPrice });
          await this._shutdown('take_profit');
          break;
        }

        // Poll all active orders for fills
        const activeOrders = [...this.orders.entries()];
        for (const [oid, order] of activeOrders) {
          if (!this.running) break;
          try {
            const fresh = await this.ex.getOrder(this.config.pair, oid);
            if (fresh.status === 'FILLED' || fresh.status === 'CANCELED') {
              if (fresh.status === 'FILLED') {
                await this._handleFill(oid, order);
              } else {
                // Replaced or cancelled externally — remove from tracking
                this.orders.delete(oid);
                this.log.warn('Order cancelled externally', { oid, level: order.levelIndex });
              }
            }
          } catch (err) {
            this.log.warn(`Error checking order ${oid}`, { error: err.message });
          }
        }

      } catch (err) {
        this.log.error('Tick error', { error: err.message });
        if (this.ex.circuitBreakerOpen) {
          await this.log.alertError(`Grid bot: exchange circuit breaker open after ${this.ex.consecutiveFailures} failures`);
          await this.sleepInterruptible(60_000);
        }
      }

      await this.sleepInterruptible(this.config.pollIntervalMs);
    }

    if (this.running) await this._shutdown('bot_stopped');
  }
}

if (require.main === module) {
  const bot = new GridBot(CONFIG);
  process.on('SIGINT',  () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  bot.start();
}

module.exports = GridBot;
