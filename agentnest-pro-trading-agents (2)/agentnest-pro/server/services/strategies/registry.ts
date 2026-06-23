/**
 * Strategy Registry — metadata for the 9 STRATS trading bots.
 *
 * These bots are NOT reimplemented here. They are the user's existing,
 * already-complete Node scripts under <STRATEGY_SCRIPTS_ROOT>/<scriptPath>.
 * This registry only describes how to launch and configure them so the
 * AgentNest tool layer (tradingBotControl) can operate them as child
 * processes, and so each agent's system prompt can be accurate about what
 * the bot it controls actually does.
 *
 * IMPORTANT — known external dependency:
 * Every script under STRATS imports `../../shared/base_bot`,
 * `../../shared/exchange_client`, and (mean-reversion / seasonal only)
 * `../../../infrastructure/db/database`. None of those files were present
 * in the uploaded STRATS zip — they must already exist in the user's real
 * project tree, one level above wherever STRATEGY_SCRIPTS_ROOT points.
 * If they don't exist yet, these scripts will throw on require() and the
 * tradingBotControl tool will faithfully report that failure — it does not
 * paper over a missing dependency.
 */

export interface StrategyEnvParam {
  /** Environment variable name the underlying script reads via process.env */
  envVar:       string;
  description:  string;
  defaultValue: string;
  /** True if this is one of the script's own risk guards (spread, slippage, stop-loss, etc.) */
  isRiskGuard?: boolean;
}

export interface StrategyMeta {
  id:              string;   // matches agent_type suffix, e.g. "cross-exchange-arb"
  label:           string;
  /** Path to the bot's entry file, relative to the STRATEGY_SCRIPTS_ROOT setting */
  scriptPath:      string;
  npmScript:        string;  // the script/strategies/STRATS package.json script name, if applicable
  summary:         string;
  /** Plain-English description of the guards that prevent bad fills — used in agent prompts */
  riskGuards:      string[];
  exchangeAccountsNeeded: number; // how many financial_accounts of type 'exchange' it expects
  envParams:       StrategyEnvParam[];
}

export const STRATEGY_REGISTRY: Record<string, StrategyMeta> = {

  "cross-exchange-arb": {
    id:         "cross-exchange-arb",
    label:      "Cross-Exchange Arbitrage",
    scriptPath: "cross-exchange-arb/index.js",
    npmScript:  "arb",
    summary:    "Watches the same pair (default BTCUSDT) on two exchanges simultaneously and fires both legs in parallel whenever the spread, net of both taker fees, clears the configured minimum.",
    riskGuards: [
      "Net-profit check subtracts BOTH taker fees before counting any spread as real",
      "Spread guard rejects either book if its own bid/ask spread is too wide (illiquidity)",
      "Depth guard requires enough size at best bid/ask to fill the full notional",
      "Oracle validation cross-checks mid price against an external feed before firing (fails open if the feed is unavailable)",
      "Slippage re-check re-fetches the buy-side book immediately before execution and aborts if price moved too far",
      "After 3 consecutive failures on a symbol it backs off for 30s",
    ],
    exchangeAccountsNeeded: 2,
    envParams: [
      { envVar: "ARB_MIN_PROFIT_PCT",        description: "Minimum net profit % (after both taker fees) required to trade",       defaultValue: "0.3",  isRiskGuard: true },
      { envVar: "DEFAULT_TRADE_AMOUNT_USDT", description: "Notional per arbitrage execution in USDT",                              defaultValue: "100" },
      { envVar: "ARB_MAX_SPREAD_PCT",        description: "Reject if either book's spread exceeds this %",                        defaultValue: "0.05", isRiskGuard: true },
      { envVar: "ARB_MAX_SLIPPAGE_PCT",      description: "Abort if price moves more than this % between detection and fire",     defaultValue: "0.1",  isRiskGuard: true },
      { envVar: "ARB_ORACLE_VALIDATION",     description: "Enable oracle cross-validation of mid price (true/false)",             defaultValue: "true" },
      { envVar: "ARB_ORACLE_DEVIATION_PCT",  description: "Max allowed deviation from oracle price %",                            defaultValue: "1.0",  isRiskGuard: true },
      { envVar: "ARB_MIN_DEPTH_USDT",        description: "Minimum order-book depth required at best bid/ask",                    defaultValue: "50",   isRiskGuard: true },
      { envVar: "ARB_POLL_INTERVAL_MS",      description: "Polling interval in milliseconds",                                     defaultValue: "1000" },
      { envVar: "GLOBAL_STOP_LOSS_PERCENT",  description: "Session-wide stop-loss as % of capital",                               defaultValue: "10",   isRiskGuard: true },
    ],
  },

  "triangular-arb": {
    id:         "triangular-arb",
    label:      "Triangular Arbitrage",
    scriptPath: "triangular-arb/index.js",
    npmScript:  "tri",
    summary:    "Simulates 3-leg cycles (e.g. USDT→BTC→ETH→USDT) on a single exchange using live book tickers, and only commits to a cycle whose simulated profit — after all three taker fees — clears the configured minimum.",
    riskGuards: [
      "Full cycle is simulated against live books BEFORE any leg is committed",
      "Profit simulation includes all three taker fees, not just the headline spread",
      "Stale-market guard aborts if more than maxCycleMs elapses across the three legs",
      "Inter-leg delay throttles execution to avoid rate-limit-induced partial fills",
      "Every leg result is logged individually so a partial failure is fully traceable",
    ],
    exchangeAccountsNeeded: 1,
    envParams: [
      { envVar: "TRI_START_AMOUNT_USDT",     description: "Starting notional for the cycle in USDT",                 defaultValue: "500" },
      { envVar: "TRI_MIN_PROFIT_PCT",        description: "Minimum simulated net profit % required to commit",       defaultValue: "0.2", isRiskGuard: true },
      { envVar: "TRI_POLL_INTERVAL_MS",      description: "Polling interval in milliseconds",                        defaultValue: "500" },
      { envVar: "GLOBAL_STOP_LOSS_PERCENT",  description: "Session-wide stop-loss as % of capital",                  defaultValue: "10",  isRiskGuard: true },
    ],
  },

  "cash-and-carry": {
    id:         "cash-and-carry",
    label:      "Spot/Perpetual Cash-and-Carry",
    scriptPath: "cash-carry/index.js",
    npmScript:  "carry",
    summary:    "Goes long spot and short the perpetual (or vice-versa) to collect the funding rate, entering only when the trailing average funding rate clears a minimum and exiting on funding decay, target profit, or a max hold-time guard.",
    riskGuards: [
      "Entry requires the AVERAGE funding rate over the last 3 periods, not a single noisy reading",
      "Exits automatically once funding decays below the configured exit threshold",
      "Hard max-hold-time guard force-closes the position regardless of profit after N hours",
      "Oracle deviation check against a Pyth feed before entry",
      "Funding accrual window guard avoids booking funding before/after the actual settlement timestamp",
    ],
    exchangeAccountsNeeded: 1,
    envParams: [
      { envVar: "CARRY_SPOT_PAIR",           description: "Spot pair symbol",                                          defaultValue: "BTCUSDT" },
      { envVar: "CARRY_PERP_PAIR",           description: "Perpetual pair symbol",                                     defaultValue: "BTCUSDT-PERP" },
      { envVar: "CARRY_TRADE_AMOUNT",        description: "Notional per leg in USDT",                                  defaultValue: "1000" },
      { envVar: "CARRY_MIN_FUNDING",         description: "Minimum trailing-average funding rate % to enter",          defaultValue: "0.03", isRiskGuard: true },
      { envVar: "CARRY_EXIT_FUNDING",        description: "Exit once funding rate decays below this %",                defaultValue: "0.005", isRiskGuard: true },
      { envVar: "CARRY_TARGET_PROFIT",       description: "Take-profit once accumulated funding reaches this % of capital", defaultValue: "0.5" },
      { envVar: "CARRY_MAX_HOLD_HOURS",      description: "Force-close after this many hours regardless of profit",    defaultValue: "72",   isRiskGuard: true },
      { envVar: "CARRY_CHECK_INTERVAL_MS",   description: "Polling interval in milliseconds",                          defaultValue: "30000" },
      { envVar: "GLOBAL_STOP_LOSS_PERCENT",  description: "Session-wide stop-loss as % of capital",                    defaultValue: "10",   isRiskGuard: true },
    ],
  },

  "dca": {
    id:         "dca",
    label:      "DCA Bot (Enhanced)",
    scriptPath: "dca/index.js",
    npmScript:  "dca",
    summary:    "Buys a fixed USDT amount of each configured asset on a cron schedule, with an enhanced mode that scales the buy size up when price has dropped a configured % below its rolling SMA — capped by a max multiplier so a dip can't blow out position size.",
    riskGuards: [
      "Enhanced-DCA dip multiplier is capped at maxMultiplier so a crash can't over-leverage the schedule",
      "Session-wide stop-loss guard still applies even though DCA is a scheduled, not reactive, strategy",
    ],
    exchangeAccountsNeeded: 1,
    envParams: [
      { envVar: "DCA_SCHEDULE",              description: "Cron schedule for buys",                                    defaultValue: "0 9 * * 1" },
      { envVar: "DCA_BTC_AMOUNT",            description: "USDT amount to buy of BTC per run",                        defaultValue: "50" },
      { envVar: "DCA_ETH_AMOUNT",            description: "USDT amount to buy of ETH per run",                        defaultValue: "30" },
      { envVar: "DCA_SOL_AMOUNT",            description: "USDT amount to buy of SOL per run",                        defaultValue: "20" },
      { envVar: "DCA_ENHANCED",              description: "Enable dip-scaling enhanced DCA (true/false)",             defaultValue: "true" },
      { envVar: "DCA_SMA_PERIOD",            description: "SMA period used as the dip reference",                     defaultValue: "50" },
      { envVar: "DCA_MAX_MULTIPLIER",        description: "Cap on the dip-scaling multiplier",                        defaultValue: "3.0",  isRiskGuard: true },
      { envVar: "GLOBAL_STOP_LOSS_PERCENT",  description: "Session-wide stop-loss as % of capital",                   defaultValue: "10",   isRiskGuard: true },
    ],
  },

  "grid": {
    id:         "grid",
    label:      "Grid Bot",
    scriptPath: "grid/index.js",
    npmScript:  "grid",
    summary:    "Places a ladder of buy/sell limit orders evenly spaced between a lower and upper price bound, profiting from chop inside the range, and cancels the whole grid if price breaks out beyond the configured stop-loss/take-profit bounds.",
    riskGuards: [
      "Hard stop-loss cancels the entire grid if price drops below gridLower by stopLossPct",
      "Hard take-profit cancels the entire grid if price rises above gridUpper by takeProfitPct",
      "Order placement is throttled to respect exchange rate limits",
    ],
    exchangeAccountsNeeded: 1,
    envParams: [
      { envVar: "GRID_PAIR",                 description: "Pair to grid trade",                                       defaultValue: "BTCUSDT" },
      { envVar: "GRID_LOWER",                description: "Lower bound of the grid range",                            defaultValue: "80000" },
      { envVar: "GRID_UPPER",                description: "Upper bound of the grid range",                            defaultValue: "100000" },
      { envVar: "GRID_LEVELS",               description: "Number of grid levels between bounds",                     defaultValue: "10" },
      { envVar: "GRID_CAPITAL",              description: "Total capital allocated to the grid in USDT",              defaultValue: "1000" },
      { envVar: "GRID_STOP_LOSS_PCT",        description: "Cancel grid if price falls this % below gridLower",        defaultValue: "15",   isRiskGuard: true },
      { envVar: "GRID_TAKE_PROFIT_PCT",      description: "Cancel grid if price rises this % above gridUpper",        defaultValue: "20",   isRiskGuard: true },
      { envVar: "GRID_POLL_INTERVAL_MS",     description: "Polling interval for checking fills",                      defaultValue: "2000" },
      { envVar: "GLOBAL_STOP_LOSS_PERCENT",  description: "Session-wide stop-loss as % of capital",                   defaultValue: "10",   isRiskGuard: true },
    ],
  },

  "trend-following": {
    id:         "trend-following",
    label:      "Trend Following",
    scriptPath: "trend-following/index.js",
    npmScript:  "trend",
    summary:    "Trades fast/slow moving-average crossovers (default EMA 50/200 on 4h candles), filtered by RSI, ADX trend strength, volume, and VWAP, with ATR-based stops and a break-even shift once the position is far enough in profit.",
    riskGuards: [
      "ADX filter requires a genuinely trending market (minADX) before entering on a crossover",
      "Volume filter requires above-average volume to avoid trading thin crossovers",
      "ATR-based stop loss with a configurable risk:reward target",
      "Break-even shift moves the stop to entry once price has moved breakEvenATR in favor",
      "Shorting is disabled by default (allowShort=false) unless explicitly enabled",
    ],
    exchangeAccountsNeeded: 1,
    envParams: [
      { envVar: "TREND_PAIR",                description: "Pair to trade",                                            defaultValue: "BTCUSDT" },
      { envVar: "TREND_INTERVAL",            description: "Candle interval",                                         defaultValue: "4h" },
      { envVar: "TREND_TRADE_AMOUNT",        description: "Notional per trade in USDT",                               defaultValue: "500" },
      { envVar: "TREND_FAST_MA",             description: "Fast moving-average period",                               defaultValue: "50" },
      { envVar: "TREND_SLOW_MA",             description: "Slow moving-average period",                                defaultValue: "200" },
      { envVar: "TREND_MA_TYPE",             description: "Moving-average type (EMA/SMA)",                            defaultValue: "EMA" },
      { envVar: "TREND_ALLOW_SHORT",         description: "Allow short entries (true/false)",                         defaultValue: "false", isRiskGuard: true },
      { envVar: "TREND_POLL_INTERVAL_MS",    description: "Polling interval in milliseconds",                         defaultValue: "60000" },
      { envVar: "GLOBAL_STOP_LOSS_PERCENT",  description: "Session-wide stop-loss as % of capital",                   defaultValue: "10",    isRiskGuard: true },
    ],
  },

  "momentum-scalp": {
    id:         "momentum-scalp",
    label:      "Momentum Scalp Bot",
    scriptPath: "momentum-scalp/index.js",
    npmScript:  "scalp",
    summary:    "Short-horizon scalper on 1m candles combining RSI(7), Stochastic RSI confirmation, a momentum/breakout filter, order-book imbalance, and VWAP, with tight ATR-based stops and a hard trade-frequency cap to avoid overtrading.",
    riskGuards: [
      "Requires RSI + Stochastic RSI + momentum/breakout to agree before entering (multi-factor confirmation, not a single signal)",
      "Order-book imbalance and spread filter reject illiquid moments",
      "Hard cap on trades per hour plus a cooldown between trades",
      "Hard max-hold-time guard force-exits any scalp that overstays",
      "ATR-based stop with a fixed risk:reward target",
    ],
    exchangeAccountsNeeded: 1,
    envParams: [
      { envVar: "SCALP_PAIR",                description: "Pair to scalp",                                            defaultValue: "BTCUSDT" },
      { envVar: "SCALP_INTERVAL",            description: "Candle interval",                                         defaultValue: "1m" },
      { envVar: "SCALP_TRADE_AMOUNT",        description: "Notional per trade in USDT",                               defaultValue: "200" },
      { envVar: "SCALP_MAX_TRADES_HOUR",     description: "Hard cap on trades per hour",                              defaultValue: "10",   isRiskGuard: true },
      { envVar: "SCALP_COOLDOWN_MS",         description: "Minimum time between trades in milliseconds",              defaultValue: "30000", isRiskGuard: true },
      { envVar: "SCALP_MAX_HOLD_MS",         description: "Force-exit a position after this many milliseconds",       defaultValue: "300000", isRiskGuard: true },
      { envVar: "GLOBAL_STOP_LOSS_PERCENT",  description: "Session-wide stop-loss as % of capital",                   defaultValue: "10",    isRiskGuard: true },
    ],
  },

  "mean-reversion": {
    id:         "mean-reversion",
    label:      "Mean Reversion Bot",
    scriptPath: "mean-reversion/index.js",
    npmScript:  "mean-reversion",
    summary:    "Trades z-score extremes against Bollinger Bands, RSI, and MACD confirmation on 4h candles across BTC/ETH/SOL, optionally requiring alignment with the seasonal engine's confidence score before entering.",
    riskGuards: [
      "Entry only on z-score extreme (<= -2.0 long, >= +2.0 short) confirmed by Bollinger Band + RSI + MACD agreement",
      "Optional seasonal-alignment requirement adds a second, independent confirmation layer",
      "ATR-based stop loss",
    ],
    exchangeAccountsNeeded: 1,
    envParams: [
      { envVar: "DEFAULT_TRADE_AMOUNT_USDT", description: "Notional per trade in USDT",                                defaultValue: "200" },
      { envVar: "EXCHANGE_A_TAKER_FEE",      description: "Taker fee % used in net-profit math",                      defaultValue: "0.1" },
    ],
  },

  "seasonal": {
    id:         "seasonal",
    label:      "Seasonal Buy-Low/Sell-High Bot",
    scriptPath: "seasonal/index.js",
    npmScript:  "seasonal",
    summary:    "Uses the SeasonalEngine's historical day-of-year / month-of-year pattern analysis (win rate, average return, path similarity to prior years) to scale DCA-style accumulation up in historically bullish windows and take profit in historically bullish months.",
    riskGuards: [
      "Trades only when signal_strength and win_rate clear configured minimums — a single good year doesn't trigger a trade",
      "Position sizing is capped by maxPositionMultiplier even when the seasonal signal is very strong",
      "Monthly take-profit target locks in gains rather than holding through a full seasonal cycle unconditionally",
    ],
    exchangeAccountsNeeded: 1,
    envParams: [
      { envVar: "DEFAULT_TRADE_AMOUNT_USDT", description: "Base USDT amount per accumulation event",                   defaultValue: "100" },
      { envVar: "EXCHANGE_A_TAKER_FEE",      description: "Taker fee % used in net-profit math",                      defaultValue: "0.1" },
    ],
  },
};

export function getStrategyMeta(id: string): StrategyMeta | undefined {
  return STRATEGY_REGISTRY[id];
}

export function listStrategyIds(): string[] {
  return Object.keys(STRATEGY_REGISTRY);
}
