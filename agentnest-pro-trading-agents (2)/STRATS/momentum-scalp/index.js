'use strict';
/**
 * STRATEGY: Momentum Scalping
 *
 * Business logic:
 *   - Ultra-short timeframe (1m candles). Target: 0.2-0.5% per trade.
 *   - Entry requires ALL of: breakout from recent high/low, RSI momentum,
 *     price above/below VWAP, order book bid/ask imbalance, volume spike.
 *   - RSI divergence detected as bonus confirmation (not required alone).
 *   - OCO orders: take-profit + stop-loss placed simultaneously after entry.
 *   - Max hold time: force-exit after 5 min (prevents overnight exposure).
 *   - Rate limiter: max N trades per hour (prevent overtrading in choppy markets).
 *   - Cooldown: mandatory 30s between trades regardless of signals.
 *   - Spread guard: rejects entry if bid-ask spread > maxSpreadPct (illiquid).
 *   - Stochastic RSI added: requires both RSI and StochRSI to confirm direction.
 *   - All entries, exits, and signals logged to DB for backtesting review.
 *
 * Run: node src/strategies/momentum-scalp/index.js
 */

require('dotenv').config();
const BaseBot        = require('../../shared/base_bot');
const ExchangeClient = require('../../shared/exchange_client');
const Indicators     = require('../../shared/indicators');

const CONFIG = {
  id:      process.env.BOT_SCALP_ID || undefined,
  name:    'Momentum Scalp',
  botType: 'momentum_scalp',
  dryRun:  process.env.DRY_RUN !== 'false',

  pair:            process.env.SCALP_PAIR         || 'BTCUSDT',
  interval:        process.env.SCALP_INTERVAL     || '1m',
  tradeAmountUSDT: parseFloat(process.env.SCALP_TRADE_AMOUNT || '200'),

  // RSI
  rsiPeriod:       7,
  rsiBullish:      55,   // must be above this for long
  rsiBearish:      45,   // must be below this for short

  // Stochastic RSI (additional confirmation)
  stochRsiPeriod:  14,
  stochKPeriod:    3,
  stochDPeriod:    3,
  stochBullish:    20,   // stochK must be above this
  stochBearish:    80,   // stochK must be below this

  // Momentum / breakout
  momentumPeriod:       10,
  momentumThresholdPct: 0.15,
  breakoutLookback:     5,    // bars to define recent high/low

  // ATR for stop sizing
  atrPeriod:         7,
  atrStopMultiplier: 1.5,
  riskRewardRatio:   1.5,

  // Volume filter
  minVolumeMultiplier: 1.5,  // volume must be >= 1.5x 20-bar avg (higher than trend bot)

  // Order book filters
  useVWAP:         true,
  minImbalance:    0.60,   // bid/(bid+ask) ratio for longs
  maxSpreadPct:    0.02,   // reject if spread > 0.02% (illiquid)

  // Trade frequency limits
  maxTradesPerHour: parseInt(process.env.SCALP_MAX_TRADES_HOUR || '10'),
  cooldownMs:       parseInt(process.env.SCALP_COOLDOWN_MS     || '30000'),
  maxHoldMs:        parseInt(process.env.SCALP_MAX_HOLD_MS     || '300000'),

  allowShort:       process.env.SCALP_ALLOW_SHORT === 'true',
  pollIntervalMs:   parseInt(process.env.SCALP_POLL_INTERVAL_MS || '5000'),
  globalStopLossPct:parseFloat(process.env.GLOBAL_STOP_LOSS_PERCENT || '10'),

  exchange: {
    name:            process.env.EXCHANGE_A_NAME    || 'Exchange',
    baseUrl:         process.env.EXCHANGE_A_BASE_URL,
    apiKey:          process.env.EXCHANGE_A_API_KEY,
    apiSecret:       process.env.EXCHANGE_A_API_SECRET,
    takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.05'), // low-fee exchange required for scalping
  },
};

class MomentumScalpBot extends BaseBot {
  constructor(cfg) {
    super(cfg);
    this.ex           = new ExchangeClient({ ...cfg.exchange, dryRun: cfg.dryRun });
    this.dbPos        = null;
    this.ocoId        = null;
    this.lastTrade    = 0;
    this.hourlyTrades = []; // timestamps of trades in last hour
    this.rsiHistory   = []; // rolling RSI for divergence detection

    this._session = { signals: 0, entered: 0, rejected: { spread:0, volume:0, rsi:0, vwap:0, imbalance:0, rateLimit:0, cooldown:0 } };
  }

  async onRestoreState(state) {
    if (state.position) {
      this.dbPos = state.position;
      this.ocoId = state.ocoId || null;
      this.log.info('Scalp: position restored', { side: this.dbPos.side, entry: this.dbPos.entry_price });
    }
    if (state.rsiHistory) this.rsiHistory = state.rsiHistory;
  }

  // ── Rate limiter: max N trades per hour ───────────────────────────────────
  _canTrade() {
    const now = Date.now();
    this.hourlyTrades = this.hourlyTrades.filter(t => now - t < 3_600_000);
    if (this.hourlyTrades.length >= this.config.maxTradesPerHour) {
      this._session.rejected.rateLimit++;
      return false;
    }
    if (now - this.lastTrade < this.config.cooldownMs) {
      this._session.rejected.cooldown++;
      return false;
    }
    return true;
  }

  // ── Run all entry analysis ────────────────────────────────────────────────
  async _analyse(candles) {
    const closes  = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const n       = candles.length;
    const price   = closes[n - 1];

    const rsi       = Indicators.rsi(closes, this.config.rsiPeriod);
    const stochRsi  = Indicators.stochRsi(closes, this.config.stochRsiPeriod, 14, this.config.stochKPeriod, this.config.stochDPeriod);
    const atr       = Indicators.atr(candles, this.config.atrPeriod);
    const vwap      = this.config.useVWAP ? Indicators.vwap(candles) : null;
    const mom       = Indicators.momentum(closes, this.config.momentumPeriod);
    const volAvg    = Indicators.sma(volumes, 20);
    const volOk     = volAvg && volumes[n-1] >= volAvg * this.config.minVolumeMultiplier;

    // Breakout from recent high/low
    const lookback = this.config.breakoutLookback;
    const recent   = candles.slice(-lookback - 1, -1);
    const hiRecent = Math.max(...recent.map(c => c.high));
    const loRecent = Math.min(...recent.map(c => c.low));
    const breakout = price > hiRecent ? 'bullish' : price < loRecent ? 'bearish' : null;

    // Order book
    let book = { imbalance: 0.5, spreadPct: 0 };
    try { book = await this.ex.getOrderBook(this.config.pair, 20); } catch (_) {}

    // RSI history for divergence
    if (rsi !== null) {
      this.rsiHistory.push(rsi);
      if (this.rsiHistory.length > 30) this.rsiHistory.shift();
    }
    const divergence = this.rsiHistory.length >= 6
      ? Indicators.rsiDivergence(closes, this.rsiHistory, 5)
      : null;

    return {
      price, rsi, stochRsi, atr, vwap, mom, volOk, volAvg,
      breakout, book, divergence, candles,
    };
  }

  // ── Signal decision: all filters must pass ────────────────────────────────
  _getSignal(a) {
    const { price, rsi, stochRsi, mom, volOk, vwap, book, breakout } = a;

    this._session.signals++;

    // ── Pre-checks ────────────────────────────────────────────────────────
    if (!rsi || !mom || !breakout) return null;

    if (!volOk)                                      { this._session.rejected.volume++;    return null; }
    if (book.spreadPct > this.config.maxSpreadPct)   { this._session.rejected.spread++;    return null; }
    if (Math.abs(mom) < this.config.momentumThresholdPct) return null;

    // ── LONG signal ───────────────────────────────────────────────────────
    if (
      breakout === 'bullish'                                       &&
      rsi >= this.config.rsiBullish                               &&
      mom > 0                                                     &&
      (!this.config.useVWAP || !vwap || price > vwap)             &&
      book.imbalance >= this.config.minImbalance                  &&
      (!stochRsi || stochRsi.k >= this.config.stochBullish)
    ) {
      return {
        direction: 'LONG', price, rsi, mom, imbalance: book.imbalance,
        stochK: stochRsi?.k, divergence: a.divergence,
      };
    }

    // ── SHORT signal ──────────────────────────────────────────────────────
    if (
      this.config.allowShort                                       &&
      breakout === 'bearish'                                       &&
      rsi <= this.config.rsiBearish                               &&
      mom < 0                                                     &&
      (!this.config.useVWAP || !vwap || price < vwap)             &&
      book.imbalance <= (1 - this.config.minImbalance)            &&
      (!stochRsi || stochRsi.k <= this.config.stochBearish)
    ) {
      return {
        direction: 'SHORT', price, rsi, mom, imbalance: book.imbalance,
        stochK: stochRsi?.k, divergence: a.divergence,
      };
    }

    return null;
  }

  // ── Enter position ────────────────────────────────────────────────────────
  async _enter(signal, analysis) {
    const { direction, price } = signal;
    const { atr }              = analysis;
    const isLong               = direction === 'LONG';

    const sl  = isLong ? price - atr * this.config.atrStopMultiplier : price + atr * this.config.atrStopMultiplier;
    const tp  = isLong ? price + (price - sl) * this.config.riskRewardRatio : price - (sl - price) * this.config.riskRewardRatio;
    const qty = this.config.tradeAmountUSDT / price;
    const side= isLong ? 'BUY' : 'SELL';

    this.log.info('Scalp entry', {
      direction, price, sl: sl.toFixed(2), tp: tp.toFixed(2),
      rsi: signal.rsi?.toFixed(1), stochK: signal.stochK?.toFixed(1),
      imbalance: signal.imbalance?.toFixed(3), divergence: signal.divergence,
    });

    const entryOrder = await this.placeOrder({
      exchange: this.ex.name, pair: this.config.pair, side, type: 'MARKET', quantity: qty,
      execute:  () => this.ex.marketOrder(this.config.pair, side, null, this.config.tradeAmountUSDT),
    });

    // Place OCO (TP + SL as a pair)
    const exitSide = isLong ? 'SELL' : 'BUY';
    const slipBuf  = atr * 0.1;
    const slLimit  = isLong ? sl - slipBuf : sl + slipBuf;

    try {
      const oco = await this.ex.setOCO(this.config.pair, exitSide, qty, tp, sl, slLimit);
      this.ocoId = oco.orderListId;
    } catch (_) {
      // Fallback: just set stop-loss if OCO not supported
      const slOrder = await this.ex.setStopLoss(this.config.pair, exitSide, qty, sl);
      this.ocoId = slOrder.orderId;
    }

    this.dbPos = await this.openPosition({
      pair:           this.config.pair,
      side:           direction,
      quantity:       qty,
      entryPrice:     price,
      stopLossPrice:  sl,
      takeProfitPrice:tp,
      entryOrderId:   entryOrder.id,
      metadata:       { ...signal, atr },
    });

    this._session.entered++;
    this.hourlyTrades.push(Date.now());
    await this.saveState('position', this.dbPos);
    await this.saveState('ocoId', this.ocoId);
    await this.saveState('rsiHistory', this.rsiHistory);
  }

  // ── Exit position ─────────────────────────────────────────────────────────
  async _exit(reason, exitPrice) {
    if (!this.dbPos) return;
    const side   = this.dbPos.side;
    const qty    = parseFloat(this.dbPos.quantity);
    const entry  = parseFloat(this.dbPos.entry_price);
    const exitSide= side === 'LONG' ? 'SELL' : 'BUY';

    // Cancel OCO
    if (this.ocoId) {
      await this.ex.cancelOCO(this.config.pair, this.ocoId).catch(() =>
        this.ex.cancelOrder(this.config.pair, this.ocoId).catch(() => {})
      );
    }

    const exitOrder = await this.placeOrder({
      exchange: this.ex.name, pair: this.config.pair, side: exitSide, type: 'MARKET', quantity: qty,
      execute: () => this.ex.marketOrder(this.config.pair, exitSide, null, qty * exitPrice),
    });

    const execExit = parseFloat(exitOrder.response.executedPrice || exitPrice);
    const rawPnl   = side === 'LONG' ? (execExit - entry) * qty : (entry - execExit) * qty;
    const fees     = this.ex.fee / 100 * this.config.tradeAmountUSDT * 2;
    const netPnl   = rawPnl - fees;
    const holdMs   = Date.now() - new Date(this.dbPos.opened_at).getTime();

    await this.closePosition({
      positionId: this.dbPos.id, exitPrice: execExit,
      exitOrderId: exitOrder.id, realizedPnl: rawPnl, feeTotal: fees, netPnl, reason,
    });

    this.log.info('Scalp exit', {
      side, entry: entry.toFixed(2), exit: execExit.toFixed(2),
      rawPnl: rawPnl.toFixed(4), netPnl: netPnl.toFixed(4),
      holdMs, reason,
    });

    this.dbPos   = null;
    this.ocoId   = null;
    this.lastTrade = Date.now();
    await this.clearState('position');
    await this.clearState('ocoId');
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async run() {
    this.log.info('Momentum Scalp started', {
      pair:       this.config.pair,
      interval:   this.config.interval,
      maxTrades:  this.config.maxTradesPerHour,
      cooldown:   this.config.cooldownMs / 1000 + 's',
      allowShort: this.config.allowShort,
    });

    let lastSessionLog = Date.now();

    while (this.running && !this.stopping) {
      if (!await this.riskCheck()) break;

      try {
        const candles = await this.ex.getKlines(this.config.pair, this.config.interval, 100);
        const price   = candles[candles.length - 1].close;

        // ── Exit check ──────────────────────────────────────────────────────
        if (this.dbPos) {
          const sl     = parseFloat(this.dbPos.stop_loss_price);
          const tp     = parseFloat(this.dbPos.take_profit_price);
          const side   = this.dbPos.side;
          const holdMs = Date.now() - new Date(this.dbPos.opened_at).getTime();

          const hitSL  = side === 'LONG' ? price <= sl : price >= sl;
          const hitTP  = side === 'LONG' ? price >= tp : price <= tp;
          const timeout= holdMs > this.config.maxHoldMs;

          if (hitSL || hitTP || timeout) {
            const reason = hitSL ? 'stop_loss' : hitTP ? 'take_profit' : 'max_hold_time';
            await this._exit(reason, price);
          } else {
            await this.markToMarket(this.dbPos.id, price);
          }
        }

        // ── Entry check ─────────────────────────────────────────────────────
        if (!this.dbPos && this._canTrade()) {
          const a      = await this._analyse(candles);
          const signal = this._getSignal(a);
          if (signal) await this._enter(signal, a);
        }

      } catch (err) {
        this.log.error('Tick error', { error: err.message });
      }

      // Log session stats every 10 min
      if (Date.now() - lastSessionLog > 600_000) {
        const wr = this._session.entered > 0
          ? (this.stats.wins / (this.stats.wins + this.stats.losses) * 100).toFixed(1)
          : '—';
        this.log.info('Scalp session stats', {
          ...this._session, winRate: wr + '%',
          tradesThisHour: this.hourlyTrades.length,
          totalPnl: this.stats.totalPnlUSDT.toFixed(4),
        });
        lastSessionLog = Date.now();
      }

      await this.sleepInterruptible(this.config.pollIntervalMs);
    }

    // Close on shutdown
    if (this.dbPos) {
      const price = await this.ex.getPrice(this.config.pair).catch(() => parseFloat(this.dbPos.entry_price));
      await this._exit('bot_shutdown', price);
    }
  }
}

if (require.main === module) {
  const bot = new MomentumScalpBot(CONFIG);
  process.on('SIGINT',  () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  bot.start();
}

module.exports = MomentumScalpBot;
