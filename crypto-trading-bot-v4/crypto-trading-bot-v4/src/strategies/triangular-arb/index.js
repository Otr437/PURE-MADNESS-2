'use strict';
/**
 * STRATEGY: Triangular Arbitrage
 * Exploits pricing inefficiencies between 3 pairs on ONE exchange.
 *
 * Business logic:
 *   - Simulates full cycle (3 legs) using live book tickers BEFORE committing
 *   - Profit simulation includes all 3 taker fees
 *   - Minimum profit threshold prevents trading noise and exchange jitter
 *   - Leg execution is sequential (same exchange, no concurrency needed)
 *   - Intermediate asset holding between legs is tracked for audit
 *   - Configurable cycle set — discovers all profitable cycles automatically
 *   - Logs each leg result so partial failures are fully traceable
 *   - Session tracking: avg profit per cycle, discovery rate
 *
 * Run: node src/strategies/triangular-arb/index.js
 */

require('dotenv').config();
const BaseBot        = require('../../shared/base_bot');
const ExchangeClient = require('../../shared/exchange_client');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  id:      process.env.BOT_TRI_ARB_ID || undefined,
  name:    'Triangular Arb',
  botType: 'triangular_arb',
  dryRun:  process.env.DRY_RUN !== 'false',

  startAmountUSDT:  parseFloat(process.env.TRI_START_AMOUNT_USDT || '500'),
  minProfitPercent: parseFloat(process.env.TRI_MIN_PROFIT_PCT    || '0.2'),
  pollIntervalMs:   parseInt(process.env.TRI_POLL_INTERVAL_MS    || '500'),
  globalStopLossPct:parseFloat(process.env.GLOBAL_STOP_LOSS_PERCENT || '10'),

  // Inter-leg delay — prevents rate limit issues on execution
  legDelayMs: 120,

  // Max time allowed between first and last leg (stale market guard)
  maxCycleMs: 5_000,

  cycles: [
    {
      name: 'USDT→BTC→ETH→USDT',
      start: 'USDT',
      legs: [
        { pair: 'BTCUSDT', action: 'buy',  gives: 'USDT', receives: 'BTC'  },
        { pair: 'ETHBTC',  action: 'buy',  gives: 'BTC',  receives: 'ETH'  },
        { pair: 'ETHUSDT', action: 'sell', gives: 'ETH',  receives: 'USDT' },
      ],
    },
    {
      name: 'USDT→ETH→BTC→USDT',
      start: 'USDT',
      legs: [
        { pair: 'ETHUSDT', action: 'buy',  gives: 'USDT', receives: 'ETH' },
        { pair: 'ETHBTC',  action: 'sell', gives: 'ETH',  receives: 'BTC' },
        { pair: 'BTCUSDT', action: 'sell', gives: 'BTC',  receives: 'USDT'},
      ],
    },
    {
      name: 'USDT→BTC→SOL→USDT',
      start: 'USDT',
      legs: [
        { pair: 'BTCUSDT', action: 'buy',  gives: 'USDT', receives: 'BTC'  },
        { pair: 'SOLBTC',  action: 'buy',  gives: 'BTC',  receives: 'SOL'  },
        { pair: 'SOLUSDT', action: 'sell', gives: 'SOL',  receives: 'USDT' },
      ],
    },
  ],

  exchange: {
    name:            process.env.EXCHANGE_A_NAME    || 'Exchange',
    baseUrl:         process.env.EXCHANGE_A_BASE_URL,
    apiKey:          process.env.EXCHANGE_A_API_KEY,
    apiSecret:       process.env.EXCHANGE_A_API_SECRET,
    takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
  },
};

// ── BOT ───────────────────────────────────────────────────────────────────────
class TriangularArbBot extends BaseBot {
  constructor(cfg) {
    super(cfg);
    this.ex = new ExchangeClient({ ...cfg.exchange, dryRun: cfg.dryRun });
    this._stats = { cycles: 0, opportunities: 0, executed: 0, totalGross: 0 };
  }

  /**
   * Simulate a full cycle using current book tickers.
   * Returns simulated end amount, profit %, and per-leg detail.
   * Returns null if any ticker is missing.
   */
  _simulate(cycle, tickers) {
    const feeMul = 1 - this.ex.fee / 100;
    let amount   = this.config.startAmountUSDT;
    const steps  = [];

    for (const leg of cycle.legs) {
      const t = tickers[leg.pair];
      if (!t) return null;

      // Bid/ask integrity check
      if (t.bid <= 0 || t.ask <= 0 || t.ask < t.bid) return null;

      const price = leg.action === 'buy' ? t.ask : t.bid;
      if (price <= 0) return null;

      const out = leg.action === 'buy'
        ? (amount / price) * feeMul    // spend quote, receive base
        : amount * price * feeMul;     // spend base, receive quote

      steps.push({
        pair:    leg.pair,
        action:  leg.action,
        price,
        amtIn:   amount,
        amtOut:  out,
        gives:   leg.gives,
        receives:leg.receives,
      });

      amount = out;
    }

    const profitPct = ((amount - this.config.startAmountUSDT) / this.config.startAmountUSDT) * 100;
    return { steps, endAmount: amount, profitPct, grossProfit: amount - this.config.startAmountUSDT };
  }

  /**
   * Execute a cycle leg by leg.
   * Each leg's output becomes next leg's input.
   * Aborts and logs on any failure — partial execution is recorded.
   */
  async _executeCycle(cycle, sim) {
    const cycleStart = Date.now();
    let   holding    = this.config.startAmountUSDT;
    let   holdAsset  = 'USDT';
    const legResults = [];

    for (let i = 0; i < cycle.legs.length; i++) {
      const leg  = cycle.legs[i];
      const step = sim.steps[i];

      // Stale market guard — abort if cycle is taking too long
      if (Date.now() - cycleStart > this.config.maxCycleMs) {
        this.log.warn(`${cycle.name}: cycle timeout on leg ${i+1} — aborting`);
        break;
      }

      this.log.debug(`${cycle.name} leg ${i+1}: ${leg.action.toUpperCase()} ${leg.pair}`, {
        holdingAsset: holdAsset,
        holdingAmt:   holding.toFixed(6),
        expectedPrice:step.price.toFixed(6),
      });

      const res = await this.placeOrder({
        exchange: this.ex.name,
        pair:     leg.pair,
        side:     leg.action === 'buy' ? 'BUY' : 'SELL',
        type:     'MARKET',
        quantity: leg.action === 'buy' ? null : holding,
        quoteQty: leg.action === 'buy' ? holding : null,
        execute: () => leg.action === 'buy'
          ? this.ex.marketOrder(leg.pair, 'BUY',  null, holding)
          : this.ex.marketOrder(leg.pair, 'SELL', holding),
      });

      const execQty = parseFloat(res.response.executedQty);
      const execCost= parseFloat(res.response.cummulativeQuoteQty);

      // Update holding for next leg
      holding   = leg.action === 'buy' ? execQty : execCost;
      holdAsset = leg.receives;
      legResults.push({ ...step, execQty, execCost, dbOrderId: res.id });

      if (i < cycle.legs.length - 1) {
        await this.sleepInterruptible(this.config.legDelayMs);
      }
    }

    const finalAmount   = holding;
    const grossProfit   = finalAmount - this.config.startAmountUSDT;
    const fees          = (this.ex.fee / 100) * this.config.startAmountUSDT * 3;
    const netPnl        = grossProfit - fees;
    const durationMs    = Date.now() - cycleStart;

    this._stats.totalGross += grossProfit;

    return { legResults, finalAmount, grossProfit, fees, netPnl, durationMs };
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async run() {
    this.log.info('Triangular arb started', {
      cycles:    this.config.cycles.map(c => c.name),
      startAmt:  this.config.startAmountUSDT,
      minProfit: this.config.minProfitPercent,
      exchange:  this.ex.name,
    });

    let lastStatsLog = Date.now();

    while (this.running && !this.stopping) {
      if (!await this.riskCheck()) break;
      if (this.ex.circuitBreakerOpen) {
        this.log.warn('Exchange circuit breaker open — waiting 30s');
        await this.sleepInterruptible(30_000);
        continue;
      }

      try {
        // One bulk ticker call covers all pairs needed by all cycles
        const tickers = await this.ex.getAllTickers();
        this._stats.cycles++;

        let bestOpp = null;

        for (const cycle of this.config.cycles) {
          const sim = this._simulate(cycle, tickers);
          if (!sim) continue; // missing pair data

          // Publish simulation result to Redis for monitoring
          await this.cache.set(`tri:sim:${cycle.name}`, {
            profitPct: sim.profitPct.toFixed(4),
            endAmount: sim.endAmount.toFixed(4),
            ts: Date.now(),
          }, 5).catch(() => {});

          if (sim.profitPct > this.config.minProfitPercent) {
            if (!bestOpp || sim.profitPct > bestOpp.sim.profitPct) {
              bestOpp = { cycle, sim };
            }
          }
        }

        if (bestOpp) {
          const { cycle, sim } = bestOpp;
          this._stats.opportunities++;

          this.log.info(`Tri opportunity: ${cycle.name}`, {
            profitPct: sim.profitPct.toFixed(4),
            endAmount: sim.endAmount.toFixed(4),
            steps:     sim.steps.map(s => `${s.action} ${s.pair} @${s.price.toFixed(6)}`),
          });

          const result = await this._executeCycle(cycle, sim);
          this._stats.executed++;

          // Persist as neutral position
          const pos = await this.openPosition({
            pair:       cycle.name,
            side:       'NEUTRAL',
            quantity:   this.config.startAmountUSDT,
            entryPrice: 1,
            metadata:   { cycle: cycle.name, expectedProfit: sim.profitPct, durationMs: result.durationMs },
          });

          await this.closePosition({
            positionId:  pos.id,
            exitPrice:   result.finalAmount / this.config.startAmountUSDT,
            exitOrderId: result.legResults[2]?.dbOrderId,
            realizedPnl: result.grossProfit,
            feeTotal:    result.fees,
            netPnl:      result.netPnl,
            reason:      'tri_complete',
          });

          this.log.info(`${cycle.name} complete`, {
            grossProfit:result.grossProfit.toFixed(4),
            fees:       result.fees.toFixed(4),
            netPnl:     result.netPnl.toFixed(4),
            durationMs: result.durationMs,
            sessionPnl: this.stats.totalPnlUSDT.toFixed(4),
          });
        }
      } catch (err) {
        this.log.error('Tick error', { error: err.message });
      }

      // Log session stats every 5 min
      if (Date.now() - lastStatsLog > 300_000) {
        this.log.info('Session stats', {
          ...this._stats,
          avgProfit: this._stats.executed > 0
            ? (this._stats.totalGross / this._stats.executed).toFixed(4)
            : '0',
        });
        lastStatsLog = Date.now();
      }

      await this.sleepInterruptible(this.config.pollIntervalMs);
    }
  }
}

// ── LAUNCH ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const bot = new TriangularArbBot(CONFIG);
  process.on('SIGINT',  () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  bot.start();
}

module.exports = TriangularArbBot;
