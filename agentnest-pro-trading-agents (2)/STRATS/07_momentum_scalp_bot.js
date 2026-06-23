/**
 * MOMENTUM / SCALPING BOT
 *
 * Strategy:
 *   - Ultra-short timeframe trades (1m–5m candles)
 *   - Enter on momentum breakout confirmed by RSI + VWAP + order book imbalance
 *   - Tight ATR-based stop loss, fixed R:R take profit
 *   - Cooldown between trades to avoid overtrading
 *
 * Requirements: npm install axios crypto-js
 */

const axios = require('axios');
const crypto = require('crypto');
const EventEmitter = require('events');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  exchange: {
    baseUrl: 'https://api.exchange.com',
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
    takerFeePercent: 0.05, // use exchange with low fees for scalping
  },

  pair: 'BTCUSDT',
  interval: '1m',               // 1m candles for scalping
  tradeAmountUSDT: 200,

  // Momentum entry conditions
  rsiPeriod: 7,                 // short RSI for scalping
  rsiBullish: 55,               // RSI must be above this to go long
  rsiBearish: 45,               // RSI must be below this to go short
  momentumPeriod: 10,           // candles to measure price momentum
  momentumThresholdPercent: 0.15, // price must have moved > this % to confirm momentum

  // VWAP filter: price must be above/below VWAP
  useVWAP: true,

  // Order book imbalance filter
  useOrderBookFilter: true,
  minBidAskImbalance: 0.6,     // bid/(bid+ask) ratio for longs, inverse for shorts

  // Risk management
  atrPeriod: 7,
  atrStopMultiplier: 1.5,      // tighter stop for scalping
  riskRewardRatio: 1.5,        // 1.5:1 R:R
  maxTradesPerHour: 10,
  tradeCooldownMs: 30000,       // 30s cooldown between trades
  maxHoldTimeMs: 300000,        // force-exit after 5 minutes

  allowShort: true,
  pollIntervalMs: 5000,         // poll every 5s
  dryRun: true,
};

// ─── INDICATORS ───────────────────────────────────────────────────────────────
class Indicators {
  static rsi(closes, period) {
    if (closes.length < period + 1) return null;
    const slice = closes.slice(-(period + 1));
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = slice[i] - slice[i - 1];
      if (d > 0) gains += d; else losses += Math.abs(d);
    }
    const rs = gains / period / (losses / period || 1);
    return 100 - 100 / (1 + rs);
  }

  static atr(candles, period) {
    if (candles.length < period + 1) return null;
    const slice = candles.slice(-(period + 1));
    const trs = [];
    for (let i = 1; i < slice.length; i++) {
      trs.push(Math.max(
        slice[i].high - slice[i].low,
        Math.abs(slice[i].high - slice[i - 1].close),
        Math.abs(slice[i].low - slice[i - 1].close)
      ));
    }
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }

  /** VWAP over the current session candles */
  static vwap(candles) {
    let cumTPV = 0, cumVol = 0;
    for (const c of candles) {
      const typicalPrice = (c.high + c.low + c.close) / 3;
      cumTPV += typicalPrice * c.volume;
      cumVol += c.volume;
    }
    return cumVol === 0 ? null : cumTPV / cumVol;
  }

  /** Momentum: % change over N candles */
  static momentum(closes, period) {
    if (closes.length < period + 1) return null;
    const now = closes[closes.length - 1];
    const past = closes[closes.length - 1 - period];
    return ((now - past) / past) * 100;
  }

  /** Detect breakout: current close above recent high or below recent low */
  static breakout(candles, lookback = 5) {
    if (candles.length < lookback + 1) return null;
    const recent = candles.slice(-lookback - 1, -1);
    const currentClose = candles[candles.length - 1].close;
    const recentHigh = Math.max(...recent.map((c) => c.high));
    const recentLow = Math.min(...recent.map((c) => c.low));

    if (currentClose > recentHigh) return 'bullish';
    if (currentClose < recentLow) return 'bearish';
    return null;
  }
}

// ─── EXCHANGE CLIENT ──────────────────────────────────────────────────────────
class ExchangeClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.http = axios.create({ baseURL: cfg.baseUrl, timeout: 4000 });
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

  async getKlines(pair, interval, limit = 100) {
    const r = await this.http.get('/v1/klines', { params: { symbol: pair, interval, limit } });
    return r.data.map((k) => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
  }

  async getOrderBook(pair, depth = 10) {
    const r = await this.http.get('/v1/depth', { params: { symbol: pair, limit: depth } });
    const bidVol = r.data.bids.reduce((s, [, qty]) => s + parseFloat(qty), 0);
    const askVol = r.data.asks.reduce((s, [, qty]) => s + parseFloat(qty), 0);
    return {
      bestBid: parseFloat(r.data.bids[0][0]),
      bestAsk: parseFloat(r.data.asks[0][0]),
      bidVolume: bidVol,
      askVolume: askVol,
      imbalance: bidVol / (bidVol + askVol), // > 0.5 = more bids (bullish pressure)
      spread: parseFloat(r.data.asks[0][0]) - parseFloat(r.data.bids[0][0]),
    };
  }

  async getPrice(pair) {
    const r = await this.http.get('/v1/ticker/price', { params: { symbol: pair } });
    return parseFloat(r.data.price);
  }

  async marketOrder(pair, side, quoteQty) {
    if (this.cfg.dryRun) {
      const price = await this.getPrice(pair);
      console.log(`[DRY] MARKET ${side} ${pair} $${quoteQty} @ ~$${price}`);
      return { orderId: `dry-${Date.now()}`, executedQty: (quoteQty / price).toFixed(8), price, status: 'FILLED' };
    }
    const r = await this.http.post('/v1/order', null, this._auth({
      symbol: pair, side: side.toUpperCase(), type: 'MARKET',
      quoteOrderQty: quoteQty.toFixed(2),
    }));
    return r.data;
  }

  async setOCO(pair, side, quantity, price, stopPrice, limitPrice) {
    // OCO = One Cancels Other: stop-loss + take-profit together
    if (this.cfg.dryRun) {
      console.log(`[DRY] OCO ${side} qty=${quantity.toFixed(6)} TP=$${price} SL=$${stopPrice}`);
      return { orderListId: `dry-oco-${Date.now()}` };
    }
    const r = await this.http.post('/v1/order/oco', null, this._auth({
      symbol: pair, side: side.toUpperCase(),
      quantity: quantity.toFixed(6),
      price: price.toFixed(2),
      stopPrice: stopPrice.toFixed(2),
      stopLimitPrice: limitPrice.toFixed(2),
      stopLimitTimeInForce: 'GTC',
    }));
    return r.data;
  }

  async cancelOCO(pair, orderListId) {
    if (this.cfg.dryRun) return { status: 'CANCELED' };
    const r = await this.http.delete('/v1/order/oco', this._auth({ symbol: pair, orderListId }));
    return r.data;
  }
}

// ─── TRADE RATE LIMITER ───────────────────────────────────────────────────────
class RateLimiter {
  constructor(maxPerHour) {
    this.maxPerHour = maxPerHour;
    this.timestamps = [];
  }

  canTrade() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 3600000);
    return this.timestamps.length < this.maxPerHour;
  }

  recordTrade() {
    this.timestamps.push(Date.now());
  }

  tradesThisHour() {
    const now = Date.now();
    return this.timestamps.filter((t) => now - t < 3600000).length;
  }
}

// ─── SCALPING BOT ─────────────────────────────────────────────────────────────
class MomentumScalpBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = new ExchangeClient({ ...config.exchange, dryRun: config.dryRun });
    this.limiter = new RateLimiter(config.maxTradesPerHour);
    this.running = false;
    this.position = null;
    this.lastTradeTime = 0;
    this.stats = { trades: 0, wins: 0, losses: 0, totalPnlUSDT: 0, breakEven: 0 };
  }

  /** Run all entry filters and return signal or null */
  async analyzeForEntry(candles, orderBook) {
    const closes = candles.map((c) => c.close);
    const rsi = Indicators.rsi(closes, this.config.rsiPeriod);
    const atr = Indicators.atr(candles, this.config.atrPeriod);
    const momentum = Indicators.momentum(closes, this.config.momentumPeriod);
    const breakout = Indicators.breakout(candles, 5);
    const vwap = Indicators.vwap(candles);
    const currentPrice = closes[closes.length - 1];

    if (!rsi || !atr || !momentum || !breakout) return null;

    console.log(
      `[SCALP] RSI: ${rsi.toFixed(1)} | Momentum: ${momentum.toFixed(3)}% | ` +
      `Breakout: ${breakout} | VWAP: $${vwap?.toFixed(2)} | OB Imbalance: ${orderBook.imbalance.toFixed(2)}`
    );

    const absMomentum = Math.abs(momentum) >= this.config.momentumThresholdPercent;
    if (!absMomentum) return null;

    // LONG conditions
    if (
      breakout === 'bullish' &&
      rsi >= this.config.rsiBullish &&
      momentum > 0 &&
      (!this.config.useVWAP || currentPrice > vwap) &&
      (!this.config.useOrderBookFilter || orderBook.imbalance >= this.config.minBidAskImbalance)
    ) {
      return { signal: 'LONG', currentPrice, atr, vwap };
    }

    // SHORT conditions
    if (
      this.config.allowShort &&
      breakout === 'bearish' &&
      rsi <= this.config.rsiBearish &&
      momentum < 0 &&
      (!this.config.useVWAP || currentPrice < vwap) &&
      (!this.config.useOrderBookFilter || orderBook.imbalance <= (1 - this.config.minBidAskImbalance))
    ) {
      return { signal: 'SHORT', currentPrice, atr, vwap };
    }

    return null;
  }

  async openPosition(analysis) {
    const { signal, currentPrice, atr } = analysis;
    const quantity = this.config.tradeAmountUSDT / currentPrice;

    let stopLoss, takeProfit;
    if (signal === 'LONG') {
      stopLoss = currentPrice - atr * this.config.atrStopMultiplier;
      takeProfit = currentPrice + (currentPrice - stopLoss) * this.config.riskRewardRatio;
    } else {
      stopLoss = currentPrice + atr * this.config.atrStopMultiplier;
      takeProfit = currentPrice - (stopLoss - currentPrice) * this.config.riskRewardRatio;
    }

    const entrySide = signal === 'LONG' ? 'BUY' : 'SELL';
    const exitSide = signal === 'LONG' ? 'SELL' : 'BUY';
    const slipBuffer = atr * 0.1; // slight buffer for stop limit price

    console.log(
      `[SCALP] 🚀 ${signal} entry @ $${currentPrice.toFixed(2)} | SL: $${stopLoss.toFixed(2)} | TP: $${takeProfit.toFixed(2)} | ATR: $${atr.toFixed(2)}`
    );

    const entryOrder = await this.client.marketOrder(this.config.pair, entrySide, this.config.tradeAmountUSDT);

    // Place OCO (stop loss + take profit) immediately after entry
    const oco = await this.client.setOCO(
      this.config.pair, exitSide, quantity,
      takeProfit,        // limit (take profit)
      stopLoss,          // stop trigger
      stopLoss - (signal === 'LONG' ? slipBuffer : -slipBuffer) // stop limit
    );

    this.position = {
      signal, entryPrice: currentPrice, quantity,
      stopLoss, takeProfit, ocoId: oco.orderListId,
      openTime: Date.now(),
    };

    this.limiter.recordTrade();
    this.stats.trades++;
    this.emit('position_opened', this.position);
  }

  async closePosition(currentPrice, reason) {
    if (!this.position) return;
    const { signal, entryPrice, quantity, ocoId } = this.position;

    // Cancel OCO first
    await this.client.cancelOCO(this.config.pair, ocoId).catch(() => {});

    // Market close
    const exitSide = signal === 'LONG' ? 'SELL' : 'BUY';
    await this.client.marketOrder(this.config.pair, exitSide, quantity * currentPrice);

    const rawPnl = signal === 'LONG'
      ? (currentPrice - entryPrice) * quantity
      : (entryPrice - currentPrice) * quantity;
    const fees = (this.config.exchange.takerFeePercent / 100) * this.config.tradeAmountUSDT * 2;
    const netPnl = rawPnl - fees;

    if (netPnl > 0.01) this.stats.wins++;
    else if (netPnl < -0.01) this.stats.losses++;
    else this.stats.breakEven++;
    this.stats.totalPnlUSDT += netPnl;

    const holdSec = ((Date.now() - this.position.openTime) / 1000).toFixed(0);
    console.log(
      `[SCALP] ${signal} closed (${reason}) @ $${currentPrice.toFixed(2)} | ` +
      `PnL: $${netPnl.toFixed(4)} | Hold: ${holdSec}s | Total: $${this.stats.totalPnlUSDT.toFixed(4)}`
    );

    this.emit('position_closed', { signal, entryPrice, exitPrice: currentPrice, netPnl, reason, holdSec });
    this.lastTradeTime = Date.now();
    this.position = null;
  }

  async tick() {
    const [candles, orderBook] = await Promise.all([
      this.client.getKlines(this.config.pair, this.config.interval, 100),
      this.client.getOrderBook(this.config.pair, 20),
    ]);

    const currentPrice = candles[candles.length - 1].close;

    if (this.position) {
      const { signal, stopLoss, takeProfit, openTime } = this.position;
      const holdTime = Date.now() - openTime;

      // Manual exit checks (OCO should handle these, but fallback)
      if (signal === 'LONG') {
        if (currentPrice <= stopLoss) { await this.closePosition(currentPrice, 'stop_loss'); return; }
        if (currentPrice >= takeProfit) { await this.closePosition(currentPrice, 'take_profit'); return; }
      } else {
        if (currentPrice >= stopLoss) { await this.closePosition(currentPrice, 'stop_loss'); return; }
        if (currentPrice <= takeProfit) { await this.closePosition(currentPrice, 'take_profit'); return; }
      }

      // Max hold time
      if (holdTime > this.config.maxHoldTimeMs) {
        await this.closePosition(currentPrice, 'max_hold_time');
        return;
      }

      return; // Don't enter new position while one is open
    }

    // Check cooldown
    const cooldownOk = Date.now() - this.lastTradeTime > this.config.tradeCooldownMs;
    if (!cooldownOk) return;

    // Check rate limit
    if (!this.limiter.canTrade()) {
      console.log(`[SCALP] Rate limit reached: ${this.limiter.tradesThisHour()}/${this.config.maxTradesPerHour} trades this hour`);
      return;
    }

    const entry = await this.analyzeForEntry(candles, orderBook);
    if (entry) {
      this.emit('signal', entry);
      await this.openPosition(entry);
    }
  }

  async start() {
    this.running = true;
    console.log(`[SCALP] Momentum Scalp Bot started | ${this.config.pair} ${this.config.interval} | dryRun=${this.config.dryRun}`);
    this.emit('start');

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.emit('error', err);
        console.error('[SCALP] Error:', err.message);
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async stop() {
    this.running = false;
    const price = await this.client.getPrice(this.config.pair);
    if (this.position) await this.closePosition(price, 'bot_stopped');
    const wr = this.stats.wins / (this.stats.trades || 1) * 100;
    console.log('[SCALP] Stopped. Stats:', { ...this.stats, winRate: wr.toFixed(1) + '%' });
    this.emit('stop', this.stats);
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
const bot = new MomentumScalpBot(CONFIG);

bot.on('signal', (s) => console.log('[SIGNAL]', s.signal, '@', s.currentPrice));
bot.on('position_opened', (p) => console.log('[OPEN]', p.signal, '@', p.entryPrice));
bot.on('position_closed', (p) => console.log('[CLOSE]', p.signal, 'PnL: $' + p.netPnl?.toFixed(4), `(${p.reason})`));
bot.on('error', (e) => console.error('[ERR]', e.message));

process.on('SIGINT', async () => { await bot.stop(); process.exit(0); });
bot.start();

module.exports = { MomentumScalpBot, Indicators };
