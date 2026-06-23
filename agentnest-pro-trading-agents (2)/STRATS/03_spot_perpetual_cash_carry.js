/**
 * SPOT-PERPETUAL (CASH & CARRY) ARBITRAGE BOT
 *
 * Strategy:
 *   - Buy spot + short perpetual futures simultaneously
 *   - Collect positive funding rate payments while delta-neutral
 *   - Close both legs when funding rate turns negative or target profit hit
 *
 * Profit source: Funding rate payments (paid every 8h on most exchanges)
 *
 * Requirements: npm install axios crypto-js
 */

const axios = require('axios');
const crypto = require('crypto');
const EventEmitter = require('events');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  symbol: 'BTC',
  spotPair: 'BTCUSDT',
  perpPair: 'BTCUSDT-PERP',

  exchange: {
    baseUrl: 'https://api.exchange.com',
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
    spotTakerFee: 0.1,
    perpTakerFee: 0.05,
  },

  tradeAmountUSDT: 1000,         // notional size of each leg
  minFundingRatePercent: 0.03,   // only enter if 8h funding >= this
  exitFundingRatePercent: 0.005, // exit if funding drops below this
  targetProfitPercent: 0.5,      // take profit after accumulating this
  maxPositionHoldHours: 72,      // force-exit after this many hours
  checkIntervalMs: 30000,        // check funding rate every 30s
  dryRun: true,
};

// ─── EXCHANGE CLIENT ──────────────────────────────────────────────────────────
class ExchangeClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.http = axios.create({ baseURL: cfg.baseUrl, timeout: 6000 });
  }

  _sign(payload) {
    return crypto.createHmac('sha256', this.cfg.apiSecret).update(payload).digest('hex');
  }

  _auth(params = {}) {
    const ts = Date.now();
    const qs = new URLSearchParams({ ...params, timestamp: ts }).toString();
    return {
      params: { ...params, timestamp: ts, signature: this._sign(qs) },
      headers: { 'X-API-KEY': this.cfg.apiKey },
    };
  }

  /** Current spot price */
  async getSpotPrice(pair) {
    const r = await this.http.get('/v1/ticker/price', { params: { symbol: pair } });
    return parseFloat(r.data.price);
  }

  /** Current mark price and index price for perp */
  async getPerpMarkPrice(pair) {
    const r = await this.http.get('/v1/premiumIndex', { params: { symbol: pair } });
    return {
      markPrice: parseFloat(r.data.markPrice),
      indexPrice: parseFloat(r.data.indexPrice),
    };
  }

  /**
   * Get current funding rate and next funding time
   * @returns {{ fundingRate: number, nextFundingTime: Date }}
   */
  async getFundingRate(pair) {
    const r = await this.http.get('/v1/fundingRate', { params: { symbol: pair } });
    return {
      fundingRate: parseFloat(r.data.lastFundingRate) * 100, // convert to %
      nextFundingTime: new Date(r.data.nextFundingTime),
    };
  }

  /**
   * Funding rate history (last N records)
   */
  async getFundingHistory(pair, limit = 10) {
    const r = await this.http.get('/v1/fundingRate/history', {
      params: { symbol: pair, limit },
    });
    return r.data.map((d) => ({
      rate: parseFloat(d.fundingRate) * 100,
      time: new Date(d.fundingTime),
    }));
  }

  /** Spot market order */
  async spotOrder(pair, side, quoteQty) {
    if (this.cfg.dryRun ?? false) {
      console.log(`[DRY] Spot ${side} ${pair} $${quoteQty}`);
      return { orderId: `dry-${Date.now()}`, status: 'FILLED', executedQty: quoteQty };
    }
    const r = await this.http.post('/v1/order', null, this._auth({
      symbol: pair, side: side.toUpperCase(),
      type: 'MARKET', quoteOrderQty: quoteQty.toFixed(2),
    }));
    return r.data;
  }

  /** Perpetual futures order */
  async perpOrder(pair, side, quantity, reduceOnly = false) {
    if (this.cfg.dryRun ?? false) {
      console.log(`[DRY] Perp ${side} ${pair} qty=${quantity} reduceOnly=${reduceOnly}`);
      return { orderId: `dry-perp-${Date.now()}`, status: 'FILLED' };
    }
    const r = await this.http.post('/v1/futures/order', null, this._auth({
      symbol: pair, side: side.toUpperCase(),
      type: 'MARKET', quantity: quantity.toFixed(6),
      reduceOnly: reduceOnly.toString(),
    }));
    return r.data;
  }

  /** Get open perp position */
  async getPerpPosition(symbol) {
    const r = await this.http.get('/v1/futures/position', this._auth({ symbol }));
    return r.data.find((p) => p.symbol === symbol) ?? null;
  }

  /** Get spot balance for an asset */
  async getSpotBalance(asset) {
    const r = await this.http.get('/v1/account', this._auth());
    const b = r.data.balances.find((x) => x.asset === asset);
    return b ? parseFloat(b.free) : 0;
  }
}

// ─── CASH & CARRY BOT ─────────────────────────────────────────────────────────
class CashCarryBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = new ExchangeClient({ ...config.exchange, dryRun: config.dryRun });
    this.running = false;
    this.position = null; // { entrySpotPrice, entryPerpPrice, size, entryTime, fundingCollected }
    this.stats = { totalFundingCollected: 0, tradesExecuted: 0, totalProfitUSDT: 0 };
  }

  /** Estimate 3-cycle average funding rate for reliability */
  async getAverageFundingRate() {
    const history = await this.client.getFundingHistory(this.config.perpPair, 3);
    const sum = history.reduce((a, h) => a + h.rate, 0);
    return sum / history.length;
  }

  /** Open position: buy spot + short perp simultaneously */
  async openPosition(spotPrice, perpMarkPrice, fundingRate) {
    const size = this.config.tradeAmountUSDT / spotPrice;
    console.log(
      `[C&C] Opening position | Spot: $${spotPrice} | Perp: $${perpMarkPrice} | Size: ${size.toFixed(6)} BTC`
    );

    const [spotOrder, perpOrder] = await Promise.all([
      this.client.spotOrder(this.config.spotPair, 'BUY', this.config.tradeAmountUSDT),
      this.client.perpOrder(this.config.perpPair, 'SELL', size),
    ]);

    this.position = {
      entrySpotPrice: spotPrice,
      entryPerpPrice: perpMarkPrice,
      size,
      entryTime: Date.now(),
      fundingCollected: 0,
      spotOrderId: spotOrder.orderId,
      perpOrderId: perpOrder.orderId,
    };

    this.emit('position_opened', { ...this.position, fundingRate });
    console.log('[C&C] Position opened successfully.');
  }

  /** Close position: sell spot + close short perp */
  async closePosition(reason) {
    if (!this.position) return;
    const { size, entrySpotPrice, fundingCollected } = this.position;

    const currentSpot = await this.client.getSpotPrice(this.config.spotPair);

    const [spotClose, perpClose] = await Promise.all([
      this.client.spotOrder(this.config.spotPair, 'SELL', size * currentSpot),
      this.client.perpOrder(this.config.perpPair, 'BUY', size, true),
    ]);

    // Spot PnL (should be near 0 since we're delta-neutral)
    const spotPnl = (currentSpot - entrySpotPrice) * size;
    // Total profit = funding collected + small spot PnL - fees
    const fees =
      (this.config.exchange.spotTakerFee / 100) * this.config.tradeAmountUSDT * 2 +
      (this.config.exchange.perpTakerFee / 100) * this.config.tradeAmountUSDT * 2;
    const totalProfit = fundingCollected + spotPnl - fees;

    this.stats.totalFundingCollected += fundingCollected;
    this.stats.totalProfitUSDT += totalProfit;
    this.stats.tradesExecuted++;

    this.emit('position_closed', {
      reason,
      fundingCollected,
      spotPnl,
      fees,
      totalProfit,
      holdDurationHours: ((Date.now() - this.position.entryTime) / 3600000).toFixed(2),
    });

    console.log(
      `[C&C] Position closed | Reason: ${reason} | Funding: $${fundingCollected.toFixed(4)} | Profit: $${totalProfit.toFixed(4)}`
    );

    this.position = null;
  }

  /**
   * Called every funding period (8h) to account for funding received.
   * When short, if funding rate > 0 → shorts receive payment.
   */
  accrueeFunding(fundingRate) {
    if (!this.position) return;
    // Short position receives funding when rate is positive
    const payment = (fundingRate / 100) * this.config.tradeAmountUSDT;
    this.position.fundingCollected += payment;
    console.log(
      `[C&C] Funding accrued: $${payment.toFixed(4)} | Total collected: $${this.position.fundingCollected.toFixed(4)}`
    );
    this.emit('funding_accrued', { payment, total: this.position.fundingCollected });
  }

  async tick() {
    const [spotPrice, { markPrice }, { fundingRate, nextFundingTime }] = await Promise.all([
      this.client.getSpotPrice(this.config.spotPair),
      this.client.getPerpMarkPrice(this.config.perpPair),
      this.client.getFundingRate(this.config.perpPair),
    ]);

    const minutesToFunding = (nextFundingTime - Date.now()) / 60000;

    this.emit('tick', { spotPrice, markPrice, fundingRate, minutesToFunding: minutesToFunding.toFixed(1) });
    console.log(
      `[C&C] Spot: $${spotPrice} | Perp: $${markPrice} | Funding: ${fundingRate.toFixed(4)}% | Next in ${minutesToFunding.toFixed(0)}min`
    );

    if (!this.position) {
      // Look for entry: positive funding rate above threshold
      const avgFunding = await this.getAverageFundingRate();
      if (avgFunding >= this.config.minFundingRatePercent) {
        console.log(`[C&C] Entry signal! Avg funding: ${avgFunding.toFixed(4)}%`);
        await this.openPosition(spotPrice, markPrice, avgFunding);
      } else {
        console.log(`[C&C] No entry. Avg funding ${avgFunding.toFixed(4)}% < threshold ${this.config.minFundingRatePercent}%`);
      }
    } else {
      // Accrue funding if we're near a funding period (within 1 min after)
      if (minutesToFunding < -1 && minutesToFunding > -2) {
        this.accrueeFunding(fundingRate);
      }

      // Check exit conditions
      const holdHours = (Date.now() - this.position.entryTime) / 3600000;
      const profitPercent = (this.position.fundingCollected / this.config.tradeAmountUSDT) * 100;

      const exitReasons = [];
      if (fundingRate < this.config.exitFundingRatePercent) exitReasons.push('funding_too_low');
      if (profitPercent >= this.config.targetProfitPercent) exitReasons.push('target_profit_hit');
      if (holdHours >= this.config.maxPositionHoldHours) exitReasons.push('max_hold_time');

      if (exitReasons.length > 0) {
        await this.closePosition(exitReasons.join(','));
      }
    }
  }

  async start() {
    this.running = true;
    console.log(`[C&C] Cash & Carry Bot started | dryRun=${this.config.dryRun}`);
    this.emit('start');

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.emit('error', err);
        console.error('[C&C] Error:', err.message);
      }
      await new Promise((r) => setTimeout(r, this.config.checkIntervalMs));
    }
  }

  async stop() {
    this.running = false;
    if (this.position) {
      console.log('[C&C] Closing open position before shutdown...');
      await this.closePosition('bot_stopped');
    }
    console.log('[C&C] Stopped. Stats:', this.stats);
    this.emit('stop', this.stats);
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
const bot = new CashCarryBot(CONFIG);

bot.on('tick', (t) => {}); // handled in tick()
bot.on('position_opened', (p) => console.log('[OPEN]', p));
bot.on('position_closed', (p) => console.log('[CLOSE]', p));
bot.on('funding_accrued', (f) => console.log('[FUND] +$' + f.payment.toFixed(4)));
bot.on('error', (e) => console.error('[ERR]', e.message));

process.on('SIGINT', async () => {
  await bot.stop();
  process.exit(0);
});

bot.start();

module.exports = { CashCarryBot };
