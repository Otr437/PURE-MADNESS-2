/**
 * DOLLAR-COST AVERAGING (DCA) BOT
 *
 * Strategy:
 *   - Buy a fixed USDT amount at regular intervals regardless of price
 *   - Optional: Enhanced DCA — buy more when price drops below moving average
 *   - Tracks cost basis, unrealized PnL, and portfolio performance
 *
 * Requirements: npm install axios crypto-js node-cron
 */

const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');
const fs = require('fs');
const EventEmitter = require('events');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  exchange: {
    baseUrl: 'https://api.exchange.com',
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
    takerFeePercent: 0.1,
  },

  // Assets to DCA into (can be multiple)
  assets: [
    { pair: 'BTCUSDT', asset: 'BTC', amountUSDT: 50, allocationPercent: 60 },
    { pair: 'ETHUSDT', asset: 'ETH', amountUSDT: 30, allocationPercent: 30 },
    { pair: 'SOLUSDT', asset: 'SOL', amountUSDT: 20, allocationPercent: 10 },
  ],

  // Schedule: standard cron syntax
  // '0 9 * * 1'  = Every Monday at 9am
  // '0 */12 * * *' = Every 12 hours
  schedule: '0 9 * * 1',  // weekly on Monday 9am

  // Enhanced DCA: multiply buy amount if price is below SMA by X%
  enhancedDCA: {
    enabled: true,
    smaPeriod: 50,              // 50-period SMA on daily candles
    dips: [
      { dropPercent: 5,  multiplier: 1.5 },
      { dropPercent: 10, multiplier: 2.0 },
      { dropPercent: 20, multiplier: 3.0 },
    ],
  },

  // Stop buying if price drops below this % of all-time high (bear protection)
  drawdownPausePercent: 80, // pause if price < 80% below ATH (i.e. 80%+ drawdown)

  stateFile: './dca_state.json',
  dryRun: true,
};

// ─── EXCHANGE CLIENT ──────────────────────────────────────────────────────────
class ExchangeClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.http = axios.create({ baseURL: cfg.baseUrl, timeout: 8000 });
  }

  _sign(q) {
    return crypto.createHmac('sha256', this.cfg.apiSecret).update(q).digest('hex');
  }

  _auth(params = {}) {
    const ts = Date.now();
    const q = new URLSearchParams({ ...params, timestamp: ts }).toString();
    return { params: { ...params, timestamp: ts, signature: this._sign(q) },
             headers: { 'X-API-KEY': this.cfg.apiKey } };
  }

  async getPrice(pair) {
    const r = await this.http.get('/v1/ticker/price', { params: { symbol: pair } });
    return parseFloat(r.data.price);
  }

  /** Kline/candlestick data for SMA calculation */
  async getKlines(pair, interval = '1d', limit = 50) {
    const r = await this.http.get('/v1/klines', {
      params: { symbol: pair, interval, limit },
    });
    // Each entry: [openTime, open, high, low, close, volume, ...]
    return r.data.map((k) => ({ time: k[0], close: parseFloat(k[4]) }));
  }

  async marketBuy(pair, quoteQty) {
    if (this.cfg.dryRun) {
      console.log(`[DRY] Market BUY ${pair} $${quoteQty.toFixed(2)}`);
      const price = await this.getPrice(pair);
      return {
        orderId: `dry-${Date.now()}`,
        executedQty: (quoteQty / price).toFixed(6),
        cummulativeQuoteQty: quoteQty.toFixed(2),
        price,
        status: 'FILLED',
      };
    }
    const r = await this.http.post('/v1/order', null, this._auth({
      symbol: pair, side: 'BUY', type: 'MARKET',
      quoteOrderQty: quoteQty.toFixed(2),
    }));
    return r.data;
  }

  async getBalance(asset) {
    const r = await this.http.get('/v1/account', this._auth());
    const b = r.data.balances.find((x) => x.asset === asset);
    return b ? { free: parseFloat(b.free), locked: parseFloat(b.locked) } : { free: 0, locked: 0 };
  }
}

// ─── STATE MANAGER ────────────────────────────────────────────────────────────
class StateManager {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (_) {}
    return { purchases: [], summary: {} };
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  recordPurchase(asset, qty, priceUSDT, totalCostUSDT, multiplier) {
    this.state.purchases.push({
      timestamp: new Date().toISOString(),
      asset, qty, priceUSDT, totalCostUSDT, multiplier,
    });

    if (!this.state.summary[asset]) {
      this.state.summary[asset] = { totalQty: 0, totalCostUSDT: 0, purchases: 0 };
    }
    this.state.summary[asset].totalQty += qty;
    this.state.summary[asset].totalCostUSDT += totalCostUSDT;
    this.state.summary[asset].purchases++;
    this.save();
  }

  getCostBasis(asset) {
    const s = this.state.summary[asset];
    if (!s || s.totalQty === 0) return 0;
    return s.totalCostUSDT / s.totalQty;
  }

  getSummary(asset) {
    return this.state.summary[asset] ?? { totalQty: 0, totalCostUSDT: 0, purchases: 0 };
  }

  getAllSummaries() {
    return this.state.summary;
  }
}

// ─── DCA BOT ──────────────────────────────────────────────────────────────────
class DCABot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = new ExchangeClient({ ...config.exchange, dryRun: config.dryRun });
    this.state = new StateManager(config.stateFile);
    this.job = null;
  }

  /** Calculate SMA for a given pair */
  async getSMA(pair) {
    const klines = await this.client.getKlines(pair, '1d', this.config.enhancedDCA.smaPeriod);
    const closes = klines.map((k) => k.close);
    const sum = closes.reduce((a, b) => a + b, 0);
    return sum / closes.length;
  }

  /**
   * Determine buy multiplier based on price vs SMA
   */
  async getBuyMultiplier(pair, currentPrice) {
    if (!this.config.enhancedDCA.enabled) return 1;

    const sma = await this.getSMA(pair);
    const dropPercent = ((sma - currentPrice) / sma) * 100;

    if (dropPercent <= 0) return 1; // price above SMA, normal DCA

    // Find highest matching dip multiplier
    const dips = [...this.config.enhancedDCA.dips].sort((a, b) => b.dropPercent - a.dropPercent);
    for (const dip of dips) {
      if (dropPercent >= dip.dropPercent) {
        console.log(
          `[DCA] Enhanced buy: price ${dropPercent.toFixed(2)}% below SMA → multiplier ${dip.multiplier}x`
        );
        return dip.multiplier;
      }
    }

    return 1;
  }

  /** Execute a single DCA buy for one asset */
  async buyAsset(assetConfig) {
    const { pair, asset, amountUSDT } = assetConfig;

    const currentPrice = await this.client.getPrice(pair);
    const multiplier = await this.getBuyMultiplier(pair, currentPrice);
    const finalAmount = amountUSDT * multiplier;
    const feeUSDT = (this.config.exchange.takerFeePercent / 100) * finalAmount;
    const netAmount = finalAmount - feeUSDT;

    console.log(
      `[DCA] Buying ${asset}: $${finalAmount.toFixed(2)} @ $${currentPrice} | Multiplier: ${multiplier}x`
    );

    const order = await this.client.marketBuy(pair, finalAmount);
    const executedQty = parseFloat(order.executedQty);
    const executedCost = parseFloat(order.cummulativeQuoteQty ?? finalAmount);

    this.state.recordPurchase(asset, executedQty, currentPrice, executedCost, multiplier);

    const summary = this.state.getSummary(asset);
    const costBasis = this.state.getCostBasis(asset);
    const unrealizedPnl = (currentPrice - costBasis) * summary.totalQty;
    const unrealizedPnlPercent = ((currentPrice - costBasis) / costBasis) * 100;

    const result = {
      asset, pair, currentPrice, multiplier,
      boughtQty: executedQty, costUSDT: executedCost,
      totalQty: summary.totalQty,
      totalInvested: summary.totalCostUSDT,
      costBasis: costBasis.toFixed(4),
      unrealizedPnl: unrealizedPnl.toFixed(2),
      unrealizedPnlPercent: unrealizedPnlPercent.toFixed(2),
      purchases: summary.purchases,
    };

    this.emit('purchase', result);
    console.log(
      `[DCA] ✅ ${asset} | Qty: ${executedQty} | Avg Cost: $${costBasis.toFixed(2)} | PnL: ${unrealizedPnlPercent.toFixed(2)}%`
    );

    return result;
  }

  /** Run a full DCA cycle across all configured assets */
  async runCycle() {
    console.log(`\n[DCA] ── Running DCA cycle at ${new Date().toISOString()} ──`);
    this.emit('cycle_start', { time: new Date().toISOString() });

    const results = [];
    for (const assetConfig of this.config.assets) {
      try {
        const result = await this.buyAsset(assetConfig);
        results.push(result);
        // Small delay between buys
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        this.emit('error', { asset: assetConfig.asset, err: err.message });
        console.error(`[DCA] Error buying ${assetConfig.asset}:`, err.message);
      }
    }

    this.emit('cycle_complete', { results, summary: this.state.getAllSummaries() });
    this.printPortfolio();
    return results;
  }

  /** Print current portfolio state */
  async printPortfolio() {
    console.log('\n[DCA] ── Portfolio Summary ──');
    const summaries = this.state.getAllSummaries();
    let totalInvested = 0;
    let totalCurrentValue = 0;

    for (const [asset, s] of Object.entries(summaries)) {
      const assetCfg = this.config.assets.find((a) => a.asset === asset);
      if (!assetCfg) continue;
      const currentPrice = await this.client.getPrice(assetCfg.pair).catch(() => 0);
      const currentValue = s.totalQty * currentPrice;
      const costBasis = s.totalCostUSDT / s.totalQty;
      const pnl = currentValue - s.totalCostUSDT;
      const pnlPct = (pnl / s.totalCostUSDT) * 100;

      totalInvested += s.totalCostUSDT;
      totalCurrentValue += currentValue;

      console.log(
        `  ${asset}: ${s.totalQty.toFixed(6)} @ avg $${costBasis.toFixed(2)} | ` +
        `Value: $${currentValue.toFixed(2)} | PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) | ${s.purchases} buys`
      );
    }

    const totalPnl = totalCurrentValue - totalInvested;
    const totalPnlPct = ((totalCurrentValue - totalInvested) / totalInvested) * 100;
    console.log(`  ── Total Invested: $${totalInvested.toFixed(2)} | Value: $${totalCurrentValue.toFixed(2)} | PnL: $${totalPnl.toFixed(2)} (${totalPnlPct.toFixed(2)}%)\n`);
  }

  start() {
    console.log(`[DCA] Bot started. Schedule: "${this.config.schedule}" | dryRun=${this.config.dryRun}`);
    this.emit('start');

    // Run immediately on start
    this.runCycle();

    // Schedule recurring runs
    this.job = cron.schedule(this.config.schedule, () => this.runCycle());
  }

  stop() {
    if (this.job) this.job.stop();
    console.log('[DCA] Bot stopped.');
    this.emit('stop');
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
const bot = new DCABot(CONFIG);

bot.on('purchase', (r) =>
  console.log(`[BUY] ${r.asset} +${r.boughtQty} | Avg: $${r.costBasis} | PnL: ${r.unrealizedPnlPercent}%`)
);
bot.on('error', (e) => console.error('[ERR]', e));
bot.on('cycle_complete', () => console.log('[CYCLE] Done.'));

process.on('SIGINT', () => { bot.stop(); process.exit(0); });
bot.start();

module.exports = { DCABot };
