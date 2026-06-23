/**
 * TREND FOLLOWING BOT — Moving Average Crossover
 *
 * Strategy:
 *   - Golden Cross: 50 SMA crosses above 200 SMA → go LONG
 *   - Death Cross:  50 SMA crosses below 200 SMA → go SHORT (or exit)
 *   - Additional filters: RSI, volume, ATR-based stop loss
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
    takerFeePercent: 0.1,
  },

  pair: 'BTCUSDT',
  interval: '4h',         // candle timeframe: 1h, 4h, 1d
  tradeAmountUSDT: 500,

  // Moving averages
  fastMAPeriod: 50,
  slowMAPeriod: 200,
  maType: 'EMA',          // 'SMA' or 'EMA'

  // Filters
  rsiPeriod: 14,
  rsiOverbought: 70,       // don't buy when RSI > 70
  rsiOversold: 30,         // don't sell when RSI < 30
  minVolumeMultiplier: 1.2, // volume must be 1.2x the 20-bar avg

  // Risk management
  atrPeriod: 14,
  atrStopMultiplier: 2.0,  // stop loss = entry ± 2 * ATR
  riskRewardRatio: 2.0,    // target = entry ± 2 * stop distance

  // Allow shorting with perpetual futures
  allowShort: false,

  pollIntervalMs: 60000,   // check every 60s (use larger intervals on production)
  dryRun: true,
};

// ─── INDICATORS ───────────────────────────────────────────────────────────────
class Indicators {
  static sma(closes, period) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  static ema(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
  }

  static ma(closes, period, type = 'EMA') {
    return type === 'EMA' ? this.ema(closes, period) : this.sma(closes, period);
  }

  static rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    const slice = closes.slice(-(period + 1));
    let gains = 0, losses = 0;

    for (let i = 1; i <= period; i++) {
      const change = slice[i] - slice[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  static atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const slice = candles.slice(-(period + 1));
    const trueRanges = [];

    for (let i = 1; i < slice.length; i++) {
      const high = slice[i].high;
      const low = slice[i].low;
      const prevClose = slice[i - 1].close;
      trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }

    return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
  }

  static volumeSMA(volumes, period = 20) {
    if (volumes.length < period) return null;
    const slice = volumes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * Detect MA crossover between current and previous bar
   * Returns: 'golden' | 'death' | null
   */
  static detectCrossover(closes, fastPeriod, slowPeriod, type) {
    if (closes.length < slowPeriod + 2) return null;

    const currentFast = this.ma(closes, fastPeriod, type);
    const currentSlow = this.ma(closes, slowPeriod, type);

    const prevCloses = closes.slice(0, -1);
    const prevFast = this.ma(prevCloses, fastPeriod, type);
    const prevSlow = this.ma(prevCloses, slowPeriod, type);

    if (!currentFast || !currentSlow || !prevFast || !prevSlow) return null;

    if (prevFast <= prevSlow && currentFast > currentSlow) return 'golden';
    if (prevFast >= prevSlow && currentFast < currentSlow) return 'death';

    return null;
  }
}

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

  async getKlines(pair, interval, limit = 250) {
    const r = await this.http.get('/v1/klines', {
      params: { symbol: pair, interval, limit },
    });
    return r.data.map((k) => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  async getPrice(pair) {
    const r = await this.http.get('/v1/ticker/price', { params: { symbol: pair } });
    return parseFloat(r.data.price);
  }

  async marketOrder(pair, side, quoteQty) {
    if (this.cfg.dryRun) {
      const price = await this.getPrice(pair);
      console.log(`[DRY] MARKET ${side} ${pair} $${quoteQty} @ ~$${price}`);
      return { orderId: `dry-${Date.now()}`, executedQty: quoteQty / price, price, status: 'FILLED' };
    }
    const r = await this.http.post('/v1/order', null, this._auth({
      symbol: pair, side: side.toUpperCase(), type: 'MARKET',
      quoteOrderQty: quoteQty.toFixed(2),
    }));
    return r.data;
  }

  async setStopLoss(pair, side, quantity, stopPrice) {
    if (this.cfg.dryRun) {
      console.log(`[DRY] STOP-LOSS ${side} ${pair} qty=${quantity.toFixed(6)} stopPrice=$${stopPrice.toFixed(2)}`);
      return { orderId: `dry-sl-${Date.now()}` };
    }
    const r = await this.http.post('/v1/order', null, this._auth({
      symbol: pair, side: side.toUpperCase(),
      type: 'STOP_MARKET', stopPrice: stopPrice.toFixed(2),
      quantity: quantity.toFixed(6), timeInForce: 'GTE_GTC',
    }));
    return r.data;
  }

  async cancelOrder(pair, orderId) {
    if (this.cfg.dryRun) return { status: 'CANCELED' };
    const r = await this.http.delete('/v1/order', this._auth({ symbol: pair, orderId }));
    return r.data;
  }
}

// ─── TREND FOLLOWING BOT ──────────────────────────────────────────────────────
class TrendFollowingBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = new ExchangeClient({ ...config.exchange, dryRun: config.dryRun });
    this.running = false;
    this.position = null; // { side, entryPrice, quantity, stopLossPrice, takeProfitPrice, stopOrderId }
    this.stats = { longTrades: 0, shortTrades: 0, wins: 0, losses: 0, totalPnlUSDT: 0 };
  }

  /** Compute all indicators from candle data */
  analyzeCandles(candles) {
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    const currentVolume = volumes[volumes.length - 1];

    const fastMA = Indicators.ma(closes, this.config.fastMAPeriod, this.config.maType);
    const slowMA = Indicators.ma(closes, this.config.slowMAPeriod, this.config.maType);
    const rsi = Indicators.rsi(closes, this.config.rsiPeriod);
    const atr = Indicators.atr(candles, this.config.atrPeriod);
    const volumeAvg = Indicators.volumeSMA(volumes, 20);
    const crossover = Indicators.detectCrossover(closes, this.config.fastMAPeriod, this.config.slowMAPeriod, this.config.maType);

    return {
      fastMA, slowMA, rsi, atr, volumeAvg,
      currentVolume, crossover,
      currentPrice: closes[closes.length - 1],
      trend: fastMA > slowMA ? 'bullish' : 'bearish',
    };
  }

  /** Determine signal from indicators */
  getSignal(analysis) {
    const { crossover, rsi, currentVolume, volumeAvg } = analysis;
    if (!crossover) return null;

    const volumeOk = volumeAvg && currentVolume >= volumeAvg * this.config.minVolumeMultiplier;
    if (!volumeOk) {
      console.log(`[TREND] ${crossover} crossover found but volume too low (${(currentVolume/volumeAvg).toFixed(2)}x avg)`);
      return null;
    }

    if (crossover === 'golden') {
      if (rsi > this.config.rsiOverbought) {
        console.log(`[TREND] Golden cross filtered: RSI overbought at ${rsi.toFixed(1)}`);
        return null;
      }
      return 'LONG';
    }

    if (crossover === 'death') {
      if (!this.config.allowShort) {
        return 'CLOSE'; // just exit long if no shorting allowed
      }
      if (rsi < this.config.rsiOversold) {
        console.log(`[TREND] Death cross filtered: RSI oversold at ${rsi.toFixed(1)}`);
        return null;
      }
      return 'SHORT';
    }

    return null;
  }

  async openLong(price, atr) {
    const qty = this.config.tradeAmountUSDT / price;
    const stopLoss = price - atr * this.config.atrStopMultiplier;
    const takeProfit = price + (price - stopLoss) * this.config.riskRewardRatio;

    console.log(
      `[TREND] 📈 Opening LONG @ $${price.toFixed(2)} | SL: $${stopLoss.toFixed(2)} | TP: $${takeProfit.toFixed(2)}`
    );

    const order = await this.client.marketOrder(this.config.pair, 'BUY', this.config.tradeAmountUSDT);
    const slOrder = await this.client.setStopLoss(this.config.pair, 'SELL', qty, stopLoss);

    this.position = {
      side: 'LONG', entryPrice: price,
      quantity: qty, stopLossPrice: stopLoss, takeProfitPrice: takeProfit,
      stopOrderId: slOrder.orderId, entryTime: Date.now(),
    };

    this.stats.longTrades++;
    this.emit('position_opened', this.position);
  }

  async openShort(price, atr) {
    const qty = this.config.tradeAmountUSDT / price;
    const stopLoss = price + atr * this.config.atrStopMultiplier;
    const takeProfit = price - (stopLoss - price) * this.config.riskRewardRatio;

    console.log(
      `[TREND] 📉 Opening SHORT @ $${price.toFixed(2)} | SL: $${stopLoss.toFixed(2)} | TP: $${takeProfit.toFixed(2)}`
    );

    const order = await this.client.marketOrder(this.config.pair, 'SELL', this.config.tradeAmountUSDT);
    const slOrder = await this.client.setStopLoss(this.config.pair, 'BUY', qty, stopLoss);

    this.position = {
      side: 'SHORT', entryPrice: price,
      quantity: qty, stopLossPrice: stopLoss, takeProfitPrice: takeProfit,
      stopOrderId: slOrder.orderId, entryTime: Date.now(),
    };

    this.stats.shortTrades++;
    this.emit('position_opened', this.position);
  }

  async closePosition(currentPrice, reason) {
    if (!this.position) return;
    const { side, entryPrice, quantity, stopOrderId } = this.position;

    // Cancel existing stop loss
    await this.client.cancelOrder(this.config.pair, stopOrderId).catch(() => {});

    // Close position
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    await this.client.marketOrder(this.config.pair, closeSide, quantity * currentPrice);

    const rawPnl = side === 'LONG'
      ? (currentPrice - entryPrice) * quantity
      : (entryPrice - currentPrice) * quantity;

    const fees = (this.config.exchange.takerFeePercent / 100) * this.config.tradeAmountUSDT * 2;
    const netPnl = rawPnl - fees;

    if (netPnl > 0) this.stats.wins++; else this.stats.losses++;
    this.stats.totalPnlUSDT += netPnl;

    console.log(
      `[TREND] ${side} closed (${reason}) @ $${currentPrice.toFixed(2)} | PnL: $${netPnl.toFixed(4)} | Total: $${this.stats.totalPnlUSDT.toFixed(4)}`
    );

    this.emit('position_closed', { side, entryPrice, exitPrice: currentPrice, netPnl, reason });
    this.position = null;
  }

  async tick() {
    const candles = await this.client.getKlines(this.config.pair, this.config.interval, 250);
    const analysis = this.analyzeCandles(candles);
    const { currentPrice, fastMA, slowMA, rsi, atr, trend } = analysis;

    console.log(
      `[TREND] ${this.config.pair} $${currentPrice.toFixed(2)} | ` +
      `${this.config.maType}(${this.config.fastMAPeriod}): $${fastMA?.toFixed(2)} | ` +
      `${this.config.maType}(${this.config.slowMAPeriod}): $${slowMA?.toFixed(2)} | ` +
      `RSI: ${rsi?.toFixed(1)} | Trend: ${trend}`
    );

    this.emit('tick', { ...analysis });

    // Check take-profit / stop-loss for open position
    if (this.position) {
      const { side, takeProfitPrice, stopLossPrice } = this.position;
      if (side === 'LONG') {
        if (currentPrice >= takeProfitPrice) { await this.closePosition(currentPrice, 'take_profit'); return; }
        if (currentPrice <= stopLossPrice)   { await this.closePosition(currentPrice, 'stop_loss'); return; }
      } else {
        if (currentPrice <= takeProfitPrice) { await this.closePosition(currentPrice, 'take_profit'); return; }
        if (currentPrice >= stopLossPrice)   { await this.closePosition(currentPrice, 'stop_loss'); return; }
      }
    }

    const signal = this.getSignal(analysis);
    if (!signal) return;

    // Handle signal
    if (signal === 'LONG') {
      if (this.position?.side === 'SHORT') await this.closePosition(currentPrice, 'signal_reversal');
      if (!this.position) await this.openLong(currentPrice, atr);

    } else if (signal === 'SHORT') {
      if (this.position?.side === 'LONG') await this.closePosition(currentPrice, 'signal_reversal');
      if (!this.position) await this.openShort(currentPrice, atr);

    } else if (signal === 'CLOSE') {
      if (this.position) await this.closePosition(currentPrice, 'death_cross_exit');
    }
  }

  async start() {
    this.running = true;
    console.log(`[TREND] Trend Following Bot started | ${this.config.pair} ${this.config.interval} | dryRun=${this.config.dryRun}`);
    this.emit('start');

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.emit('error', err);
        console.error('[TREND] Error:', err.message);
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async stop() {
    this.running = false;
    const currentPrice = await this.client.getPrice(this.config.pair);
    if (this.position) await this.closePosition(currentPrice, 'bot_stopped');
    const winRate = this.stats.wins / (this.stats.wins + this.stats.losses) * 100;
    console.log('[TREND] Stopped. Stats:', { ...this.stats, winRate: winRate.toFixed(1) + '%' });
    this.emit('stop', this.stats);
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
const bot = new TrendFollowingBot(CONFIG);

bot.on('position_opened', (p) => console.log('[OPEN]', p.side, '@', p.entryPrice));
bot.on('position_closed', (p) => console.log('[CLOSE]', p.side, 'PnL: $' + p.netPnl?.toFixed(4)));
bot.on('error', (e) => console.error('[ERR]', e.message));

process.on('SIGINT', async () => { await bot.stop(); process.exit(0); });
bot.start();

module.exports = { TrendFollowingBot, Indicators };
