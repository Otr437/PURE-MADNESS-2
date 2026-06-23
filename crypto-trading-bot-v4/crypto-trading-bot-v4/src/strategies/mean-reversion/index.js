'use strict';
/**
 * src/strategies/advanced/mean_reversion_bot.js
 *
 * Mean Reversion Bot — buys oversold, sells overbought.
 * Uses Z-score, Bollinger Bands, RSI divergence, MACD divergence.
 * Integrates seasonal engine to ONLY trade in seasonally-supported direction.
 * Includes full DB persistence via BaseBot.
 */

require('dotenv').config();
const axios    = require('axios');
const crypto   = require('crypto');
const BaseBot  = require('../../shared/base_bot');
const { SeasonalEngine } = require('../seasonal/engine');
const { db }   = require('../../../infrastructure/db/database');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  id:      process.env.BOT_MR_ID || undefined,
  name:    'Mean Reversion Bot',
  botType: 'trend_following', // reuse closest enum
  dryRun:  process.env.DRY_RUN !== 'false',

  exchange: {
    name:       process.env.EXCHANGE_A_NAME || 'Exchange',
    baseUrl:    process.env.EXCHANGE_A_BASE_URL,
    apiKey:     process.env.EXCHANGE_A_API_KEY,
    apiSecret:  process.env.EXCHANGE_A_API_SECRET,
    takerFee:   parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
  },

  pairs:          ['BTCUSDT','ETHUSDT','SOLUSDT'],
  interval:       '4h',
  tradeAmountUSDT:parseFloat(process.env.DEFAULT_TRADE_AMOUNT_USDT || '200'),

  // Z-score thresholds
  zScoreEntry:    -2.0,  // buy when z-score <= this (oversold)
  zScoreExit:      0.0,  // exit when z-score >= 0 (mean reversion complete)
  zScoreShort:     2.0,  // sell short when z-score >= this (overbought)
  zScorePeriod:   20,    // rolling window for mean/std

  // Bollinger Bands
  bbPeriod:       20,
  bbStdDev:       2.0,

  // RSI
  rsiPeriod:      14,
  rsiOversold:    30,
  rsiOverbought:  70,

  // MACD
  macdFast:       12,
  macdSlow:       26,
  macdSignal:     9,

  // Require seasonal alignment before entering
  requireSeasonalAlignment: true,
  minSeasonalConfidence:    0.3,

  // Risk
  atrPeriod:           14,
  atrStopMultiplier:   2.5,
  maxOpenPositions:    3,
  riskRewardRatio:     2.0,
  allowShort:          false,

  pollIntervalMs:      300_000, // 5 min
};

// ── INDICATORS ────────────────────────────────────────────────────────────────
const Ind = {
  sma: (arr, n) => {
    if (arr.length < n) return null;
    return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
  },
  ema: (arr, n) => {
    if (arr.length < n) return null;
    const k = 2 / (n + 1);
    let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  },
  std: (arr, n) => {
    const s = arr.slice(-n);
    const m = s.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(s.reduce((a, b) => a + Math.pow(b - m, 2), 0) / n);
  },
  zScore: (price, arr, n) => {
    const mean = Ind.sma(arr.slice(-n - 1, -1), n);
    const std  = Ind.std(arr.slice(-n - 1, -1), n);
    if (!mean || std === 0) return null;
    return (price - mean) / std;
  },
  rsi: (closes, n = 14) => {
    if (closes.length < n + 1) return null;
    const s = closes.slice(-(n + 1));
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) {
      const d = s[i] - s[i-1];
      d > 0 ? (g += d) : (l += Math.abs(d));
    }
    const rs = (g / n) / ((l / n) || 1e-10);
    return 100 - 100 / (1 + rs);
  },
  macd: (closes, fast = 12, slow = 26, signal = 9) => {
    if (closes.length < slow + signal) return null;
    const macdLine   = Ind.ema(closes, fast) - Ind.ema(closes, slow);
    // Build MACD line history for signal EMA
    const macdHist   = [];
    for (let i = slow; i <= closes.length; i++) {
      const f = Ind.ema(closes.slice(0, i), fast);
      const s = Ind.ema(closes.slice(0, i), slow);
      if (f != null && s != null) macdHist.push(f - s);
    }
    const signalLine = Ind.ema(macdHist, signal);
    const histogram  = macdLine - (signalLine || 0);
    return { macdLine, signalLine, histogram, macdHist };
  },
  atr: (candles, n = 14) => {
    if (candles.length < n + 1) return null;
    const s   = candles.slice(-(n + 1));
    const trs = [];
    for (let i = 1; i < s.length; i++) {
      trs.push(Math.max(
        s[i].high - s[i].low,
        Math.abs(s[i].high - s[i-1].close),
        Math.abs(s[i].low  - s[i-1].close)
      ));
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  },
  bollingerBands: (closes, n = 20, k = 2) => {
    const mid   = Ind.sma(closes, n);
    const sigma = Ind.std(closes, n);
    if (!mid || !sigma) return null;
    const upper = mid + k * sigma;
    const lower = mid - k * sigma;
    const price = closes[closes.length - 1];
    const bbPct = sigma > 0 ? (price - lower) / (upper - lower) : 0.5;
    return { upper, mid, lower, sigma, bbPct };
  },
  // Detect RSI divergence: price makes lower low but RSI makes higher low
  rsiDivergence: (closes, rsiValues, lookback = 5) => {
    if (closes.length < lookback + 1 || rsiValues.length < lookback + 1) return null;
    const priceSlice = closes.slice(-lookback - 1);
    const rsiSlice   = rsiValues.slice(-lookback - 1);
    const priceMin   = Math.min(...priceSlice.slice(0, -1));
    const priceNow   = priceSlice[priceSlice.length - 1];
    const rsiMin     = Math.min(...rsiSlice.slice(0, -1));
    const rsiNow     = rsiSlice[rsiSlice.length - 1];
    // Bullish divergence: lower price low, higher RSI low
    if (priceNow <= priceMin && rsiNow > rsiMin) return 'bullish';
    // Bearish divergence: higher price high, lower RSI high
    if (priceNow >= priceMin && rsiNow < rsiMin) return 'bearish';
    return null;
  },
};

// ── EXCHANGE CLIENT ───────────────────────────────────────────────────────────
class ExchangeClient {
  constructor(cfg) {
    this.cfg  = cfg;
    this.http = axios.create({ baseURL: cfg.baseUrl, timeout: 8000 });
  }
  _sign(q) { return crypto.createHmac('sha256', this.cfg.apiSecret).update(q).digest('hex'); }
  _auth(p = {}) {
    const ts = Date.now();
    const q  = new URLSearchParams({ ...p, timestamp: ts }).toString();
    return { params: { ...p, timestamp: ts, signature: this._sign(q) },
             headers: { 'X-API-KEY': this.cfg.apiKey } };
  }
  async getKlines(pair, interval, limit = 200) {
    const r = await this.http.get('/api/v3/klines', { params: { symbol: pair, interval, limit } });
    return r.data.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  }
  async getPrice(pair) {
    const r = await this.http.get('/api/v3/ticker/price', { params: { symbol: pair } });
    return parseFloat(r.data.price);
  }
  async marketOrder(pair, side, quoteQty) {
    if (this.cfg.dryRun) {
      const price = await this.getPrice(pair);
      return { orderId: `dry-${Date.now()}`, executedQty: quoteQty / price, executedPrice: price, status: 'FILLED' };
    }
    const r = await this.http.post('/api/v3/order', null, this._auth({
      symbol: pair, side: side.toUpperCase(), type: 'MARKET', quoteOrderQty: quoteQty.toFixed(2),
    }));
    return r.data;
  }
  async setStopLoss(pair, side, qty, stopPrice) {
    if (this.cfg.dryRun) return { orderId: `dry-sl-${Date.now()}` };
    const r = await this.http.post('/api/v3/order', null, this._auth({
      symbol: pair, side: side.toUpperCase(), type: 'STOP_MARKET',
      stopPrice: stopPrice.toFixed(2), quantity: qty.toFixed(6), timeInForce: 'GTE_GTC',
    }));
    return r.data;
  }
}

// ── BOT ───────────────────────────────────────────────────────────────────────
class MeanReversionBot extends BaseBot {
  constructor(config) {
    super({ ...config, name: config.name || 'Mean Reversion Bot', botType: 'trend_following' });
    this.ex             = new ExchangeClient({ ...config.exchange, dryRun: config.dryRun });
    this.seasonal       = new SeasonalEngine();
    this.openByPair     = new Map(); // pair → { positionId, side, entryPrice, qty, slOrderId }
    this.rsiHistory     = new Map(); // pair → recent RSI values for divergence
  }

  async onRestoreState(state) {
    if (state.openByPair) {
      for (const [pair, pos] of Object.entries(state.openByPair)) {
        this.openByPair.set(pair, pos);
      }
    }
  }

  // ── Analyse a single pair ──────────────────────────────────────────────────
  async analysePair(pair) {
    const candles = await this.ex.getKlines(pair, this.config.interval, 200);
    if (candles.length < 50) return null;

    const closes = candles.map(c => c.close);
    const price  = closes[closes.length - 1];
    const atr    = Ind.atr(candles, this.config.atrPeriod);
    const rsi    = Ind.rsi(closes, this.config.rsiPeriod);
    const bb     = Ind.bollingerBands(closes, this.config.bbPeriod, this.config.bbStdDev);
    const macd   = Ind.macd(closes, this.config.macdFast, this.config.macdSlow, this.config.macdSignal);
    const zScore = Ind.zScore(price, closes, this.config.zScorePeriod);

    // Track RSI history for divergence detection
    if (!this.rsiHistory.has(pair)) this.rsiHistory.set(pair, []);
    const rsiHist = this.rsiHistory.get(pair);
    if (rsi != null) { rsiHist.push(rsi); if (rsiHist.length > 20) rsiHist.shift(); }
    const divergence = rsiHist.length >= 6 ? Ind.rsiDivergence(closes, rsiHist, 5) : null;

    // Seasonal context
    const seasonal = await this.seasonal.getCurrentBias(pair, this.config.interval);

    return {
      pair, price, atr, rsi, bb, macd, zScore, divergence,
      seasonal, candles,
    };
  }

  // ── Signal logic ──────────────────────────────────────────────────────────
  getSignal(analysis) {
    const { zScore, rsi, bb, macd, divergence, seasonal } = analysis;
    if (zScore == null || rsi == null || !bb) return null;

    const seasonalDir  = seasonal?.signal?.direction || 'neutral';
    const seasonalConf = seasonal?.signal?.confidence || 0;

    // If seasonal alignment required, skip conflicting signals
    const seasonalOk = (dir) => {
      if (!this.config.requireSeasonalAlignment) return true;
      if (seasonalConf < this.config.minSeasonalConfidence) return true; // weak signal = don't filter
      if (dir === 'long'  && seasonalDir === 'bearish') return false;
      if (dir === 'short' && seasonalDir === 'bullish') return false;
      return true;
    };

    // ── LONG signal: price deeply oversold, multiple confirmations ────────────
    const longConditions = {
      zScore:      zScore <= this.config.zScoreEntry,           // price far below mean
      bbOversold:  bb.bbPct <= 0.1,                             // below lower BB
      rsiOversold: rsi <= this.config.rsiOversold,              // RSI oversold
      macdBullish: macd && macd.histogram > 0,                  // MACD histogram turning up
      divergence:  divergence === 'bullish',                     // RSI bullish divergence (bonus)
    };

    // Need at least 3 of the 4 primary conditions (divergence is bonus)
    const longPrimary = [longConditions.zScore, longConditions.bbOversold, longConditions.rsiOversold, longConditions.macdBullish];
    const longScore   = longPrimary.filter(Boolean).length + (longConditions.divergence ? 0.5 : 0);

    if (longScore >= 3 && seasonalOk('long')) {
      const confidence = longScore / 4.5;
      return { direction: 'LONG', confidence, conditions: longConditions, zScore, rsi, bbPct: bb.bbPct };
    }

    // ── SHORT signal ──────────────────────────────────────────────────────────
    if (this.config.allowShort) {
      const shortConditions = {
        zScore:       zScore >= this.config.zScoreShort,
        bbOverbought: bb.bbPct >= 0.9,
        rsiOverbought:rsi >= this.config.rsiOverbought,
        macdBearish:  macd && macd.histogram < 0,
        divergence:   divergence === 'bearish',
      };
      const shortPrimary = [shortConditions.zScore, shortConditions.bbOverbought, shortConditions.rsiOverbought, shortConditions.macdBearish];
      const shortScore   = shortPrimary.filter(Boolean).length + (shortConditions.divergence ? 0.5 : 0);

      if (shortScore >= 3 && seasonalOk('short')) {
        return { direction: 'SHORT', confidence: shortScore / 4.5, conditions: shortConditions, zScore, rsi, bbPct: bb.bbPct };
      }
    }

    return null;
  }

  // ── Check exit for open position ──────────────────────────────────────────
  shouldExit(pairState, analysis) {
    const { zScore, rsi, bb, price } = analysis;
    const { side, entryPrice }       = pairState;

    if (side === 'LONG') {
      // Exit when z-score returns to mean (0), OR RSI overbought, OR BB mid crossed
      if (zScore != null && zScore >= this.config.zScoreExit)    return 'zscore_mean_reversion';
      if (rsi != null && rsi >= 60)                               return 'rsi_recovered';
      if (bb && bb.bbPct >= 0.5)                                  return 'bb_mid_reversion';
      if (price <= entryPrice * (1 - this.config.atrStopMultiplier * 0.01)) return 'stop_loss';
    } else if (side === 'SHORT') {
      if (zScore != null && zScore <= this.config.zScoreExit)    return 'zscore_mean_reversion';
      if (rsi != null && rsi <= 40)                               return 'rsi_recovered';
      if (bb && bb.bbPct <= 0.5)                                  return 'bb_mid_reversion';
    }
    return null;
  }

  // ── Open position ─────────────────────────────────────────────────────────
  async enterPosition(pair, signal, analysis) {
    const { price, atr } = analysis;
    const qty = this.config.tradeAmountUSDT / price;
    const isLong = signal.direction === 'LONG';

    // Calculate stops
    const stopLoss   = isLong
      ? price - atr * this.config.atrStopMultiplier
      : price + atr * this.config.atrStopMultiplier;
    const riskUsdt   = Math.abs(price - stopLoss) * qty;
    const takeProfit = isLong
      ? price + riskUsdt * this.config.riskRewardRatio / qty
      : price - riskUsdt * this.config.riskRewardRatio / qty;

    const entrySide = isLong ? 'BUY' : 'SELL';

    this.log.info(`MR Entry: ${signal.direction} ${pair}`, {
      price, zScore: signal.zScore?.toFixed(3),
      rsi: signal.rsi?.toFixed(1), confidence: signal.confidence?.toFixed(3),
      stopLoss: stopLoss.toFixed(2), takeProfit: takeProfit.toFixed(2),
      seasonal: analysis.seasonal?.signal,
    });

    const order = await this.placeOrder({
      exchange: this.ex.cfg.name, pair, side: entrySide,
      type: 'MARKET', quantity: qty,
      execute: () => this.ex.marketOrder(pair, entrySide, this.config.tradeAmountUSDT),
    });

    const slOrder = await this.ex.setStopLoss(pair, isLong ? 'SELL' : 'BUY', qty, stopLoss);

    const pos = await this.openPosition({
      pair, side: signal.direction, quantity: qty,
      entryPrice: price, stopLossPrice: stopLoss, takeProfitPrice: takeProfit,
      entryOrderId: order.id,
      metadata: { zScore: signal.zScore, rsi: signal.rsi, confidence: signal.confidence, seasonal: analysis.seasonal?.signal },
    });

    this.openByPair.set(pair, {
      positionId: pos.id, side: signal.direction,
      entryPrice: price, quantity: qty, slOrderId: slOrder.orderId,
      takeProfit, stopLoss,
    });

    // Log signal
    await db.query(
      `INSERT INTO mean_reversion_signals
         (bot_id, pair, direction, price, sma, std_dev, z_score, rsi, bb_upper, bb_lower, bb_pct, acted_on, position_id, revert_target, pct_to_mean)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$14)`,
      [
        this.botId, pair, entrySide, price,
        analysis.bb?.mid, analysis.bb?.sigma, signal.zScore, signal.rsi,
        analysis.bb?.upper, analysis.bb?.lower, signal.bbPct,
        pos.id,
        analysis.bb?.mid,
        analysis.bb?.mid ? Math.abs((price - analysis.bb.mid) / price * 100) : null,
      ]
    ).catch(() => {});

    await this.saveState('openByPair', Object.fromEntries(this.openByPair));
  }

  // ── Close position ────────────────────────────────────────────────────────
  async exitPosition(pair, reason, analysis) {
    const state = this.openByPair.get(pair);
    if (!state) return;

    const { positionId, side, quantity, entryPrice, slOrderId } = state;
    const exitPrice = analysis.price;
    const exitSide  = side === 'LONG' ? 'SELL' : 'BUY';
    const isLong    = side === 'LONG';

    // Cancel stop loss
    if (slOrderId && !this.config.dryRun) {
      await this.ex.http.delete('/api/v3/order',
        this.ex._auth({ symbol: pair, orderId: slOrderId })
      ).catch(() => {});
    }

    const exitOrder = await this.placeOrder({
      exchange: this.ex.cfg.name, pair, side: exitSide,
      type: 'MARKET', quantity,
      execute: () => this.ex.marketOrder(pair, exitSide, quantity * exitPrice),
    });

    const rawPnl = isLong
      ? (exitPrice - entryPrice) * quantity
      : (entryPrice - exitPrice) * quantity;
    const fees   = this.ex.cfg.takerFee / 100 * this.config.tradeAmountUSDT * 2;
    const netPnl = rawPnl - fees;

    await this.closePosition({
      positionId, exitPrice, exitOrderId: exitOrder.id,
      realizedPnl: rawPnl, feeTotal: fees, netPnl, reason,
    });

    this.log.info(`MR Exit: ${side} ${pair}`, { exitPrice, netPnl: netPnl.toFixed(4), reason });
    this.openByPair.delete(pair);
    await this.saveState('openByPair', Object.fromEntries(this.openByPair));
  }

  // ── Main run loop ─────────────────────────────────────────────────────────
  async run() {
    this.log.info('Mean Reversion Bot started', {
      pairs: this.config.pairs, interval: this.config.interval,
      zEntry: this.config.zScoreEntry, seasonal: this.config.requireSeasonalAlignment,
    });

    while (this.running && !this.stopping) {
      if (!await this.riskCheck()) break;

      for (const pair of this.config.pairs) {
        try {
          const analysis = await this.analysePair(pair);
          if (!analysis) continue;

          const openPos = this.openByPair.get(pair);

          if (openPos) {
            // Check exit
            const exitReason = this.shouldExit(openPos, analysis);
            if (exitReason) {
              await this.exitPosition(pair, exitReason, analysis);
            } else {
              // Update unrealised PnL
              await this.markToMarket(openPos.positionId, analysis.price);
            }
          } else {
            // Check entry
            if (this.openByPair.size >= this.config.maxOpenPositions) continue;

            const signal = this.getSignal(analysis);
            if (signal) {
              this.log.info(`MR Signal: ${signal.direction} ${pair}`, {
                zScore: signal.zScore?.toFixed(3), confidence: signal.confidence?.toFixed(3),
                seasonal: analysis.seasonal?.signal?.direction,
              });
              await this.enterPosition(pair, signal, analysis);
            }
          }
        } catch (err) {
          this.log.error(`Error processing ${pair}`, { error: err.message });
        }

        await this.sleepInterruptible(2000); // 2s between pairs
      }

      await this.sleepInterruptible(this.config.pollIntervalMs);
    }

    // Close all positions on shutdown
    for (const [pair] of this.openByPair) {
      try {
        const analysis = await this.analysePair(pair);
        if (analysis) await this.exitPosition(pair, 'bot_shutdown', analysis);
      } catch (e) {
        this.log.error(`Failed to close ${pair} on shutdown`, { error: e.message });
      }
    }
  }
}

if (require.main === module) {
  const bot = new MeanReversionBot(CONFIG);
  process.on('SIGINT',  () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  bot.start();
}

module.exports = MeanReversionBot;
