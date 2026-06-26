/**
 * Backtest Engine — TypeScript
 * Tests a rule-based trading strategy against historical OHLCV bars (no money at
 * risk — pure computation). Mirrors backtest_engine.py exactly in behaviour.
 */

import { computeSMA, computeRSI } from "./market_data";

export type Signal = "long" | "short" | "flat";
export type SignalFn = (history: BarLike[]) => Signal;

export interface BarLike {
  date?: string; timestamp?: number;
  open: number; high: number; low: number; close: number; volume?: number;
}

export class BacktestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestError";
  }
}

export interface Trade {
  entryDate: string; exitDate: string; direction: Signal;
  entryPrice: number; exitPrice: number; pnlPct: number; barsHeld: number;
}

export interface BacktestResult {
  totalReturnPct: number;
  annualizedReturnPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  winRatePct: number;
  numTrades: number;
  avgTradePct: number;
  bestTradePct: number;
  worstTradePct: number;
  trades: Trade[];
  equityCurve: number[];
}

function barLabel(bar: BarLike): string {
  return String(bar.date ?? bar.timestamp ?? "");
}

export function runBacktest(
  bars: BarLike[],
  signalFn: SignalFn,
  options: {
    initialCapital?: number;
    feePct?: number;
    riskFreeRateAnnual?: number;
    barsPerYear?: number;
  } = {},
): BacktestResult {
  const {
    initialCapital = 10_000,
    feePct = 0.001,
    riskFreeRateAnnual = 0,
    barsPerYear = 252,
  } = options;

  if (bars.length < 2) throw new BacktestError("Need at least 2 bars to run a backtest");
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.open == null || b.high == null || b.low == null || b.close == null) {
      throw new BacktestError(`Bar ${i} missing required OHLC keys`);
    }
  }

  let equity = initialCapital;
  const equityCurve: number[] = [equity];
  let position: Signal = "flat";
  let entryPrice = 0;
  let entryIdx = 0;
  const trades: Trade[] = [];
  const returns: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const history = bars.slice(0, i + 1);
    let newSignal: Signal;
    try {
      newSignal = signalFn(history);
    } catch (e) {
      throw new BacktestError(`signalFn threw at bar ${i}: ${e instanceof Error ? e.message : e}`);
    }
    if (newSignal !== "long" && newSignal !== "short" && newSignal !== "flat") {
      throw new BacktestError(`signalFn returned invalid signal '${newSignal}' at bar ${i}`);
    }

    const currentClose = bars[i].close;
    const prevClose = bars[i - 1].close;

    let barReturn = 0;
    if (position === "long") barReturn = (currentClose - prevClose) / prevClose;
    else if (position === "short") barReturn = (prevClose - currentClose) / prevClose;
    equity *= (1 + barReturn);
    returns.push(barReturn);
    equityCurve.push(equity);

    if (newSignal !== position) {
      if (position !== "flat") {
        const exitPrice = currentClose;
        let pnlPct = (position === "long"
          ? (exitPrice - entryPrice) / entryPrice
          : (entryPrice - exitPrice) / entryPrice) * 100;
        pnlPct -= feePct * 100;
        equity *= (1 - feePct);
        trades.push({
          entryDate: barLabel(bars[entryIdx]), exitDate: barLabel(bars[i]),
          direction: position, entryPrice, exitPrice, pnlPct, barsHeld: i - entryIdx,
        });
      }
      if (newSignal !== "flat") {
        entryPrice = currentClose;
        entryIdx = i;
        equity *= (1 - feePct);
      }
      position = newSignal;
    }
  }

  if (position !== "flat") {
    const exitPrice = bars[bars.length - 1].close;
    let pnlPct = (position === "long"
      ? (exitPrice - entryPrice) / entryPrice
      : (entryPrice - exitPrice) / entryPrice) * 100;
    pnlPct -= feePct * 100;
    trades.push({
      entryDate: barLabel(bars[entryIdx]), exitDate: barLabel(bars[bars.length - 1]),
      direction: position, entryPrice, exitPrice, pnlPct, barsHeld: bars.length - 1 - entryIdx,
    });
  }

  const totalReturnPct = ((equityCurve[equityCurve.length - 1] - initialCapital) / initialCapital) * 100;
  const numPeriods = bars.length - 1;
  const years = barsPerYear > 0 ? numPeriods / barsPerYear : 1;
  const finalEquity = equityCurve[equityCurve.length - 1];
  const annualizedReturnPct = years > 0 && finalEquity > 0
    ? (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100
    : 0;

  const sharpeRatio = computeSharpe(returns, riskFreeRateAnnual, barsPerYear);
  const maxDrawdownPct = computeMaxDrawdown(equityCurve);

  const winningTrades = trades.filter((t) => t.pnlPct > 0);
  const winRatePct = trades.length ? (winningTrades.length / trades.length) * 100 : 0;
  const avgTradePct = trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;
  const bestTradePct = trades.length ? Math.max(...trades.map((t) => t.pnlPct)) : 0;
  const worstTradePct = trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : 0;

  return {
    totalReturnPct, annualizedReturnPct, sharpeRatio, maxDrawdownPct,
    winRatePct, numTrades: trades.length, avgTradePct, bestTradePct, worstTradePct,
    trades, equityCurve,
  };
}

export function computeSharpe(returns: number[], riskFreeRateAnnual: number, barsPerYear: number): number {
  if (returns.length < 2) return 0;
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  const riskFreePerPeriod = riskFreeRateAnnual / barsPerYear;
  return ((meanReturn - riskFreePerPeriod) / stdDev) * Math.sqrt(barsPerYear);
}

export function computeMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;
  let peak = equityCurve[0];
  let maxDd = 0;
  for (const value of equityCurve) {
    if (value > peak) peak = value;
    const drawdown = peak > 0 ? (peak - value) / peak : 0;
    maxDd = Math.max(maxDd, drawdown);
  }
  return maxDd * 100;
}

// ── Built-in reference strategies ───────────────────────────────────────────────
export function makeSMACrossoverSignal(fastPeriod = 50, slowPeriod = 200): SignalFn {
  return (history) => {
    const closes = history.map((b) => b.close);
    if (closes.length < slowPeriod) return "flat";
    const fast = computeSMA(closes, fastPeriod);
    const slow = computeSMA(closes, slowPeriod);
    const f = fast[fast.length - 1];
    const s = slow[slow.length - 1];
    if (f == null || s == null) return "flat";
    return f > s ? "long" : "flat";
  };
}

export function makeRSIMeanReversionSignal(period = 14, oversold = 30, overbought = 70): SignalFn {
  return (history) => {
    const closes = history.map((b) => b.close);
    if (closes.length < period + 1) return "flat";
    const rsi = computeRSI(closes, period);
    const r = rsi[rsi.length - 1];
    if (r == null) return "flat";
    if (r < oversold) return "long";
    if (r > overbought) return "flat";
    return "flat";
  };
}

export function makeBreakoutSignal(lookback = 20): SignalFn {
  return (history) => {
    if (history.length < lookback + 1) return "flat";
    const window = history.slice(-lookback - 1, -1);
    const rangeHigh = Math.max(...window.map((b) => b.high));
    return history[history.length - 1].close > rangeHigh ? "long" : "flat";
  };
}
