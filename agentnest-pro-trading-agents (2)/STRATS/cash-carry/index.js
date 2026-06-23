'use strict';
/**
 * STRATEGY: Spot-Perpetual Cash & Carry
 *
 * Business logic:
 *   - Entry: buy spot + short perp simultaneously only when avg 3-period funding >= threshold
 *   - Delta-neutral: both legs sized identically so price movement cancels out
 *   - Funding collection: records every 8h funding payment to DB for full audit trail
 *   - Multiple exit triggers: funding drops, max hold time, target profit hit, global SL
 *   - Pyth oracle validates spot price before entry (rejects if CEX/oracle deviation > 2%)
 *   - State persisted to DB — survives restarts with position recovery
 *   - Tracks total funding collected vs fees paid for net P&L
 *
 * Run: node src/strategies/cash-carry/index.js
 */

require('dotenv').config();
const BaseBot        = require('../../shared/base_bot');
const ExchangeClient = require('../../shared/exchange_client');

const CONFIG = {
  id:      process.env.BOT_CARRY_ID || undefined,
  name:    'Cash & Carry',
  botType: 'cash_carry',
  dryRun:  process.env.DRY_RUN !== 'false',

  spotPair:            process.env.CARRY_SPOT_PAIR    || 'BTCUSDT',
  perpPair:            process.env.CARRY_PERP_PAIR    || 'BTCUSDT-PERP',
  tradeAmountUSDT:     parseFloat(process.env.CARRY_TRADE_AMOUNT   || '1000'),

  // Entry: minimum average funding rate across last 3 periods
  minFundingRatePct:   parseFloat(process.env.CARRY_MIN_FUNDING    || '0.03'),
  // Exit: exit when rate drops below this (no longer profitable)
  exitFundingRatePct:  parseFloat(process.env.CARRY_EXIT_FUNDING   || '0.005'),
  // Exit: take profit when accumulated funding as % of capital reaches this
  targetProfitPct:     parseFloat(process.env.CARRY_TARGET_PROFIT  || '0.5'),
  // Exit: force close regardless of profit after this many hours
  maxHoldHours:        parseFloat(process.env.CARRY_MAX_HOLD_HOURS || '72'),

  // Pyth oracle feed ID for BTC/USD
  pythFeedId:          '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  // Max acceptable deviation between CEX spot and oracle price
  maxOracleDeviationPct: 2.0,

  // Funding accrual window: fund is booked 1-2 min after the funding timestamp
  fundingAccrualWindowMinutes: [-2, -1],

  checkIntervalMs:     parseInt(process.env.CARRY_CHECK_INTERVAL_MS || '30000'),
  globalStopLossPct:   parseFloat(process.env.GLOBAL_STOP_LOSS_PERCENT || '10'),

  exchange: {
    name:            process.env.EXCHANGE_A_NAME    || 'Exchange',
    baseUrl:         process.env.EXCHANGE_A_BASE_URL,
    apiKey:          process.env.EXCHANGE_A_API_KEY,
    apiSecret:       process.env.EXCHANGE_A_API_SECRET,
    takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
  },
};

class CashCarryBot extends BaseBot {
  constructor(cfg) {
    super(cfg);
    this.ex    = new ExchangeClient({ ...cfg.exchange, dryRun: cfg.dryRun });
    this.dbPos = null;           // current DB position row
    this._lastFundingWindow = 0; // timestamp of last accrued funding window
  }

  async onRestoreState(state) {
    if (state.position) {
      this.dbPos = state.position;
      this.log.info('Restored C&C position', {
        positionId:  this.dbPos.id,
        entryPrice:  this.dbPos.entry_price,
        openedAt:    this.dbPos.opened_at,
      });
    }
  }

  // ── Average funding rate over last N periods ───────────────────────────────
  async _avgFundingRate(periods = 3) {
    try {
      const history = await this.ex.getFundingHistory(this.config.perpPair, periods);
      if (!history.length) return null;
      const avg = history.reduce((a, b) => a + b.rate, 0) / history.length;
      return avg;
    } catch (err) {
      this.log.warn('Failed to fetch funding history, using current rate', { error: err.message });
      const { rate } = await this.ex.getFundingRate(this.config.perpPair);
      return rate;
    }
  }

  // ── Oracle validation before entry ────────────────────────────────────────
  async _validateOracleEntry(spotPrice) {
    try {
      const pyth = await this.solana.getPythPrice(this.config.pythFeedId);
      const devPct = Math.abs(spotPrice - pyth.price) / pyth.price * 100;
      if (devPct > this.config.maxOracleDeviationPct) {
        this.log.warn('Oracle deviation too high — blocking entry', {
          spotPrice, oraclePrice: pyth.price, devPct: devPct.toFixed(3),
        });
        return false;
      }
      return true;
    } catch (err) {
      this.log.warn('Pyth oracle unavailable — proceeding without validation', { error: err.message });
      return true; // fail open
    }
  }

  // ── Open position ─────────────────────────────────────────────────────────
  async _open(spotPrice, avgFundingRate) {
    const qty = this.config.tradeAmountUSDT / spotPrice;

    this.log.info('C&C opening position', {
      spotPair: this.config.spotPair,
      perpPair: this.config.perpPair,
      spotPrice, qty: qty.toFixed(6),
      avgFundingRate: avgFundingRate.toFixed(4),
    });

    // Both legs simultaneously — minimise market exposure window
    const [spotBuy, perpSell] = await Promise.all([
      this.placeOrder({
        exchange: this.ex.name, pair: this.config.spotPair,
        side: 'BUY', type: 'MARKET', quantity: qty,
        execute: () => this.ex.marketOrder(this.config.spotPair, 'BUY', null, this.config.tradeAmountUSDT),
      }),
      this.placeOrder({
        exchange: this.ex.name, pair: this.config.perpPair,
        side: 'SELL', type: 'MARKET', quantity: qty,
        execute: () => this.ex.marketOrder(this.config.perpPair, 'SELL', qty),
      }),
    ]);

    const execSpotPrice = parseFloat(spotBuy.response.executedPrice || spotPrice);
    const execQty       = parseFloat(spotBuy.response.executedQty   || qty);

    this.dbPos = await this.openPosition({
      pair:         this.config.spotPair,
      side:         'NEUTRAL',
      quantity:     execQty,
      entryPrice:   execSpotPrice,
      entryOrderId: spotBuy.id,
      metadata: {
        perpOrderId:    perpSell.id,
        perpPair:       this.config.perpPair,
        entryFunding:   avgFundingRate,
        targetProfit:   this.config.targetProfitPct,
        maxHoldHours:   this.config.maxHoldHours,
      },
    });

    await this.saveState('position', this.dbPos);
    this.log.info('C&C position opened', { positionId: this.dbPos.id, execSpotPrice, execQty });
  }

  // ── Accrue funding payment ────────────────────────────────────────────────
  async _accrueFunding(fundingRate) {
    if (!this.dbPos) return;
    // Funding = rate% × notional. Shorts receive when rate > 0.
    const payment = (Math.abs(fundingRate) / 100) * this.config.tradeAmountUSDT;
    const isReceived = fundingRate > 0; // positive rate → short receives

    await this.db.insertFundingPayment({
      botId:      this.botId,
      positionId: this.dbPos.id,
      symbol:     this.config.perpPair,
      fundingRate,
      paymentUsdt:payment,
      isReceived,
    });

    // Update funding total in cache
    const total = await this.db.getTotalFundingForPosition(this.dbPos.id);
    await this.cache.set(`carry:funding:${this.dbPos.id}`, total, 3600);

    await this.log.alertFundingAccrued({
      symbol:  this.config.perpPair,
      rate:    fundingRate,
      payment: isReceived ? payment : -payment,
      total:   parseFloat(total.net),
    });

    this.log.info('Funding accrued', {
      rate:      fundingRate.toFixed(6),
      payment:   payment.toFixed(4),
      received:  isReceived,
      netTotal:  parseFloat(total.net).toFixed(4),
    });
  }

  // ── Check if we are in the funding accrual window ─────────────────────────
  _isInFundingWindow(minutesToFunding) {
    const [min, max] = this.config.fundingAccrualWindowMinutes;
    return minutesToFunding >= min && minutesToFunding <= max;
  }

  // ── Close position ────────────────────────────────────────────────────────
  async _close(spotPrice, reason) {
    if (!this.dbPos) return;
    const qty = parseFloat(this.dbPos.quantity);

    this.log.info('C&C closing position', { spotPrice, qty, reason });

    const [spotSell, perpBuy] = await Promise.all([
      this.placeOrder({
        exchange: this.ex.name, pair: this.config.spotPair,
        side: 'SELL', type: 'MARKET', quantity: qty,
        execute: () => this.ex.marketOrder(this.config.spotPair, 'SELL', qty),
      }),
      this.placeOrder({
        exchange: this.ex.name, pair: this.config.perpPair,
        side: 'BUY', type: 'MARKET', quantity: qty,
        execute: () => this.ex.marketOrder(this.config.perpPair, 'BUY', qty),
      }),
    ]);

    // Total funding collected (net of any paid)
    const fundingTotal = await this.db.getTotalFundingForPosition(this.dbPos.id);
    const netFunding   = parseFloat(fundingTotal?.net || 0);

    // Spot leg P&L (should be near 0 — we are delta neutral)
    const execSellPrice = parseFloat(spotSell.response.executedPrice || spotPrice);
    const entryPrice    = parseFloat(this.dbPos.entry_price);
    const spotPnl       = (execSellPrice - entryPrice) * qty;

    // Total fees: 2 taker fees on spot (entry+exit) + 2 on perp (entry+exit)
    const fees = (this.ex.fee / 100) * this.config.tradeAmountUSDT * 4;

    const realizedPnl = netFunding + spotPnl;
    const netPnl      = realizedPnl - fees;
    const holdHours   = (Date.now() - new Date(this.dbPos.opened_at).getTime()) / 3_600_000;

    await this.closePosition({
      positionId:   this.dbPos.id,
      exitPrice:    execSellPrice,
      exitOrderId:  spotSell.id,
      realizedPnl,
      feeTotal:     fees,
      netPnl,
      reason,
    });

    this.log.info('C&C closed', {
      reason, holdHours: holdHours.toFixed(2),
      netFunding: netFunding.toFixed(4),
      spotPnl:    spotPnl.toFixed(4),
      fees:       fees.toFixed(4),
      netPnl:     netPnl.toFixed(4),
    });

    this.dbPos = null;
    await this.clearState('position');
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async run() {
    this.log.info('Cash & Carry started', {
      spot:           this.config.spotPair,
      perp:           this.config.perpPair,
      tradeAmount:    this.config.tradeAmountUSDT,
      minFunding:     this.config.minFundingRatePct,
      targetProfit:   this.config.targetProfitPct,
      maxHoldHours:   this.config.maxHoldHours,
    });

    while (this.running && !this.stopping) {
      if (!await this.riskCheck()) break;

      try {
        const [spotPrice, { rate: fundingRate, nextTime }] = await Promise.all([
          this.ex.getPrice(this.config.spotPair),
          this.ex.getFundingRate(this.config.perpPair),
        ]);

        const minToFunding = (nextTime.getTime() - Date.now()) / 60_000;

        this.log.debug('Tick', {
          spotPrice,
          fundingRate:   fundingRate.toFixed(6),
          minToFunding:  minToFunding.toFixed(1),
          hasPosition:   !!this.dbPos,
        });

        // ── No position: look for entry ──────────────────────────────────────
        if (!this.dbPos) {
          const avgRate = await this._avgFundingRate(3);
          if (avgRate === null) {
            this.log.warn('Could not determine avg funding rate — skipping');
          } else if (avgRate < this.config.minFundingRatePct) {
            this.log.debug('Funding too low for entry', {
              avgRate: avgRate.toFixed(6), min: this.config.minFundingRatePct,
            });
          } else if (!await this._validateOracleEntry(spotPrice)) {
            // Oracle blocked entry — logged inside _validateOracleEntry
          } else {
            await this._open(spotPrice, avgRate);
          }

        // ── Have position: manage it ─────────────────────────────────────────
        } else {
          // Accrue funding if we just crossed a funding window boundary
          if (this._isInFundingWindow(minToFunding)) {
            const windowKey = Math.floor(Date.now() / 28_800_000); // 8h bucket
            if (windowKey !== this._lastFundingWindow) {
              this._lastFundingWindow = windowKey;
              await this._accrueFunding(fundingRate);
            }
          }

          // Update unrealised P&L on the position
          await this.markToMarket(this.dbPos.id, spotPrice);

          // ── Exit conditions ──────────────────────────────────────────────
          const holdH       = (Date.now() - new Date(this.dbPos.opened_at).getTime()) / 3_600_000;
          const fundingData = await this.db.getTotalFundingForPosition(this.dbPos.id);
          const netFunding  = parseFloat(fundingData?.net || 0);
          const profitPct   = (netFunding / this.config.tradeAmountUSDT) * 100;

          const exitReason =
            fundingRate < this.config.exitFundingRatePct ? 'funding_rate_too_low'
            : profitPct  >= this.config.targetProfitPct   ? 'target_profit_hit'
            : holdH      >= this.config.maxHoldHours      ? 'max_hold_time'
            : null;

          if (exitReason) {
            this.log.info('Exit triggered', { exitReason, holdH: holdH.toFixed(2), profitPct: profitPct.toFixed(4) });
            await this._close(spotPrice, exitReason);
          }
        }

      } catch (err) {
        this.log.error('Tick error', { error: err.message });
        await this.log.alertError(`Cash & Carry tick error: ${err.message}`);
      }

      await this.sleepInterruptible(this.config.checkIntervalMs);
    }

    // Graceful shutdown: close open position
    if (this.dbPos) {
      try {
        const price = await this.ex.getPrice(this.config.spotPair);
        await this._close(price, 'bot_shutdown');
      } catch (err) {
        this.log.error('Failed to close position on shutdown', { error: err.message });
      }
    }
  }
}

if (require.main === module) {
  const bot = new CashCarryBot(CONFIG);
  process.on('SIGINT',  () => bot.stop());
  process.on('SIGTERM', () => bot.stop());
  bot.start();
}

module.exports = CashCarryBot;
