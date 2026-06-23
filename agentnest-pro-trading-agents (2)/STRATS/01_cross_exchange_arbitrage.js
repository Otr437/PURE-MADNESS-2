/**
 * CROSS-EXCHANGE ARBITRAGE BOT
 * Monitors price differences for the same asset across two exchanges
 * and executes buy/sell when spread exceeds threshold after fees.
 *
 * Requirements: npm install axios crypto-js
 */

const axios = require('axios');
const crypto = require('crypto');
const EventEmitter = require('events');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  symbol: 'BTC/USDT',
  minProfitPercent: 0.3,   // minimum profit after fees (%)
  tradeAmountUSDT: 100,    // how much to trade per arb
  pollIntervalMs: 1000,    // how often to check prices
  maxSlippagePercent: 0.1, // cancel if slippage exceeds this

  exchangeA: {
    name: 'ExchangeA',
    baseUrl: 'https://api.exchange-a.com',
    apiKey: process.env.EXCHANGE_A_API_KEY,
    apiSecret: process.env.EXCHANGE_A_API_SECRET,
    takerFeePercent: 0.1,
  },
  exchangeB: {
    name: 'ExchangeB',
    baseUrl: 'https://api.exchange-b.com',
    apiKey: process.env.EXCHANGE_B_API_KEY,
    apiSecret: process.env.EXCHANGE_B_API_SECRET,
    takerFeePercent: 0.1,
  },
};

// ─── EXCHANGE CLIENT ──────────────────────────────────────────────────────────
class ExchangeClient {
  constructor(config) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: 5000,
    });
  }

  _sign(queryString) {
    return crypto
      .createHmac('sha256', this.config.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  _authHeaders(params = {}) {
    const timestamp = Date.now();
    const query = new URLSearchParams({ ...params, timestamp }).toString();
    const signature = this._sign(query);
    return {
      headers: { 'X-API-KEY': this.config.apiKey },
      params: { ...params, timestamp, signature },
    };
  }

  /**
   * Fetch best bid/ask from order book
   * @returns {{ bid: number, ask: number, bidSize: number, askSize: number }}
   */
  async getOrderBook(symbol) {
    const pair = symbol.replace('/', '');
    const res = await this.client.get('/v1/orderbook', {
      params: { symbol: pair, limit: 5 },
    });
    const { bids, asks } = res.data;
    return {
      bid: parseFloat(bids[0][0]),
      bidSize: parseFloat(bids[0][1]),
      ask: parseFloat(asks[0][0]),
      askSize: parseFloat(asks[0][1]),
    };
  }

  /**
   * Get account balances
   * @returns {{ [asset]: { free: number, locked: number } }}
   */
  async getBalances() {
    const res = await this.client.get('/v1/account', this._authHeaders());
    const balances = {};
    for (const b of res.data.balances) {
      balances[b.asset] = {
        free: parseFloat(b.free),
        locked: parseFloat(b.locked),
      };
    }
    return balances;
  }

  /**
   * Place a market order
   * @returns {{ orderId, executedQty, executedPrice, status }}
   */
  async marketOrder(symbol, side, quantity) {
    const pair = symbol.replace('/', '');
    const params = {
      symbol: pair,
      side: side.toUpperCase(), // BUY or SELL
      type: 'MARKET',
      quantity: quantity.toFixed(6),
    };
    const res = await this.client.post(
      '/v1/order',
      null,
      this._authHeaders(params)
    );
    return {
      orderId: res.data.orderId,
      executedQty: parseFloat(res.data.executedQty),
      executedPrice: parseFloat(res.data.cummulativeQuoteQty) / parseFloat(res.data.executedQty),
      status: res.data.status,
    };
  }
}

// ─── ARBITRAGE ENGINE ─────────────────────────────────────────────────────────
class CrossExchangeArbitrageBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.exchangeA = new ExchangeClient(config.exchangeA);
    this.exchangeB = new ExchangeClient(config.exchangeB);
    this.running = false;
    this.stats = {
      opportunities: 0,
      executed: 0,
      failed: 0,
      totalProfitUSDT: 0,
    };
  }

  /**
   * Calculate net profit % after fees for a given direction:
   * buy on `buyEx` at `buyAsk`, sell on `sellEx` at `sellBid`
   */
  calcNetProfit(buyAsk, sellBid, buyFee, sellFee) {
    const grossSpread = (sellBid - buyAsk) / buyAsk;
    const totalFees = buyFee / 100 + sellFee / 100;
    return (grossSpread - totalFees) * 100; // return as %
  }

  /**
   * Check both directions for arbitrage opportunity
   */
  async checkOpportunity() {
    const [bookA, bookB] = await Promise.all([
      this.exchangeA.getOrderBook(this.config.symbol),
      this.exchangeB.getOrderBook(this.config.symbol),
    ]);

    const feeA = this.config.exchangeA.takerFeePercent;
    const feeB = this.config.exchangeB.takerFeePercent;

    // Direction 1: Buy on A, Sell on B
    const profitAtoB = this.calcNetProfit(bookA.ask, bookB.bid, feeA, feeB);

    // Direction 2: Buy on B, Sell on A
    const profitBtoA = this.calcNetProfit(bookB.ask, bookA.bid, feeB, feeA);

    this.emit('prices', {
      exchangeA: { bid: bookA.bid, ask: bookA.ask },
      exchangeB: { bid: bookB.bid, ask: bookB.ask },
      profitAtoB: profitAtoB.toFixed(4),
      profitBtoA: profitBtoA.toFixed(4),
    });

    if (profitAtoB > this.config.minProfitPercent) {
      return {
        direction: 'A_to_B',
        buyExchange: this.exchangeA,
        sellExchange: this.exchangeB,
        buyPrice: bookA.ask,
        sellPrice: bookB.bid,
        netProfitPercent: profitAtoB,
        availableSize: Math.min(bookA.askSize, bookB.bidSize),
      };
    }

    if (profitBtoA > this.config.minProfitPercent) {
      return {
        direction: 'B_to_A',
        buyExchange: this.exchangeB,
        sellExchange: this.exchangeA,
        buyPrice: bookB.ask,
        sellPrice: bookA.bid,
        netProfitPercent: profitBtoA,
        availableSize: Math.min(bookB.askSize, bookA.bidSize),
      };
    }

    return null;
  }

  /**
   * Execute arbitrage: simultaneous buy + sell
   */
  async executeArbitrage(opportunity) {
    const { buyExchange, sellExchange, buyPrice, netProfitPercent } = opportunity;

    // Quantity to trade
    const quantity = this.config.tradeAmountUSDT / buyPrice;

    // Slippage guard — re-fetch before executing
    const freshBook = await buyExchange.getOrderBook(this.config.symbol);
    const slippage = Math.abs(freshBook.ask - buyPrice) / buyPrice * 100;
    if (slippage > this.config.maxSlippagePercent) {
      this.emit('slippage_abort', { slippage: slippage.toFixed(4) });
      return null;
    }

    // Fire both legs simultaneously
    const [buyResult, sellResult] = await Promise.all([
      buyExchange.marketOrder(this.config.symbol, 'BUY', quantity),
      sellExchange.marketOrder(this.config.symbol, 'SELL', quantity),
    ]);

    const actualProfit =
      sellResult.executedPrice * sellResult.executedQty -
      buyResult.executedPrice * buyResult.executedQty;

    this.stats.executed++;
    this.stats.totalProfitUSDT += actualProfit;

    return {
      buyOrder: buyResult,
      sellOrder: sellResult,
      estimatedProfitPercent: netProfitPercent,
      actualProfitUSDT: actualProfit.toFixed(4),
    };
  }

  async start() {
    this.running = true;
    this.emit('start', { config: this.config });
    console.log('[ARB] Cross-Exchange Arbitrage Bot started');

    while (this.running) {
      try {
        const opportunity = await this.checkOpportunity();

        if (opportunity) {
          this.stats.opportunities++;
          this.emit('opportunity', opportunity);
          console.log(
            `[ARB] Opportunity: ${opportunity.direction} | Net profit: ${opportunity.netProfitPercent.toFixed(3)}%`
          );

          const result = await this.executeArbitrage(opportunity);
          if (result) {
            this.emit('executed', result);
            console.log(
              `[ARB] Executed | Profit: $${result.actualProfitUSDT} | Total: $${this.stats.totalProfitUSDT.toFixed(4)}`
            );
          }
        }
      } catch (err) {
        this.stats.failed++;
        this.emit('error', err);
        console.error('[ARB] Error:', err.message);
      }

      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  stop() {
    this.running = false;
    this.emit('stop', this.stats);
    console.log('[ARB] Stopped. Stats:', this.stats);
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
const bot = new CrossExchangeArbitrageBot(CONFIG);

bot.on('prices', (p) => {
  console.log(
    `[PRICES] A(bid=${p.exchangeA.bid} ask=${p.exchangeA.ask}) ` +
    `B(bid=${p.exchangeB.bid} ask=${p.exchangeB.ask}) ` +
    `A→B: ${p.profitAtoB}% | B→A: ${p.profitBtoA}%`
  );
});
bot.on('opportunity', (o) => console.log('[OPP]', o.direction, o.netProfitPercent.toFixed(3) + '%'));
bot.on('executed', (r) => console.log('[DONE] Profit:', r.actualProfitUSDT));
bot.on('slippage_abort', (s) => console.warn('[ABORT] Slippage too high:', s.slippage + '%'));
bot.on('error', (e) => console.error('[ERR]', e.message));

process.on('SIGINT', () => bot.stop());
bot.start();

module.exports = { CrossExchangeArbitrageBot, ExchangeClient };
