/**
 * TRIANGULAR ARBITRAGE BOT
 * Exploits pricing inefficiencies between 3 trading pairs on the same exchange.
 * Example cycle: USDT → BTC → ETH → USDT
 *
 * Requirements: npm install axios crypto-js
 */

const axios = require('axios');
const crypto = require('crypto');
const EventEmitter = require('events');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  exchange: {
    name: 'GenericExchange',
    baseUrl: 'https://api.exchange.com',
    apiKey: process.env.API_KEY,
    apiSecret: process.env.API_SECRET,
    takerFeePercent: 0.1,
  },

  // Define triangular cycles to monitor.
  // Each leg: { pair, action, base, quote }
  // action = 'buy'  → spend quote, receive base  (ask side)
  // action = 'sell' → spend base,  receive quote (bid side)
  cycles: [
    {
      name: 'USDT→BTC→ETH→USDT',
      legs: [
        { pair: 'BTCUSDT', action: 'buy',  base: 'BTC', quote: 'USDT' },
        { pair: 'ETHBTC',  action: 'buy',  base: 'ETH', quote: 'BTC'  },
        { pair: 'ETHUSDT', action: 'sell', base: 'ETH', quote: 'USDT' },
      ],
    },
    {
      name: 'USDT→ETH→BTC→USDT',
      legs: [
        { pair: 'ETHUSDT', action: 'buy',  base: 'ETH', quote: 'USDT' },
        { pair: 'ETHBTC',  action: 'sell', base: 'ETH', quote: 'BTC'  },
        { pair: 'BTCUSDT', action: 'sell', base: 'BTC', quote: 'USDT' },
      ],
    },
  ],

  startAmountUSDT: 500,       // capital to cycle through
  minProfitPercent: 0.2,      // minimum net profit after fees
  pollIntervalMs: 500,        // check every 500ms for tight windows
  dryRun: true,               // set false to execute real orders
};

// ─── EXCHANGE CLIENT ──────────────────────────────────────────────────────────
class ExchangeClient {
  constructor(config) {
    this.config = config;
    this.client = axios.create({ baseURL: config.baseUrl, timeout: 4000 });
    this._books = {}; // cache
  }

  _sign(query) {
    return crypto.createHmac('sha256', this.config.apiSecret).update(query).digest('hex');
  }

  _auth(params = {}) {
    const ts = Date.now();
    const q = new URLSearchParams({ ...params, timestamp: ts }).toString();
    return { params: { ...params, timestamp: ts, signature: this._sign(q) },
             headers: { 'X-API-KEY': this.config.apiKey } };
  }

  /**
   * Fetch all tickers in bulk (much faster than per-pair requests)
   * Returns: { [symbol]: { bid, ask, bidQty, askQty } }
   */
  async getAllTickers() {
    const res = await this.client.get('/v1/ticker/bookTicker');
    const tickers = {};
    for (const t of res.data) {
      tickers[t.symbol] = {
        bid: parseFloat(t.bidPrice),
        ask: parseFloat(t.askPrice),
        bidQty: parseFloat(t.bidQty),
        askQty: parseFloat(t.askQty),
      };
    }
    return tickers;
  }

  /**
   * Market order
   */
  async marketOrder(pair, side, quantity, quoteOrderQty = null) {
    const params = {
      symbol: pair,
      side: side.toUpperCase(),
      type: 'MARKET',
    };
    if (quoteOrderQty) {
      params.quoteOrderQty = quoteOrderQty.toFixed(2);
    } else {
      params.quantity = quantity.toFixed(6);
    }
    const res = await this.client.post('/v1/order', null, this._auth(params));
    return {
      orderId: res.data.orderId,
      executedQty: parseFloat(res.data.executedQty),
      cumulativeQuoteQty: parseFloat(res.data.cummulativeQuoteQty),
      status: res.data.status,
    };
  }
}

// ─── TRIANGULAR ARBITRAGE ENGINE ──────────────────────────────────────────────
class TriangularArbitrageBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.exchange = new ExchangeClient(config.exchange);
    this.running = false;
    this.stats = { checked: 0, opportunities: 0, executed: 0, totalProfitUSDT: 0 };
    this.feeMultiplier = 1 - config.exchange.takerFeePercent / 100;
  }

  /**
   * Simulate a cycle through all 3 legs using live ticker prices.
   * Returns the ending amount and profit %.
   */
  simulateCycle(cycle, tickers, startAmount) {
    let amount = startAmount;
    const steps = [];

    for (const leg of cycle.legs) {
      const ticker = tickers[leg.pair];
      if (!ticker) return null;

      let priceUsed, received;

      if (leg.action === 'buy') {
        // Spend quote, get base: amount / ask * feeMultiplier
        priceUsed = ticker.ask;
        received = (amount / priceUsed) * this.feeMultiplier;
      } else {
        // Spend base, get quote: amount * bid * feeMultiplier
        priceUsed = ticker.bid;
        received = amount * priceUsed * this.feeMultiplier;
      }

      steps.push({
        pair: leg.pair,
        action: leg.action,
        price: priceUsed,
        in: amount,
        out: received,
      });

      amount = received;
    }

    const profitPercent = ((amount - startAmount) / startAmount) * 100;
    return { steps, endAmount: amount, profitPercent };
  }

  /**
   * Execute a profitable cycle leg by leg
   */
  async executeCycle(cycle, simulation) {
    const results = [];
    let holdingQty = this.config.startAmountUSDT;
    let holdingAsset = 'USDT';

    for (let i = 0; i < cycle.legs.length; i++) {
      const leg = cycle.legs[i];
      const step = simulation.steps[i];

      console.log(
        `[TRI] Leg ${i + 1}: ${leg.action.toUpperCase()} ${leg.pair} @ ~${step.price} | ${holdingAsset} ${holdingQty.toFixed(4)}`
      );

      if (this.config.dryRun) {
        holdingQty = step.out;
        holdingAsset = leg.action === 'buy' ? leg.base : leg.quote;
        results.push({ dryRun: true, ...step });
        continue;
      }

      let order;
      if (leg.action === 'buy') {
        // quoteOrderQty = spend USDT/BTC amount
        order = await this.exchange.marketOrder(leg.pair, 'BUY', null, holdingQty);
        holdingQty = order.executedQty;
        holdingAsset = leg.base;
      } else {
        order = await this.exchange.marketOrder(leg.pair, 'SELL', holdingQty);
        holdingQty = order.cumulativeQuoteQty;
        holdingAsset = leg.quote;
      }

      results.push(order);

      // Small delay between legs to avoid rate limiting
      await new Promise((r) => setTimeout(r, 100));
    }

    const profit = holdingQty - this.config.startAmountUSDT;
    return { legs: results, finalAmount: holdingQty, profitUSDT: profit };
  }

  async tick() {
    const tickers = await this.exchange.getAllTickers();
    this.stats.checked++;

    for (const cycle of this.config.cycles) {
      const sim = this.simulateCycle(cycle, tickers, this.config.startAmountUSDT);
      if (!sim) continue;

      this.emit('cycle_checked', {
        name: cycle.name,
        profitPercent: sim.profitPercent.toFixed(4),
        endAmount: sim.endAmount.toFixed(4),
      });

      if (sim.profitPercent > this.config.minProfitPercent) {
        this.stats.opportunities++;
        console.log(
          `[TRI] ✅ Opportunity: ${cycle.name} | Profit: ${sim.profitPercent.toFixed(4)}%`
        );
        this.emit('opportunity', { cycle: cycle.name, simulation: sim });

        try {
          const result = await this.executeCycle(cycle, sim);
          this.stats.executed++;
          this.stats.totalProfitUSDT += result.profitUSDT;
          this.emit('executed', { cycle: cycle.name, ...result });
          console.log(
            `[TRI] Executed: ${cycle.name} | Profit: $${result.profitUSDT.toFixed(4)} | Total: $${this.stats.totalProfitUSDT.toFixed(4)}`
          );
        } catch (err) {
          this.emit('error', { stage: 'execution', cycle: cycle.name, err: err.message });
          console.error(`[TRI] Execution error on ${cycle.name}:`, err.message);
        }
      }
    }
  }

  async start() {
    this.running = true;
    console.log(`[TRI] Triangular Arbitrage Bot started | dryRun=${this.config.dryRun}`);
    this.emit('start');

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.emit('error', { stage: 'tick', err: err.message });
        console.error('[TRI] Tick error:', err.message);
      }
      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  stop() {
    this.running = false;
    console.log('[TRI] Stopped. Stats:', this.stats);
    this.emit('stop', this.stats);
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
const bot = new TriangularArbitrageBot(CONFIG);

bot.on('cycle_checked', (c) => {
  if (parseFloat(c.profitPercent) > 0)
    console.log(`[CHECK] ${c.name}: ${c.profitPercent}% → $${c.endAmount}`);
});
bot.on('opportunity', (o) => console.log('[OPP]', o.cycle));
bot.on('executed', (r) => console.log('[DONE]', r.cycle, '$' + r.profitUSDT?.toFixed(4)));
bot.on('error', (e) => console.error('[ERR]', e));

process.on('SIGINT', () => bot.stop());
bot.start();

module.exports = { TriangularArbitrageBot };
