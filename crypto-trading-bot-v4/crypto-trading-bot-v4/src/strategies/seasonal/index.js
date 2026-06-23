'use strict';
/**
 * src/strategies/advanced/seasonal_bot.js
 *
 * Seasonal Buy-Low/Sell-High Bot.
 *
 * Strategy:
 *   1. On startup: ingest 3 years of OHLCV data → detect spikes → compute patterns.
 *   2. Every day: query seasonal_patterns for current month/week/DOW bias.
 *   3. Run path-similarity: find which prior year today's YTD path most resembles.
 *   4. If seasonally bullish + similar prior year was bullish: BUY dips.
 *   5. If seasonally bearish: reduce or short positions.
 *   6. Scale position size by signal_strength and confidence.
 *   7. Sell into seasonally strong months (high avg_return months that follow)
 *      or when z-score shows reversion complete.
 *
 * Known seasonal facts encoded as defaults (research-backed):
 *   - BTC: Oct, Nov, Dec historically strong (+20%, +46%, +7% avg)
 *   - BTC: Sep historically weakest (-4.9% avg)
 *   - BTC: Q4 avg +88% return across cycles
 *   - Best buy hours: 21:00-23:00 UTC (all markets closed)
 *   - 4-year halving cycle: accumulate in year 1 after halving (2025 = post-halving)
 */

require('dotenv').config();
const axios   = require('axios');
const crypto  = require('crypto');
const BaseBot = require('../../shared/base_bot');
const { HistoricalIngestion } = require('../seasonal/ingestion/index');
const { SeasonalEngine }      = require('../seasonal/engine');
const { db, cache }           = require('../../../infrastructure/db/database');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  id:      process.env.BOT_SEASONAL_ID || undefined,
  name:    'Seasonal Buy-Low/Sell-High Bot',
  botType: 'dca',
  dryRun:  process.env.DRY_RUN !== 'false',

  exchange: {
    name:      process.env.EXCHANGE_A_NAME || 'Exchange',
    baseUrl:   process.env.EXCHANGE_A_BASE_URL,
    apiKey:    process.env.EXCHANGE_A_API_KEY,
    apiSecret: process.env.EXCHANGE_A_API_SECRET,
    takerFee:  parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
  },

  pairs:          ['BTCUSDT','ETHUSDT'],
  interval:       '1d',
  baseAmountUSDT: parseFloat(process.env.DEFAULT_TRADE_AMOUNT_USDT || '100'),

  // Signal thresholds
  minSignalStrength:    0.5,    // seasonal_patterns.signal_strength >= this to trade
  minWinRate:           55,     // win_rate_pct >= this
  minBullishAvgReturn:  1.0,    // avg_return_pct >= 1% to consider bullish
  maxBearishAvgReturn: -0.5,    // avg_return_pct <= -0.5% to consider bearish

  // Path similarity — if current year path correlates > this with a prior year, use that year's pattern
  pathSimThreshold:     0.5,

  // Position sizing: scale base amount by signal strength
  maxPositionMultiplier:3.0,

  // DCA-style accumulation in bullish months
  dcaInBullishMonths:   true,
  dcaAmount:            50,     // extra USDT to add each day in strong bullish month

  // Take profit: sell portion when monthly return target hit
  monthlyTakeProfitPct: 15,

  // Re-run data ingestion every N hours (0 = only on startup)
  reingestionIntervalHours: 24,

  pollIntervalMs: 3_600_000,    // check every 1 hour
};

// ── EXCHANGE CLIENT (minimal, read-only + order) ──────────────────────────────
class ExchangeClient {
  constructor(cfg) {
    this.cfg  = cfg;
    this.http = axios.create({ baseURL: cfg.baseUrl, timeout: 10_000 });
  }
  _sign(q) { return crypto.createHmac('sha256', this.cfg.apiSecret).update(q).digest('hex'); }
  _auth(p = {}) {
    const ts = Date.now();
    const q  = new URLSearchParams({ ...p, timestamp: ts }).toString();
    return { params: { ...p, timestamp: ts, signature: this._sign(q) },
             headers: { 'X-API-KEY': this.cfg.apiKey } };
  }
  async getPrice(pair) {
    const r = await this.http.get('/api/v3/ticker/price', { params: { symbol: pair } });
    return parseFloat(r.data.price);
  }
  async getKlines(pair, interval, limit = 200) {
    const r = await this.http.get('/api/v3/klines', { params: { symbol: pair, interval, limit } });
    return r.data.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  }
  async marketBuy(pair, quoteQty) {
    if (this.cfg.dryRun) {
      const price = await this.getPrice(pair);
      return { orderId: `dry-${Date.now()}`, executedQty: quoteQty / price, executedPrice: price, status: 'FILLED' };
    }
    const r = await this.http.post('/api/v3/order', null, this._auth({
      symbol: pair, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty.toFixed(2),
    }));
    return r.data;
  }
  async marketSell(pair, quantity) {
    if (this.cfg.dryRun) {
      const price = await this.getPrice(pair);
      return { orderId: `dry-sell-${Date.now()}`, executedQty: quantity, executedPrice: price, status: 'FILLED' };
    }
    const r = await this.http.post('/api/v3/order', null, this._auth({
      symbol: pair, side: 'SELL', type: 'MARKET', quantity: quantity.toFixed(6),
    }));
    return r.data;
  }
}

// ── BOT ───────────────────────────────────────────────────────────────────────
class SeasonalBot extends BaseBot {
  constructor(config) {
    super(config);
    this.ex         = new ExchangeClient({ ...config.exchange, dryRun: config.dryRun });
    this.seasonal   = new SeasonalEngine();
    this.ingestion  = new HistoricalIngestion();

    // Accumulated position state per pair (for buy-low/sell-high tracking)
    this.holdings   = new Map(); // pair → { totalQty, totalCost, avgCostBasis, positionId, monthEntered }
    this.lastIngest  = null;
  }

  async onRestoreState(state) {
    if (state.holdings) {
      for (const [pair, h] of Object.entries(state.holdings)) {
        this.holdings.set(pair, h);
      }
      this.log.info('Restored holdings', Object.fromEntries(this.holdings));
    }
    if (state.lastIngest) this.lastIngest = new Date(state.lastIngest);
  }

  // ── Data pipeline ──────────────────────────────────────────────────────────
  async ensureDataFresh() {
    const now      = Date.now();
    const interval = this.config.reingestionIntervalHours * 3_600_000;

    if (this.lastIngest && (now - this.lastIngest.getTime()) < interval) {
      this.log.debug('Historical data is fresh, skipping ingestion');
      return;
    }

    this.log.info('Running historical data ingestion...');
    await this.ingestion.run();
    this.log.info('Computing seasonal patterns...');
    await this.seasonal.computeAll();

    this.lastIngest = new Date();
    await this.saveState('lastIngest', this.lastIngest.toISOString());
  }

  // ── Decide action for a pair ───────────────────────────────────────────────
  async decidePair(pair) {
    const now     = new Date();
    const month   = now.getMonth() + 1;
    const price   = await this.ex.getPrice(pair);

    // Get comprehensive seasonal context
    const bias    = await this.seasonal.getCurrentBias(pair, this.config.interval);
    const windows = await this.seasonal.getBestEntryWindows(pair, this.config.interval);
    const accMonths = await this.seasonal.getAccumulationMonths(pair);
    const spikeStats= await this.seasonal.getSpikeReversionStats(pair, month, '1d');
    const pathSim  = bias.pathSimilarity;

    // Current month pattern
    const monthPattern = windows.find(w => parseInt(w.month) === month);

    // What year does YTD most resemble?
    const bestSim = pathSim?.similarities?.sort((a, b) => b.simScore - a.simScore)[0];
    const similarYear = bestSim?.simScore >= this.config.pathSimThreshold ? bestSim.year : null;

    const signal = bias.signal;

    this.log.info(`${pair} seasonal analysis`, {
      month,
      monthAvgReturn: monthPattern?.avg_return_pct,
      monthWinRate:   monthPattern?.win_rate_pct,
      signalStrength: monthPattern?.signal_strength,
      compositeSignal:signal,
      mostSimilarYear:similarYear,
      pathSimScore:   bestSim?.simScore?.toFixed(3),
    });

    // ── Decision logic ─────────────────────────────────────────────────────────

    // 1. Strong bullish month + high win rate + sufficient signal strength → BUY
    const isBullishMonth =
      monthPattern &&
      parseFloat(monthPattern.avg_return_pct) >= this.config.minBullishAvgReturn &&
      parseFloat(monthPattern.win_rate_pct)   >= this.config.minWinRate &&
      parseFloat(monthPattern.signal_strength) >= this.config.minSignalStrength;

    // 2. Current month is an accumulation month (dip before rally)
    const isAccumulationMonth = accMonths.some(r => parseInt(r.month) === month);

    // 3. Composite signal is bullish
    const compositeBullish = signal.direction === 'bullish' && signal.confidence >= 0.3;

    // 4. Prior similar year had a rally in this period
    const historicalBullish = similarYear && await this._wasYearBullishHere(pair, similarYear, month);

    // 5. Bearish: historically worst months (Sep typical, may vary by year)
    const isBearishMonth =
      monthPattern &&
      parseFloat(monthPattern.avg_return_pct) <= this.config.maxBearishAvgReturn &&
      parseFloat(monthPattern.win_rate_pct)   <= 45 &&
      monthPattern.bearish_bias;

    // ── Size the position ──────────────────────────────────────────────────────
    const strengthMultiplier = monthPattern
      ? Math.min(parseFloat(monthPattern.signal_strength) * this.config.maxPositionMultiplier, this.config.maxPositionMultiplier)
      : 1;
    const buyAmount = this.config.baseAmountUSDT * strengthMultiplier;

    return {
      pair, price, month, monthPattern, signal, similarYear,
      action: isBearishMonth && !isBullishMonth ? 'REDUCE'
            : (isBullishMonth || compositeBullish || isAccumulationMonth || historicalBullish) ? 'BUY'
            : 'HOLD',
      buyAmount,
      isAccumulationMonth,
      isBullishMonth,
      isBearishMonth,
      spikeStats,
      strengthMultiplier,
    };
  }

  async _wasYearBullishHere(pair, year, month) {
    const res = await db.query(
      `SELECT AVG(close - open) / AVG(open) * 100 AS avg_monthly_return
       FROM ohlcv
       WHERE pair = $1 AND interval = '1d'
         AND EXTRACT(YEAR FROM open_time) = $2
         AND EXTRACT(MONTH FROM open_time) = $3`,
      [pair, year, month]
    );
    return parseFloat(res.rows[0]?.avg_monthly_return || 0) > 0;
  }

  // ── Execute buy ───────────────────────────────────────────────────────────
  async executeBuy(decision) {
    const { pair, price, buyAmount, monthPattern, signal } = decision;

    this.log.info(`Seasonal BUY: ${pair}`, {
      price, buyAmount,
      monthAvgReturn: monthPattern?.avg_return_pct,
      signal: signal.direction,
      confidence: signal.confidence,
    });

    const order = await this.placeOrder({
      exchange: this.ex.cfg.name, pair, side: 'BUY',
      type: 'MARKET', quantity: buyAmount / price, quoteQty: buyAmount,
      execute: () => this.ex.marketBuy(pair, buyAmount),
    });

    const execQty   = parseFloat(order.response.executedQty);
    const execPrice = parseFloat(order.response.executedPrice || price);
    const existing  = this.holdings.get(pair);

    let positionId = existing?.positionId;
    if (!positionId) {
      // Open new position in DB
      const pos = await this.openPosition({
        pair, side: 'LONG', quantity: execQty,
        entryPrice: execPrice,
        entryOrderId: order.id,
        metadata: {
          strategy:       'seasonal',
          monthEntered:   decision.month,
          signal:         signal.direction,
          confidence:     signal.confidence,
          monthAvgReturn: monthPattern?.avg_return_pct,
          winRate:        monthPattern?.win_rate_pct,
        },
      });
      positionId = pos.id;
    }

    // Update holding state
    const prevQty  = existing?.totalQty  || 0;
    const prevCost = existing?.totalCost || 0;
    const newQty   = prevQty  + execQty;
    const newCost  = prevCost + buyAmount;

    this.holdings.set(pair, {
      positionId,
      totalQty:       newQty,
      totalCost:      newCost,
      avgCostBasis:   newCost / newQty,
      monthEntered:   decision.month,
      lastBuyPrice:   execPrice,
      lastBuyTime:    new Date().toISOString(),
    });

    // Log DCA purchase
    await db.insertDCAPurchase({
      botId:       this.botId,
      asset:       pair.replace('USDT',''),
      pair,
      quantity:    execQty,
      priceUsdt:   execPrice,
      costUsdt:    buyAmount,
      multiplier:  decision.strengthMultiplier,
      orderId:     order.id,
    }).catch(() => {});

    // Log seasonal trade
    await db.query(
      `INSERT INTO seasonal_trades
         (bot_id, position_id, pair, signal_month, pattern_strength, seasonal_bias, entry_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        this.botId, positionId, pair, decision.month,
        monthPattern?.signal_strength, signal.direction, execPrice,
      ]
    ).catch(() => {});

    await this.saveState('holdings', Object.fromEntries(this.holdings));
  }

  // ── Execute sell/reduce ───────────────────────────────────────────────────
  async executeReduce(pair, reason, targetPct = 0.5) {
    const holding = this.holdings.get(pair);
    if (!holding || holding.totalQty <= 0) return;

    const price   = await this.ex.getPrice(pair);
    const sellQty = holding.totalQty * targetPct;

    this.log.info(`Seasonal SELL: ${pair}`, { reason, price, sellQty, targetPct });

    const order = await this.placeOrder({
      exchange: this.ex.cfg.name, pair, side: 'SELL',
      type: 'MARKET', quantity: sellQty,
      execute: () => this.ex.marketSell(pair, sellQty),
    });

    const execPrice  = parseFloat(order.response.executedPrice || price);
    const costBasis  = holding.avgCostBasis;
    const rawPnl     = (execPrice - costBasis) * sellQty;
    const fees       = this.ex.cfg.takerFee / 100 * sellQty * execPrice * 2;
    const netPnl     = rawPnl - fees;

    if (targetPct >= 1.0 && holding.positionId) {
      await this.closePosition({
        positionId:   holding.positionId,
        exitPrice:    execPrice,
        exitOrderId:  order.id,
        realizedPnl:  rawPnl,
        feeTotal:     fees,
        netPnl,
        reason,
      });
      this.holdings.delete(pair);
    } else {
      // Partial sell
      const remaining = holding.totalQty - sellQty;
      this.holdings.set(pair, {
        ...holding,
        totalQty:   remaining,
        totalCost:  holding.avgCostBasis * remaining,
      });
    }

    await this.saveState('holdings', Object.fromEntries(this.holdings));
    this.log.info(`${pair} reduce done`, { pnl: netPnl.toFixed(4), reason });
  }

  // ── Check take-profit ─────────────────────────────────────────────────────
  async checkTakeProfit(pair) {
    const holding = this.holdings.get(pair);
    if (!holding) return;

    const price   = await this.ex.getPrice(pair);
    const returnPct = ((price - holding.avgCostBasis) / holding.avgCostBasis) * 100;

    if (returnPct >= this.config.monthlyTakeProfitPct) {
      this.log.info(`${pair} take-profit triggered`, { returnPct: returnPct.toFixed(2) });
      await this.executeReduce(pair, 'take_profit', 0.5); // sell 50% on TP
    }
  }

  // ── Daily DCA accumulation in bullish months ───────────────────────────────
  async dcaAccumulate(pair, decision) {
    if (!this.config.dcaInBullishMonths) return;
    if (!decision.isBullishMonth) return;

    const price = decision.price;
    const dcaAmt= this.config.dcaAmount;

    this.log.debug(`${pair} DCA accumulation`, { amount: dcaAmt, price });

    const order = await this.placeOrder({
      exchange: this.ex.cfg.name, pair, side: 'BUY',
      type: 'MARKET', quantity: dcaAmt / price, quoteQty: dcaAmt,
      execute: () => this.ex.marketBuy(pair, dcaAmt),
    });

    const execQty    = parseFloat(order.response.executedQty);
    const execPrice  = parseFloat(order.response.executedPrice || price);
    const existing   = this.holdings.get(pair);

    const newQty  = (existing?.totalQty  || 0) + execQty;
    const newCost = (existing?.totalCost || 0) + dcaAmt;

    this.holdings.set(pair, {
      ...(existing || {}),
      totalQty:     newQty,
      totalCost:    newCost,
      avgCostBasis: newCost / newQty,
      lastBuyPrice: execPrice,
      lastBuyTime:  new Date().toISOString(),
    });

    await db.insertDCAPurchase({
      botId: this.botId, asset: pair.replace('USDT',''), pair,
      quantity: execQty, priceUsdt: execPrice, costUsdt: dcaAmt,
      multiplier: 1.0, orderId: order.id,
    }).catch(() => {});

    await this.saveState('holdings', Object.fromEntries(this.holdings));
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async run() {
    this.log.info('Seasonal Bot started', {
      pairs: this.config.pairs,
      minStrength: this.config.minSignalStrength,
      pathSimThreshold: this.config.pathSimThreshold,
    });

    // Initial data pipeline
    await this.ensureDataFresh().catch(e =>
      this.log.warn('Initial ingestion failed', { error: e.message })
    );

    while (this.running && !this.stopping) {
      if (!await this.riskCheck()) break;

      // Periodically refresh data
      await this.ensureDataFresh().catch(e =>
        this.log.warn('Periodic ingestion failed', { error: e.message })
      );

      for (const pair of this.config.pairs) {
        try {
          const decision = await this.decidePair(pair);

          // Take-profit check regardless of action
          await this.checkTakeProfit(pair);

          if (decision.action === 'BUY') {
            // Only buy if we don't already have a full position
            const holding = this.holdings.get(pair);
            const alreadyHeavy = holding && holding.totalCost >= this.config.baseAmountUSDT * this.config.maxPositionMultiplier;

            if (!alreadyHeavy) {
              await this.executeBuy(decision);
            } else if (decision.isAccumulationMonth) {
              await this.dcaAccumulate(pair, decision);
            }

          } else if (decision.action === 'REDUCE') {
            const holding = this.holdings.get(pair);
            if (holding && holding.totalQty > 0) {
              await this.executeReduce(pair, 'seasonal_bearish_month', 1.0);
            }
          }

          // Log current state for monitoring
          const holding = this.holdings.get(pair);
          if (holding) {
            const price      = decision.price;
            const currentVal = holding.totalQty * price;
            const returnPct  = ((price - holding.avgCostBasis) / holding.avgCostBasis) * 100;
            this.log.info(`${pair} holding`, {
              qty:          holding.totalQty.toFixed(6),
              avgCost:      holding.avgCostBasis.toFixed(2),
              currentPrice: price,
              currentValue: currentVal.toFixed(2),
              returnPct:    returnPct.toFixed(2),
            });
          }

        } catch (err) {
          this.log.error(`Error processing ${pair}`, { error: err.message });
        }

        await this.sleepInterruptible(5000);
      }

      await this.sleepInterruptible(this.config.pollIntervalMs);
    }

    // Close all on shutdown
    for (const [pair] of this.holdings) {
      await this.executeReduce(pair, 'bot_shutdown', 1.0).catch(e =>
        this.log.error(`Failed to close ${pair}`, { error: e.message })
      );
    }
  }
}

if (require.main === module) {
  const bot = new SeasonalBot(CONFIG);
  process.on('SIGINT',  () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  bot.start();
}

module.exports = SeasonalBot;
