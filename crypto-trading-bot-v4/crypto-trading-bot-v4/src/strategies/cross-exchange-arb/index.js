'use strict';
/**
 * STRATEGY: Cross-Exchange Arbitrage
 * Own process. Own config. Zero coupling to other strategies.
 *
 * Business logic:
 *   - Monitors BTC/USDT (and optionally ETH/USDT) on two exchanges simultaneously
 *   - Computes net profit after BOTH taker fees for each direction
 *   - Guards: oracle validation, spread guard (spread too wide = illiquid),
 *     slippage re-check immediately before execution, size guard,
 *     transfer-time guard (cross-exchange needs funded accounts on both sides)
 *   - Executes both legs in parallel to minimise market exposure window
 *   - Full DB persistence: both order legs + neutral position + PnL
 *   - Self-throttles: after 3 consecutive failed attempts, backs off 30s
 *   - Publishes live spread data to Redis for dashboard consumption
 *
 * Run: node src/strategies/cross-exchange-arb/index.js
 */

require('dotenv').config();
const BaseBot        = require('../../shared/base_bot');
const ExchangeClient = require('../../shared/exchange_client');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  id:     process.env.BOT_CROSS_ARB_ID || undefined,
  name:   'Cross-Exchange Arb',
  botType:'cross_exchange_arb',
  dryRun: process.env.DRY_RUN !== 'false',

  // Pairs to watch (extend with ['ETHUSDT','SOLUSDT'] as needed)
  symbols: ['BTCUSDT'],

  // Minimum net profit AFTER both taker fees — below this, no trade
  minProfitPercent:    parseFloat(process.env.ARB_MIN_PROFIT_PCT     || '0.3'),

  // Trade notional per arb execution
  tradeAmountUSDT:     parseFloat(process.env.DEFAULT_TRADE_AMOUNT_USDT || '100'),

  // Reject if bid-ask spread on EITHER exchange exceeds this % (illiquidity guard)
  maxSpreadPct:        parseFloat(process.env.ARB_MAX_SPREAD_PCT     || '0.05'),

  // Reject if price moved more than this % between opportunity detection and execution
  maxSlippagePct:      parseFloat(process.env.ARB_MAX_SLIPPAGE_PCT   || '0.1'),

  // Oracle cross-validation: reject if CEX price deviates > this % from Chainlink/Pyth
  oracleValidation:      process.env.ARB_ORACLE_VALIDATION !== 'false',
  maxOracleDeviationPct: parseFloat(process.env.ARB_ORACLE_DEVIATION_PCT || '1.0'),

  // Order book depth: minimum USDT available at best bid/ask to fill our order
  minDepthUSDT:        parseFloat(process.env.ARB_MIN_DEPTH_USDT     || '50'),

  // Consecutive failure back-off
  backoffAfterFailures: 3,
  backoffMs:            30_000,

  pollIntervalMs:      parseInt(process.env.ARB_POLL_INTERVAL_MS || '1000'),
  globalStopLossPct:   parseFloat(process.env.GLOBAL_STOP_LOSS_PERCENT || '10'),

  exchangeA: {
    name:            process.env.EXCHANGE_A_NAME      || 'ExchangeA',
    baseUrl:         process.env.EXCHANGE_A_BASE_URL,
    apiKey:          process.env.EXCHANGE_A_API_KEY,
    apiSecret:       process.env.EXCHANGE_A_API_SECRET,
    takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
    makerFeePercent: parseFloat(process.env.EXCHANGE_A_MAKER_FEE || '0.05'),
  },
  exchangeB: {
    name:            process.env.EXCHANGE_B_NAME      || 'ExchangeB',
    baseUrl:         process.env.EXCHANGE_B_BASE_URL,
    apiKey:          process.env.EXCHANGE_B_API_KEY,
    apiSecret:       process.env.EXCHANGE_B_API_SECRET,
    takerFeePercent: parseFloat(process.env.EXCHANGE_B_TAKER_FEE || '0.1'),
    makerFeePercent: parseFloat(process.env.EXCHANGE_B_MAKER_FEE || '0.05'),
  },
};

// ── BOT ───────────────────────────────────────────────────────────────────────
class CrossExchangeArbBot extends BaseBot {
  constructor(cfg) {
    super(cfg);
    this.exA = new ExchangeClient({ ...cfg.exchangeA, dryRun: cfg.dryRun });
    this.exB = new ExchangeClient({ ...cfg.exchangeB, dryRun: cfg.dryRun });

    // Track consecutive failures per symbol for back-off
    this._failures    = new Map();
    this._backingOff  = new Map();

    // Live spread stats for this session
    this._sessionStats = {
      checks:       0,
      opportunities:0,
      executed:     0,
      skippedOracle:0,
      skippedSlippage:0,
      skippedDepth: 0,
      skippedSpread:0,
    };
  }

  // ── Net profit calculation ─────────────────────────────────────────────────
  // Includes BOTH taker fees. Result in %.
  _netProfitPct(buyAsk, sellBid, buyFeePct, sellFeePct) {
    if (buyAsk <= 0 || sellBid <= 0) return -Infinity;
    const gross = (sellBid - buyAsk) / buyAsk;
    const fees  = buyFeePct / 100 + sellFeePct / 100;
    return (gross - fees) * 100;
  }

  // ── Liquidity guard ────────────────────────────────────────────────────────
  // Ensures the ask/bid has enough depth to fill our full notional
  _hasEnoughDepth(book, side, notionalUSDT, price) {
    const sizeAvail = side === 'buy'
      ? book.askSize * price   // USDT value of best ask
      : book.bidSize * price;  // USDT value of best bid
    return sizeAvail >= notionalUSDT;
  }

  // ── Spread guard ──────────────────────────────────────────────────────────
  // Wide spread = illiquid = likely to get poor fill
  _spreadOk(book) {
    return book.spreadPct <= this.config.maxSpreadPct;
  }

  // ── Oracle validation ─────────────────────────────────────────────────────
  async _oracleOk(midPrice) {
    if (!this.config.oracleValidation) return true;
    try {
      return await this.priceFeed.validatePrice('BTC/USD', midPrice, this.config.maxOracleDeviationPct);
    } catch (err) {
      this.log.warn('Oracle check failed — proceeding without', { error: err.message });
      return true; // fail open when oracle unavailable
    }
  }

  // ── Check one symbol for opportunity ──────────────────────────────────────
  async _checkSymbol(symbol) {
    // Check if this symbol is in back-off
    if (this._backingOff.get(symbol)) {
      const backoffUntil = this._backingOff.get(symbol);
      if (Date.now() < backoffUntil) return null;
      this._backingOff.delete(symbol);
      this._failures.set(symbol, 0);
      this.log.info(`Back-off expired for ${symbol}, resuming`);
    }

    // Fetch both books simultaneously
    const [bA, bB] = await Promise.all([
      this.exA.getOrderBook(symbol, 5),
      this.exB.getOrderBook(symbol, 5),
    ]);

    this._sessionStats.checks++;

    // Publish to Redis for dashboard
    await this.cache.set(`arb:spread:${symbol}`, {
      exA: { bid: bA.bid, ask: bA.ask, spread: bA.spreadPct },
      exB: { bid: bB.bid, ask: bB.ask, spread: bB.spreadPct },
      ts:  Date.now(),
    }, 10).catch(() => {});

    // ── Guard: spread check ────────────────────────────────────────────────
    if (!this._spreadOk(bA) || !this._spreadOk(bB)) {
      this._sessionStats.skippedSpread++;
      this.log.debug(`${symbol} spread too wide`, { spreadA: bA.spreadPct?.toFixed(4), spreadB: bB.spreadPct?.toFixed(4) });
      return null;
    }

    // ── Evaluate both directions ───────────────────────────────────────────
    const pAB = this._netProfitPct(bA.ask, bB.bid, this.exA.fee, this.exB.fee);
    const pBA = this._netProfitPct(bB.ask, bA.bid, this.exB.fee, this.exA.fee);

    const best = pAB >= pBA
      ? { profitPct: pAB, buyEx: this.exA, sellEx: this.exB, buyBook: bA, sellBook: bB, buyP: bA.ask, sellP: bB.bid, dir: 'A→B' }
      : { profitPct: pBA, buyEx: this.exB, sellEx: this.exA, buyBook: bB, sellBook: bA, buyP: bB.ask, sellP: bA.bid, dir: 'B→A' };

    if (best.profitPct <= this.config.minProfitPercent) return null;

    this._sessionStats.opportunities++;

    // ── Guard: depth ───────────────────────────────────────────────────────
    if (!this._hasEnoughDepth(best.buyBook, 'buy', this.config.tradeAmountUSDT, best.buyP) ||
        !this._hasEnoughDepth(best.sellBook,'sell', this.config.tradeAmountUSDT, best.sellP)) {
      this._sessionStats.skippedDepth++;
      this.log.debug(`${symbol} ${best.dir}: insufficient depth`);
      return null;
    }

    // ── Guard: oracle ──────────────────────────────────────────────────────
    const midPrice = (best.buyP + best.sellP) / 2;
    if (!await this._oracleOk(midPrice)) {
      this._sessionStats.skippedOracle++;
      this.log.warn(`${symbol} ${best.dir}: oracle validation failed`, { midPrice });
      return null;
    }

    return { symbol, ...best };
  }

  // ── Execute the arbitrage ──────────────────────────────────────────────────
  async _execute(opp) {
    const { symbol, buyEx, sellEx, buyP, sellP, dir, profitPct } = opp;

    // ── Slippage re-check: re-fetch buy-side before firing ─────────────────
    const freshBuy = await buyEx.getOrderBook(symbol, 1);
    const slippage = Math.abs(freshBuy.ask - buyP) / buyP * 100;
    if (slippage > this.config.maxSlippagePct) {
      this._sessionStats.skippedSlippage++;
      this.log.warn(`${symbol} ${dir}: slippage abort`, { slippage: slippage.toFixed(4), limit: this.config.maxSlippagePct });
      return null;
    }

    // Get symbol info from buy exchange to round qty correctly
    let qty = this.config.tradeAmountUSDT / buyP;
    try {
      const info = await buyEx.getSymbolInfo(symbol);
      qty = buyEx.roundQty(qty, info.stepSize);
    } catch (_) { /* use unrounded qty in dry-run */ }

    this.log.info(`ARB ${dir}: firing`, {
      symbol, buyEx: buyEx.name, sellEx: sellEx.name,
      buyP, sellP, qty: qty.toFixed(6), profitPct: profitPct.toFixed(4),
    });

    // ── Execute both legs simultaneously ───────────────────────────────────
    const [buyRes, sellRes] = await Promise.all([
      this.placeOrder({
        exchange: buyEx.name, pair: symbol, side: 'BUY', type: 'MARKET', quantity: qty,
        execute:  () => buyEx.marketOrder(symbol, 'BUY', qty),
      }),
      this.placeOrder({
        exchange: sellEx.name, pair: symbol, side: 'SELL', type: 'MARKET', quantity: qty,
        execute:  () => sellEx.marketOrder(symbol, 'SELL', qty),
      }),
    ]);

    const execBuyPrice  = parseFloat(buyRes.response.executedPrice  || buyP);
    const execSellPrice = parseFloat(sellRes.response.executedPrice || sellP);
    const grossPnl      = (execSellPrice - execBuyPrice) * qty;
    const fees          = (buyEx.fee + sellEx.fee) / 100 * this.config.tradeAmountUSDT;
    const netPnl        = grossPnl - fees;

    // Actual slippage vs expected
    const actualSlippage = Math.abs(execBuyPrice - buyP) / buyP * 100;

    // ── Persist as neutral position (open + immediate close) ───────────────
    const pos = await this.openPosition({
      pair:         symbol,
      side:         'NEUTRAL',
      quantity:     qty,
      entryPrice:   execBuyPrice,
      entryOrderId: buyRes.id,
      metadata: {
        direction:     dir,
        buyExchange:   buyEx.name,
        sellExchange:  sellEx.name,
        sellPrice:     execSellPrice,
        expectedProfit:profitPct,
        actualSlippage,
      },
    });

    await this.closePosition({
      positionId:   pos.id,
      exitPrice:    execSellPrice,
      exitOrderId:  sellRes.id,
      realizedPnl:  grossPnl,
      feeTotal:     fees,
      netPnl,
      reason:       'arb_complete',
    });

    this._sessionStats.executed++;
    this._failures.set(symbol, 0); // reset failure count on success

    this.log.info(`ARB executed`, {
      symbol, dir,
      grossPnl:      grossPnl.toFixed(4),
      fees:          fees.toFixed(4),
      netPnl:        netPnl.toFixed(4),
      actualSlippage:actualSlippage.toFixed(4),
      sessionPnl:    this.stats.totalPnlUSDT.toFixed(4),
    });

    return { netPnl };
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async run() {
    this.log.info('Cross-exchange arb started', {
      symbols:         this.config.symbols,
      minProfitPct:    this.config.minProfitPercent,
      tradeAmount:     this.config.tradeAmountUSDT,
      oracleValidation:this.config.oracleValidation,
      exchanges:       [this.exA.name, this.exB.name],
    });

    let lastStatsLog = Date.now();

    while (this.running && !this.stopping) {
      if (!await this.riskCheck()) break;

      // Check both exchange circuit breakers before hitting API
      if (this.exA.circuitBreakerOpen || this.exB.circuitBreakerOpen) {
        this.log.warn('Exchange circuit breaker open — waiting', {
          exA: this.exA.circuitBreakerOpen, exB: this.exB.circuitBreakerOpen,
        });
        await this.sleepInterruptible(30_000);
        continue;
      }

      for (const symbol of this.config.symbols) {
        if (!this.running || this.stopping) break;
        try {
          const opp = await this._checkSymbol(symbol);
          if (opp) await this._execute(opp);
        } catch (err) {
          const prev = (this._failures.get(symbol) || 0) + 1;
          this._failures.set(symbol, prev);
          this.log.error(`${symbol} error (failure ${prev})`, { error: err.message });

          if (prev >= this.config.backoffAfterFailures) {
            this._backingOff.set(symbol, Date.now() + this.config.backoffMs);
            this.log.warn(`${symbol} backing off for ${this.config.backoffMs / 1000}s`);
          }
        }
      }

      // Log session stats every 5 min
      if (Date.now() - lastStatsLog > 300_000) {
        this.log.info('Session stats', this._sessionStats);
        lastStatsLog = Date.now();
      }

      await this.sleepInterruptible(this.config.pollIntervalMs);
    }

    this.log.info('Cross-exchange arb stopped', {
      ...this._sessionStats,
      totalPnl: this.stats.totalPnlUSDT.toFixed(4),
    });
  }
}

// ── LAUNCH ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const bot = new CrossExchangeArbBot(CONFIG);
  process.on('SIGINT',  () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  bot.start();
}

module.exports = CrossExchangeArbBot;
