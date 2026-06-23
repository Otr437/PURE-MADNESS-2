/**
 * GRID TRADING BOT
 *
 * Strategy:
 *   - Place a ladder of buy/sell limit orders at equal price intervals
 *   - When a buy fills → immediately place sell one grid level above
 *   - When a sell fills → immediately place buy one grid level below
 *   - Profits from oscillation within the defined range
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
    makerFeePercent: 0.05,
    takerFeePercent: 0.1,
  },

  pair: 'BTCUSDT',

  // Grid parameters
  gridLower: 80000,    // lower price bound
  gridUpper: 100000,   // upper price bound
  gridLevels: 10,      // number of grid lines (creates 9 intervals)
  totalCapitalUSDT: 1000, // total capital to spread across grid

  // Safety
  stopLossPercent: 15,     // stop bot if price drops this % below lower bound
  takeProfitPercent: 20,   // stop bot if price rises this % above upper bound

  pollIntervalMs: 2000,    // check order status every 2s
  dryRun: true,
};

// ─── EXCHANGE CLIENT ──────────────────────────────────────────────────────────
class ExchangeClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.http = axios.create({ baseURL: cfg.baseUrl, timeout: 6000 });
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

  async placeLimitOrder(pair, side, quantity, price) {
    if (this.cfg.dryRun) {
      const id = `dry-${side}-${price}-${Date.now()}`;
      console.log(`[DRY] LIMIT ${side} ${quantity.toFixed(6)} ${pair} @ $${price}`);
      return { orderId: id, status: 'NEW', price, quantity };
    }
    const r = await this.http.post('/v1/order', null, this._auth({
      symbol: pair, side: side.toUpperCase(), type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: quantity.toFixed(6),
      price: price.toFixed(2),
    }));
    return r.data;
  }

  async cancelOrder(pair, orderId) {
    if (this.cfg.dryRun) {
      console.log(`[DRY] Cancel order ${orderId}`);
      return { orderId, status: 'CANCELED' };
    }
    const r = await this.http.delete('/v1/order', this._auth({ symbol: pair, orderId }));
    return r.data;
  }

  async getOpenOrders(pair) {
    const r = await this.http.get('/v1/openOrders', this._auth({ symbol: pair }));
    return r.data;
  }

  async getOrder(pair, orderId) {
    if (this.cfg.dryRun) {
      // Simulate random fills in dry run
      const shouldFill = Math.random() < 0.15; // 15% chance per poll
      return { orderId, status: shouldFill ? 'FILLED' : 'NEW' };
    }
    const r = await this.http.get('/v1/order', this._auth({ symbol: pair, orderId }));
    return r.data;
  }

  async cancelAllOrders(pair) {
    const r = await this.http.delete('/v1/openOrders', this._auth({ symbol: pair }));
    return r.data;
  }
}

// ─── GRID ENGINE ──────────────────────────────────────────────────────────────
class GridBot extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = new ExchangeClient({ ...config.exchange, dryRun: config.dryRun });
    this.running = false;

    // Grid state
    this.gridLevels = [];     // [{ price, index }]
    this.orders = new Map();  // orderId → { level, side, price, quantity, status }
    this.stats = {
      buysFilled: 0,
      sellsFilled: 0,
      totalProfitUSDT: 0,
      totalFeesUSDT: 0,
    };
  }

  /** Build evenly-spaced grid levels */
  buildGrid() {
    const { gridLower, gridUpper, gridLevels } = this.config;
    const step = (gridUpper - gridLower) / (gridLevels - 1);
    this.gridLevels = [];
    for (let i = 0; i < gridLevels; i++) {
      this.gridLevels.push({
        index: i,
        price: parseFloat((gridLower + step * i).toFixed(2)),
      });
    }
    console.log('[GRID] Grid levels:', this.gridLevels.map((g) => `$${g.price}`).join(' | '));
    return this.gridLevels;
  }

  /** Quantity per grid level */
  getQuantityPerLevel(price) {
    const usdtPerLevel = this.config.totalCapitalUSDT / (this.config.gridLevels - 1);
    return usdtPerLevel / price;
  }

  /**
   * Place initial grid orders:
   * - BUY orders at all levels below current price
   * - SELL orders at all levels above current price
   */
  async placeInitialOrders(currentPrice) {
    console.log(`[GRID] Placing initial orders. Current price: $${currentPrice}`);

    for (const level of this.gridLevels) {
      const qty = this.getQuantityPerLevel(level.price);

      if (level.price < currentPrice) {
        // Place buy below current price
        const order = await this.client.placeLimitOrder(
          this.config.pair, 'BUY', qty, level.price
        );
        this.orders.set(order.orderId, {
          orderId: order.orderId,
          level: level.index,
          side: 'BUY',
          price: level.price,
          quantity: qty,
          status: 'NEW',
        });
        await new Promise((r) => setTimeout(r, 100)); // rate limit
      } else if (level.price > currentPrice) {
        // Place sell above current price
        const order = await this.client.placeLimitOrder(
          this.config.pair, 'SELL', qty, level.price
        );
        this.orders.set(order.orderId, {
          orderId: order.orderId,
          level: level.index,
          side: 'SELL',
          price: level.price,
          quantity: qty,
          status: 'NEW',
        });
        await new Promise((r) => setTimeout(r, 100));
      }
      // Skip level at current price
    }

    console.log(`[GRID] ${this.orders.size} orders placed.`);
    this.emit('grid_initialized', { levels: this.gridLevels.length, orders: this.orders.size });
  }

  /**
   * When a BUY fills → place SELL one level above
   * When a SELL fills → place BUY one level below
   */
  async handleFill(filledOrder) {
    const { level, side, price, quantity } = filledOrder;

    if (side === 'BUY') {
      this.stats.buysFilled++;
      const nextLevel = this.gridLevels[level + 1];
      if (!nextLevel) return;

      // Profit per grid = sell_price - buy_price - fees
      const gridStep = nextLevel.price - price;
      const feeUSDT =
        (this.config.exchange.makerFeePercent / 100) * price * quantity * 2;
      const profit = gridStep * quantity - feeUSDT;
      this.stats.totalProfitUSDT += profit;
      this.stats.totalFeesUSDT += feeUSDT;

      console.log(
        `[GRID] BUY filled @ $${price} | Placing SELL @ $${nextLevel.price} | Expected profit: $${profit.toFixed(4)}`
      );

      const sellOrder = await this.client.placeLimitOrder(
        this.config.pair, 'SELL', quantity, nextLevel.price
      );
      this.orders.set(sellOrder.orderId, {
        orderId: sellOrder.orderId,
        level: level + 1,
        side: 'SELL',
        price: nextLevel.price,
        quantity,
        status: 'NEW',
        pairedBuyPrice: price,
      });

      this.emit('buy_filled', { price, nextSellPrice: nextLevel.price, expectedProfit: profit });

    } else if (side === 'SELL') {
      this.stats.sellsFilled++;
      const prevLevel = this.gridLevels[level - 1];
      if (!prevLevel) return;

      console.log(`[GRID] SELL filled @ $${price} | Placing BUY @ $${prevLevel.price}`);

      const buyOrder = await this.client.placeLimitOrder(
        this.config.pair, 'BUY', quantity, prevLevel.price
      );
      this.orders.set(buyOrder.orderId, {
        orderId: buyOrder.orderId,
        level: level - 1,
        side: 'BUY',
        price: prevLevel.price,
        quantity,
        status: 'NEW',
      });

      this.emit('sell_filled', { price, nextBuyPrice: prevLevel.price });
    }
  }

  /** Poll all active orders for fills */
  async checkOrders() {
    const activeOrders = [...this.orders.values()].filter((o) => o.status === 'NEW');

    for (const order of activeOrders) {
      try {
        const fresh = await this.client.getOrder(this.config.pair, order.orderId);
        if (fresh.status === 'FILLED') {
          order.status = 'FILLED';
          this.orders.delete(order.orderId);
          await this.handleFill(order);
        }
      } catch (err) {
        console.error(`[GRID] Error checking order ${order.orderId}:`, err.message);
      }
    }
  }

  /** Check if price has breached stop-loss or take-profit bounds */
  async checkBounds(currentPrice) {
    const stopLossPrice = this.config.gridLower * (1 - this.config.stopLossPercent / 100);
    const takeProfitPrice = this.config.gridUpper * (1 + this.config.takeProfitPercent / 100);

    if (currentPrice <= stopLossPrice) {
      console.log(`[GRID] ⚠️ STOP LOSS triggered @ $${currentPrice}`);
      this.emit('stop_loss', { price: currentPrice });
      await this.shutdown('stop_loss');
      return false;
    }
    if (currentPrice >= takeProfitPrice) {
      console.log(`[GRID] ✅ TAKE PROFIT triggered @ $${currentPrice}`);
      this.emit('take_profit', { price: currentPrice });
      await this.shutdown('take_profit');
      return false;
    }
    return true;
  }

  async shutdown(reason) {
    this.running = false;
    console.log(`[GRID] Shutting down (${reason}). Cancelling all orders...`);
    await this.client.cancelAllOrders(this.config.pair);
    console.log('[GRID] All orders cancelled. Stats:', this.stats);
    this.emit('shutdown', { reason, stats: this.stats });
  }

  async start() {
    this.running = true;
    console.log(`[GRID] Grid Bot started | ${this.config.pair} | dryRun=${this.config.dryRun}`);
    console.log(`[GRID] Range: $${this.config.gridLower} – $${this.config.gridUpper} | Levels: ${this.config.gridLevels} | Capital: $${this.config.totalCapitalUSDT}`);
    this.emit('start');

    this.buildGrid();
    const currentPrice = await this.client.getPrice(this.config.pair);
    await this.placeInitialOrders(currentPrice);

    let lastLogTime = 0;

    while (this.running) {
      try {
        const price = await this.client.getPrice(this.config.pair);

        // Log stats every 30s
        if (Date.now() - lastLogTime > 30000) {
          const activeOrders = [...this.orders.values()].filter((o) => o.status === 'NEW').length;
          console.log(
            `[GRID] Price: $${price} | Active orders: ${activeOrders} | ` +
            `Buys: ${this.stats.buysFilled} | Sells: ${this.stats.sellsFilled} | ` +
            `Profit: $${this.stats.totalProfitUSDT.toFixed(4)}`
          );
          lastLogTime = Date.now();
        }

        const inBounds = await this.checkBounds(price);
        if (!inBounds) break;

        await this.checkOrders();

      } catch (err) {
        this.emit('error', err);
        console.error('[GRID] Error:', err.message);
      }

      await new Promise((r) => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  async stop() {
    await this.shutdown('manual_stop');
  }
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
const bot = new GridBot(CONFIG);

bot.on('buy_filled', (e) => console.log('[FILL] BUY→SELL', e));
bot.on('sell_filled', (e) => console.log('[FILL] SELL→BUY', e));
bot.on('stop_loss', (e) => console.error('[SL] Stop loss hit:', e.price));
bot.on('take_profit', (e) => console.log('[TP] Take profit hit:', e.price));
bot.on('shutdown', (e) => console.log('[SHUTDOWN]', e));
bot.on('error', (e) => console.error('[ERR]', e.message));

process.on('SIGINT', async () => { await bot.stop(); process.exit(0); });
bot.start();

module.exports = { GridBot };
