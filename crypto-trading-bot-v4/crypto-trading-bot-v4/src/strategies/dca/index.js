'use strict';
/**
 * STRATEGY: Dollar-Cost Averaging (Enhanced DCA)
 *
 * Business logic:
 *   - Buys on a fixed cron schedule (default: Monday 9am)
 *   - Enhanced DCA: multiplies buy amount when price is below N-period SMA
 *     — 5% below SMA → 1.5x, 10% below → 2x, 20% below → 3x
 *   - Multi-asset: independently manages BTC, ETH, SOL simultaneously
 *   - Tracks cost basis, unrealised P&L, and total invested per asset in DB
 *   - Portfolio summary logged after each cycle (cost basis vs current price)
 *   - Skips a buy if daily loss limit already breached (no accumulation into drawdown)
 *   - Buy confirmation: validates SMA is from enough data points (>= period)
 *   - Records SMA at purchase time for retrospective analysis
 *
 * Run: node src/strategies/dca/index.js
 */

require('dotenv').config();
const cron           = require('node-cron');
const BaseBot        = require('../../shared/base_bot');
const ExchangeClient = require('../../shared/exchange_client');
const Indicators     = require('../../shared/indicators');

const CONFIG = {
  id:      process.env.BOT_DCA_ID || undefined,
  name:    'DCA Bot',
  botType: 'dca',
  dryRun:  process.env.DRY_RUN !== 'false',

  // Cron schedule — default every Monday at 9am
  schedule: process.env.DCA_SCHEDULE || '0 9 * * 1',

  globalStopLossPct: parseFloat(process.env.GLOBAL_STOP_LOSS_PERCENT || '10'),

  assets: [
    {
      pair:       'BTCUSDT',
      asset:      'BTC',
      amountUSDT: parseFloat(process.env.DCA_BTC_AMOUNT || '50'),
    },
    {
      pair:       'ETHUSDT',
      asset:      'ETH',
      amountUSDT: parseFloat(process.env.DCA_ETH_AMOUNT || '30'),
    },
    {
      pair:       'SOLUSDT',
      asset:      'SOL',
      amountUSDT: parseFloat(process.env.DCA_SOL_AMOUNT || '20'),
    },
  ],

  enhancedDCA: {
    enabled:   process.env.DCA_ENHANCED !== 'false',
    smaPeriod: parseInt(process.env.DCA_SMA_PERIOD || '50'),
    // Price drop below SMA → apply this multiplier to base amount
    dips: [
      { dropPercent:  5, multiplier: 1.5 },
      { dropPercent: 10, multiplier: 2.0 },
      { dropPercent: 15, multiplier: 2.5 },
      { dropPercent: 20, multiplier: 3.0 },
    ],
    // Cap total multiplied amount as % of base to prevent over-exposure
    maxMultiplier: parseFloat(process.env.DCA_MAX_MULTIPLIER || '3.0'),
  },

  // Minimum portfolio size before logging unrealised PnL (avoid noise on tiny balances)
  minPortfolioForPnLLog: 20,

  exchange: {
    name:            process.env.EXCHANGE_A_NAME    || 'Exchange',
    baseUrl:         process.env.EXCHANGE_A_BASE_URL,
    apiKey:          process.env.EXCHANGE_A_API_KEY,
    apiSecret:       process.env.EXCHANGE_A_API_SECRET,
    takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
  },
};

class DCABot extends BaseBot {
  constructor(cfg) {
    super(cfg);
    this.ex  = new ExchangeClient({ ...cfg.exchange, dryRun: cfg.dryRun });
    this.job = null;
  }

  // ── Calculate buy multiplier based on SMA dip depth ───────────────────────
  async _getMultiplier(pair, currentPrice) {
    const { enabled, smaPeriod, dips, maxMultiplier } = this.config.enhancedDCA;
    if (!enabled) return 1.0;

    try {
      // Need smaPeriod + 10 candles for stable SMA seed
      const klines = await this.ex.getKlines(pair, '1d', smaPeriod + 10);
      if (klines.length < smaPeriod) return 1.0;

      const closes = klines.map(k => k.close);
      const sma    = Indicators.sma(closes, smaPeriod);
      if (sma === null) return 1.0;

      const dropPct = ((sma - currentPrice) / sma) * 100;

      if (dropPct <= 0) {
        this.log.debug(`${pair} above SMA — no multiplier`, {
          price: currentPrice, sma: sma.toFixed(2), dropPct: dropPct.toFixed(2),
        });
        return 1.0;
      }

      // Find the highest applicable dip tier (sorted descending by dropPercent)
      const sorted  = [...dips].sort((a, b) => b.dropPercent - a.dropPercent);
      const matched = sorted.find(d => dropPct >= d.dropPercent);
      const mult    = matched ? Math.min(matched.multiplier, maxMultiplier) : 1.0;

      this.log.info(`${pair} enhanced DCA multiplier`, {
        price: currentPrice, sma: sma.toFixed(2),
        dropPct: dropPct.toFixed(2), multiplier: mult,
      });

      return mult;
    } catch (err) {
      this.log.warn(`${pair} SMA calculation failed — using multiplier 1x`, { error: err.message });
      return 1.0;
    }
  }

  // ── Buy a single asset ─────────────────────────────────────────────────────
  async _buyAsset(assetCfg) {
    const { pair, asset, amountUSDT } = assetCfg;
    const currentPrice = await this.ex.getPrice(pair);
    const multiplier   = await this._getMultiplier(pair, currentPrice);
    const buyAmount    = amountUSDT * multiplier;
    const qty          = buyAmount / currentPrice;

    // Symbol info for lot size rounding
    let roundedQty = qty;
    try {
      const info = await this.ex.getSymbolInfo(pair);
      roundedQty = this.ex.roundQty(qty, info.stepSize);
      if (roundedQty < info.minQty) {
        this.log.warn(`${asset} quantity ${roundedQty} below minQty ${info.minQty} — skipping`);
        return null;
      }
      if (roundedQty * currentPrice < info.minNotional) {
        this.log.warn(`${asset} notional $${(roundedQty * currentPrice).toFixed(2)} below minNotional — skipping`);
        return null;
      }
    } catch (_) { /* use unrounded qty */ }

    this.log.info(`DCA buying ${asset}`, {
      pair, currentPrice, buyAmount: buyAmount.toFixed(2), qty: roundedQty.toFixed(6), multiplier,
    });

    const order = await this.placeOrder({
      exchange: this.ex.name, pair, side: 'BUY', type: 'MARKET',
      quantity: roundedQty, quoteQty: buyAmount,
      execute: () => this.ex.marketOrder(pair, 'BUY', null, buyAmount),
    });

    const execQty   = parseFloat(order.response.executedQty);
    const execPrice = parseFloat(order.response.executedPrice || currentPrice);

    // Get SMA at time of purchase for historical analysis
    let smaAtPurchase = null;
    try {
      const klines = await this.ex.getKlines(pair, '1d', this.config.enhancedDCA.smaPeriod + 5);
      smaAtPurchase = Indicators.sma(klines.map(k => k.close), this.config.enhancedDCA.smaPeriod);
    } catch (_) {}

    // Persist DCA purchase record
    await this.db.insertDCAPurchase({
      botId:        this.botId,
      asset,
      pair,
      quantity:     execQty,
      priceUsdt:    execPrice,
      costUsdt:     execQty * execPrice,
      multiplier,
      smaAtPurchase,
      orderId:      order.id,
    });

    // Summary for P&L display
    const summary  = await this.db.getDCASummary(this.botId, asset);
    const costBasis= summary ? parseFloat(summary.avg_cost_basis) : execPrice;
    const totalQty = summary ? parseFloat(summary.total_qty)      : execQty;
    const totalInv = summary ? parseFloat(summary.total_cost)     : execQty * execPrice;
    const pnlPct   = ((execPrice - costBasis) / costBasis) * 100;
    const pnlUSDT  = (execPrice - costBasis) * totalQty;

    this.log.info(`${asset} purchased`, {
      execQty:    execQty.toFixed(6),
      execPrice:  execPrice.toFixed(2),
      multiplier,
      costBasis:  costBasis.toFixed(2),
      totalQty:   totalQty.toFixed(6),
      totalInvested: totalInv.toFixed(2),
      unrealisedPnlPct:  pnlPct.toFixed(2),
      unrealisedPnlUSDT: pnlUSDT.toFixed(2),
    });

    return { asset, execQty, execPrice, multiplier, pnlPct, pnlUSDT, costBasis };
  }

  // ── Run a full DCA cycle across all configured assets ─────────────────────
  async _runCycle() {
    const now = new Date().toISOString();
    this.log.info('DCA cycle starting', { time: now, assets: this.config.assets.map(a => a.asset) });

    const results = [];
    let   totalSpent = 0;

    for (const assetCfg of this.config.assets) {
      if (!this.running || this.stopping) break;
      try {
        const result = await this._buyAsset(assetCfg);
        if (result) {
          results.push(result);
          totalSpent += assetCfg.amountUSDT * (result.multiplier || 1);
        }
      } catch (err) {
        this.log.error(`Failed to buy ${assetCfg.asset}`, { error: err.message });
        await this.log.alertError(`DCA buy failed for ${assetCfg.asset}: ${err.message}`);
      }
      // Small delay between assets to avoid bursting rate limits
      await this.sleepInterruptible(600);
    }

    // Portfolio summary log
    if (results.length > 0) {
      const totalPnlUSDT = results.reduce((s, r) => s + (r.pnlUSDT || 0), 0);
      this.log.info('DCA cycle complete', {
        assetsProcessed: results.length,
        totalSpent:      totalSpent.toFixed(2),
        portfolioPnl:    totalPnlUSDT.toFixed(2),
        results:         results.map(r => `${r.asset}:+${r.execQty.toFixed(6)}@$${r.execPrice.toFixed(2)}(${r.pnlPct.toFixed(1)}%)`),
      });
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async run() {
    this.log.info('DCA Bot started', {
      schedule: this.config.schedule,
      assets:   this.config.assets.map(a => `${a.asset}:$${a.amountUSDT}`),
      enhanced: this.config.enhancedDCA.enabled,
      smaPeriod:this.config.enhancedDCA.smaPeriod,
    });

    // Run immediately on startup
    await this._runCycle().catch(err => this.log.error('Initial cycle failed', { error: err.message }));

    // Schedule recurring runs
    this.job = cron.schedule(this.config.schedule, async () => {
      if (!this.running || this.stopping) return;
      if (!await this.riskCheck()) return;
      await this._runCycle().catch(err => this.log.error('Scheduled cycle failed', { error: err.message }));
    });

    // Keep the process alive — cron handles the timing
    while (this.running && !this.stopping) {
      await this.sleepInterruptible(5_000);
    }

    this.job?.stop();
    this.log.info('DCA Bot stopped');
  }
}

if (require.main === module) {
  const bot = new DCABot(CONFIG);
  process.on('SIGINT',  () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  bot.start();
}

module.exports = DCABot;
