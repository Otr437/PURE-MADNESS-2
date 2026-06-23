'use strict';
/**
 * STRATEGY: Trend Following — Multi-Indicator MA Crossover
 *
 * Business logic:
 *   - Primary signal: 50/200 EMA crossover (golden cross / death cross)
 *   - Filters (all must pass before entry):
 *       RSI < 70 for longs, > 30 for shorts (not entering overbought/oversold)
 *       Volume >= 1.2x the 20-bar average (confirms conviction)
 *       ADX > 20 (market is actually trending, not ranging)
 *       Price above/below VWAP (directional confirmation)
 *   - ATR-based stop loss (2x ATR) — adapts to volatility
 *   - Risk/reward ratio enforced: take profit = entry ± 2x stop distance
 *   - Trailing stop: after 1x ATR in profit, stop moves to break-even
 *   - Position sizing via Kelly criterion (capped at 25% of configured capital)
 *   - State persisted — restores open positions and SL order ID after restart
 *   - Reversal signal closes position and opens opposite (no gap)
 *
 * Run: node src/strategies/trend-following/index.js
 */

require('dotenv').config();
const BaseBot        = require('../../shared/base_bot');
const ExchangeClient = require('../../shared/exchange_client');
const Indicators     = require('../../shared/indicators');

const CONFIG = {
  id:      process.env.BOT_TREND_ID || undefined,
  name:    'Trend Following',
  botType: 'trend_following',
  dryRun:  process.env.DRY_RUN !== 'false',

  pair:            process.env.TREND_PAIR         || 'BTCUSDT',
  interval:        process.env.TREND_INTERVAL     || '4h',
  tradeAmountUSDT: parseFloat(process.env.TREND_TRADE_AMOUNT || '500'),

  // Moving averages
  fastMAPeriod:    parseInt(process.env.TREND_FAST_MA  || '50'),
  slowMAPeriod:    parseInt(process.env.TREND_SLOW_MA  || '200'),
  maType:          process.env.TREND_MA_TYPE          || 'EMA',

  // Entry filters
  rsiPeriod:       14,
  rsiOverbought:   70,
  rsiOversold:     30,
  adxPeriod:       14,
  minADX:          20,        // require trending market
  minVolumeMultiplier: 1.2,   // volume must be >= 1.2x 20-bar avg
  useVWAP:         true,

  // Risk management
  atrPeriod:           14,
  atrStopMultiplier:   2.0,
  riskRewardRatio:     2.0,
  // After price moves this many ATR in profit, move SL to break-even
  breakEvenATR:        1.0,
  allowShort:          process.env.TREND_ALLOW_SHORT === 'true',

  pollIntervalMs:  parseInt(process.env.TREND_POLL_INTERVAL_MS || '60000'),
  globalStopLossPct:parseFloat(process.env.GLOBAL_STOP_LOSS_PERCENT || '10'),

  exchange: {
    name:            process.env.EXCHANGE_A_NAME    || 'Exchange',
    baseUrl:         process.env.EXCHANGE_A_BASE_URL,
    apiKey:          process.env.EXCHANGE_A_API_KEY,
    apiSecret:       process.env.EXCHANGE_A_API_SECRET,
    takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
  },
};

class TrendFollowingBot extends BaseBot {
  constructor(cfg) {
    super(cfg);
    if (cfg.fastMAPeriod >= cfg.slowMAPeriod)
      throw new RangeError(`Trend: fastMA(${cfg.fastMAPeriod}) must be < slowMA(${cfg.slowMAPeriod})`);

    this.ex     = new ExchangeClient({ ...cfg.exchange, dryRun: cfg.dryRun });
    this.dbPos  = null;
    this.slOid  = null;
    this._breakEvenMoved = false;

    this._tradeLog = []; // last 20 trade outcomes for Kelly criterion
  }

  async onRestoreState(state) {
    if (state.position) {
      this.dbPos  = state.position;
      this.slOid  = state.slOid || null;
      this._breakEvenMoved = state.breakEvenMoved || false;
      this.log.info('Trend: position restored', {
        side: this.dbPos.side, entry: this.dbPos.entry_price,
        sl: this.dbPos.stop_loss_price, tp: this.dbPos.take_profit_price,
      });
    }
    if (state.tradeLog) this._tradeLog = state.tradeLog;
  }

  // ── Analyse candles, compute all indicators ────────────────────────────────
  _analyse(candles) {
    const closes  = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const price   = closes[closes.length - 1];
    const n       = closes.length;

    const fastMA  = Indicators.ma(closes, this.config.fastMAPeriod, this.config.maType);
    const slowMA  = Indicators.ma(closes, this.config.slowMAPeriod, this.config.maType);
    const rsi     = Indicators.rsi(closes, this.config.rsiPeriod);
    const atr     = Indicators.atr(candles, this.config.atrPeriod);
    const bb      = Indicators.bollingerBands(closes, 20, 2);
    const adx     = Indicators.adx(candles, this.config.adxPeriod);
    const vwap    = this.config.useVWAP ? Indicators.vwap(candles.slice(-24)) : null; // last 24 bars for intraday VWAP
    const cross   = Indicators.maCrossover(closes, this.config.fastMAPeriod, this.config.slowMAPeriod, this.config.maType);
    const volAvg  = Indicators.sma(volumes, 20);
    const volOk   = volAvg && volumes[n - 1] >= volAvg * this.config.minVolumeMultiplier;

    // Kelly position size from recent trade log
    let kellyFraction = 0.5; // default to 50% of configured amount
    if (this._tradeLog.length >= 10) {
      const wins     = this._tradeLog.filter(t => t > 0);
      const losses   = this._tradeLog.filter(t => t < 0);
      const winRate  = wins.length / this._tradeLog.length;
      const avgWin   = wins.length   ? wins.reduce((a,b)=>a+b,0)/wins.length : 0;
      const avgLoss  = losses.length ? Math.abs(losses.reduce((a,b)=>a+b,0)/losses.length) : 1;
      kellyFraction  = Indicators.kellyCriterion(winRate, avgWin, avgLoss) ?? 0.5;
    }

    return {
      price, fastMA, slowMA, rsi, atr, bb, adx, vwap, cross,
      volOk, volAvg: volAvg?.toFixed(0), kellyFraction,
      trend: fastMA && slowMA ? (fastMA > slowMA ? 'bullish' : 'bearish') : 'unknown',
    };
  }

  // ── Entry signal decision ─────────────────────────────────────────────────
  _getEntrySignal(a) {
    const { cross, rsi, adx, vwap, price, volOk } = a;
    if (!cross || !rsi || !adx || !volOk) return null;

    // All filters must pass
    const baseFilters = adx.adx >= this.config.minADX && volOk;
    if (!baseFilters) return null;

    if (cross === 'golden' && rsi < this.config.rsiOverbought
        && (!this.config.useVWAP || !vwap || price > vwap)) {
      return 'LONG';
    }
    if (cross === 'death' && this.config.allowShort && rsi > this.config.rsiOversold
        && (!this.config.useVWAP || !vwap || price < vwap)) {
      return 'SHORT';
    }
    return null;
  }

  // ── Enter a position ──────────────────────────────────────────────────────
  async _enter(signal, analysis) {
    const { price, atr, kellyFraction, fastMA, slowMA, rsi, adx } = analysis;
    const isLong = signal === 'LONG';

    // Kelly-adjusted position size
    const adjAmount = this.config.tradeAmountUSDT * kellyFraction;
    const qty       = adjAmount / price;

    const sl  = isLong ? price - atr * this.config.atrStopMultiplier : price + atr * this.config.atrStopMultiplier;
    const tp  = isLong ? price + (price - sl) * this.config.riskRewardRatio : price - (sl - price) * this.config.riskRewardRatio;
    const side= isLong ? 'BUY' : 'SELL';

    this.log.info('Trend entry', {
      signal, price, atr: atr.toFixed(2), sl: sl.toFixed(2), tp: tp.toFixed(2),
      adjAmount: adjAmount.toFixed(2), kellyFraction: kellyFraction.toFixed(3),
      fastMA: fastMA?.toFixed(2), slowMA: slowMA?.toFixed(2), rsi: rsi.toFixed(1), adx: adx.adx?.toFixed(1),
    });

    const entryOrder = await this.placeOrder({
      exchange: this.ex.name, pair: this.config.pair, side, type: 'MARKET', quantity: qty,
      execute: () => this.ex.marketOrder(this.config.pair, side, null, adjAmount),
    });

    const slOrder    = await this.ex.setStopLoss(this.config.pair, isLong ? 'SELL' : 'BUY', qty, sl);
    this.slOid       = slOrder.orderId;
    this._breakEvenMoved = false;

    this.dbPos = await this.openPosition({
      pair:           this.config.pair,
      side:           signal,
      quantity:       qty,
      entryPrice:     price,
      stopLossPrice:  sl,
      takeProfitPrice:tp,
      entryOrderId:   entryOrder.id,
      metadata:       { atr, kellyFraction, adx: adx.adx, rsi, fastMA, slowMA },
    });

    await this.saveState('position',      this.dbPos);
    await this.saveState('slOid',         this.slOid);
    await this.saveState('breakEvenMoved',this._breakEvenMoved);
  }

  // ── Exit a position ───────────────────────────────────────────────────────
  async _exit(reason, exitPrice) {
    if (!this.dbPos) return;
    const side     = this.dbPos.side;
    const qty      = parseFloat(this.dbPos.quantity);
    const entry    = parseFloat(this.dbPos.entry_price);
    const exitSide = side === 'LONG' ? 'SELL' : 'BUY';

    // Cancel stop loss
    if (this.slOid) {
      await this.ex.cancelOrder(this.config.pair, this.slOid).catch(() => {});
    }

    const exitOrder = await this.placeOrder({
      exchange: this.ex.name, pair: this.config.pair, side: exitSide, type: 'MARKET', quantity: qty,
      execute: () => this.ex.marketOrder(this.config.pair, exitSide, null, qty * exitPrice),
    });

    const execExit = parseFloat(exitOrder.response.executedPrice || exitPrice);
    const rawPnl   = side === 'LONG' ? (execExit - entry) * qty : (entry - execExit) * qty;
    const fees     = this.ex.fee / 100 * this.config.tradeAmountUSDT * 2;
    const netPnl   = rawPnl - fees;

    await this.closePosition({
      positionId: this.dbPos.id, exitPrice: execExit,
      exitOrderId: exitOrder.id, realizedPnl: rawPnl, feeTotal: fees, netPnl, reason,
    });

    // Track for Kelly
    this._tradeLog.push(netPnl);
    if (this._tradeLog.length > 50) this._tradeLog.shift();
    await this.saveState('tradeLog', this._tradeLog);

    this.log.info('Trend exit', { side, entry, exit: execExit, netPnl: netPnl.toFixed(4), reason });

    this.dbPos = null; this.slOid = null; this._breakEvenMoved = false;
    await this.clearState('position'); await this.clearState('slOid');
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async run() {
    this.log.info('Trend Following started', {
      pair:      this.config.pair,
      interval:  this.config.interval,
      fastMA:    this.config.fastMAPeriod,
      slowMA:    this.config.slowMAPeriod,
      maType:    this.config.maType,
      allowShort:this.config.allowShort,
    });

    while (this.running && !this.stopping) {
      if (!await this.riskCheck()) break;

      try {
        // Fetch enough candles for all indicators (slowMA + extra)
        const needed  = Math.max(this.config.slowMAPeriod + 50, 250);
        const candles = await this.ex.getKlines(this.config.pair, this.config.interval, needed);
        const a       = this._analyse(candles);
        const price   = a.price;

        this.log.debug('Trend tick', {
          price, trend: a.trend, cross: a.cross,
          rsi: a.rsi?.toFixed(1), adx: a.adx?.adx?.toFixed(1),
          fastMA: a.fastMA?.toFixed(2), slowMA: a.slowMA?.toFixed(2),
          volOk: a.volOk,
        });

        // Publish indicators to Redis for dashboard
        await this.cache.set(`trend:${this.config.pair}:indicators`, {
          price, ...a, ts: Date.now(),
        }, 120).catch(() => {});

        // ── Open position management ────────────────────────────────────────
        if (this.dbPos) {
          const sl     = parseFloat(this.dbPos.stop_loss_price);
          const tp     = parseFloat(this.dbPos.take_profit_price);
          const entry  = parseFloat(this.dbPos.entry_price);
          const side   = this.dbPos.side;
          const atr    = a.atr || (Math.abs(price - entry) / 2);

          // Trailing stop: move to break-even after 1x ATR profit
          if (!this._breakEvenMoved && a.atr) {
            const inProfit = side === 'LONG' ? price - entry : entry - price;
            if (inProfit >= atr * this.config.breakEvenATR) {
              const newSL = side === 'LONG' ? entry + atr * 0.1 : entry - atr * 0.1;
              this.dbPos.stop_loss_price = newSL;
              this._breakEvenMoved = true;
              await this.saveState('position', this.dbPos);
              await this.saveState('breakEvenMoved', true);
              this.log.info('Break-even stop moved', { newSL: newSL.toFixed(2), entry: entry.toFixed(2) });

              if (this.slOid) {
                await this.ex.cancelOrder(this.config.pair, this.slOid).catch(() => {});
                const qty = parseFloat(this.dbPos.quantity);
                const newSlOrder = await this.ex.setStopLoss(
                  this.config.pair, side === 'LONG' ? 'SELL' : 'BUY', qty, newSL
                );
                this.slOid = newSlOrder.orderId;
                await this.saveState('slOid', this.slOid);
              }
            }
          }

          const hitSL = side === 'LONG' ? price <= sl  : price >= sl;
          const hitTP = side === 'LONG' ? price >= tp  : price <= tp;
          const reversal = (a.cross === 'death' && side === 'LONG')
                        || (a.cross === 'golden' && side === 'SHORT' && this.config.allowShort);

          if (hitSL || hitTP || reversal) {
            const reason = hitSL ? 'stop_loss' : hitTP ? 'take_profit' : 'reversal';
            await this._exit(reason, price);

            // Immediately open opposite on reversal
            if (reversal && !hitSL && !hitTP) {
              const newSignal = a.cross === 'death' ? 'SHORT' : 'LONG';
              if (newSignal === 'SHORT' && !this.config.allowShort) {
                // no-op, just exited long
              } else {
                await this._enter(newSignal, a);
              }
            }
          } else {
            await this.markToMarket(this.dbPos.id, price);
          }

        // ── No position: look for entry ────────────────────────────────────
        } else {
          const signal = this._getEntrySignal(a);
          if (signal) {
            await this._enter(signal, a);
          }
        }

      } catch (err) {
        this.log.error('Tick error', { error: err.message });
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
  const bot = new TrendFollowingBot(CONFIG);
  process.on('SIGINT',  () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  bot.start();
}

module.exports = TrendFollowingBot;
