/**
 * Test suite — Trading Agent modules (TypeScript)
 * Mirrors test_trading.py: pure-logic tests for backtest_engine and market_data
 * indicator functions, plus the order proposal safety boundary.
 *
 * npm test -- tests/test_trading.test.ts
 */

import {
  computeSMA, computeRSI, computeATR, MarketDataError,
} from "../src/market_data";
import {
  runBacktest, BacktestError, makeSMACrossoverSignal, makeRSIMeanReversionSignal,
  makeBreakoutSignal, computeSharpe, computeMaxDrawdown, BarLike,
} from "../src/backtest_engine";

function makeBars(closes: number[]): BarLike[] {
  return closes.map((c, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, "0")}`,
    open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000,
  }));
}

describe("computeSMA", () => {
  test("basic SMA calculation", () => {
    const result = computeSMA([1, 2, 3, 4, 5], 3);
    expect(result).toEqual([null, null, 2, 3, 4]);
  });

  test("period of 1 returns the values themselves", () => {
    expect(computeSMA([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });

  test("invalid period throws", () => {
    expect(() => computeSMA([1, 2, 3], 0)).toThrow(MarketDataError);
  });

  test("empty array returns empty array", () => {
    expect(computeSMA([], 3)).toEqual([]);
  });
});

describe("computeRSI", () => {
  test("insufficient data returns all nulls", () => {
    const result = computeRSI([1, 2, 3], 14);
    expect(result.every((v) => v === null)).toBe(true);
  });

  test("strictly increasing prices saturate RSI at 100", () => {
    const closes = Array.from({ length: 19 }, (_, i) => i + 1);
    const result = computeRSI(closes, 14);
    expect(result[result.length - 1]).toBe(100);
  });

  test("RSI values are bounded 0-100", () => {
    const closes = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17, 16, 18, 17, 19];
    const result = computeRSI(closes, 14);
    result.forEach((v) => { if (v !== null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); } });
  });

  test("invalid period throws", () => {
    expect(() => computeRSI([1, 2, 3], 0)).toThrow(MarketDataError);
  });
});

describe("computeATR", () => {
  test("basic ATR calculation produces a positive value", () => {
    const bars = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
      { high: 12, low: 10, close: 11 },
    ];
    const result = computeATR(bars, 2);
    expect(result.length).toBe(bars.length);
    expect(result[result.length - 1]).not.toBeNull();
    expect(result[result.length - 1]!).toBeGreaterThan(0);
  });

  test("too few bars returns all nulls", () => {
    const result = computeATR([{ high: 10, low: 9, close: 9.5 }], 14);
    expect(result.every((v) => v === null)).toBe(true);
  });

  test("invalid period throws", () => {
    const bars = [{ high: 10, low: 9, close: 9.5 }, { high: 11, low: 10, close: 10.5 }];
    expect(() => computeATR(bars, 0)).toThrow(MarketDataError);
  });
});

describe("runBacktest", () => {
  test("requires at least 2 bars", () => {
    expect(() => runBacktest([{ open: 1, high: 1, low: 1, close: 1 }], () => "flat")).toThrow(BacktestError);
  });

  test("flat signal produces no trades and zero return", () => {
    const bars = makeBars([100, 101, 102, 103, 104]);
    const result = runBacktest(bars, () => "flat");
    expect(result.numTrades).toBe(0);
    expect(result.totalReturnPct).toBe(0);
  });

  test("always-long tracks the underlying price rise", () => {
    const bars = makeBars([100, 110, 120, 130, 140]);
    const result = runBacktest(bars, () => "long", { feePct: 0 });
    expect(result.totalReturnPct).toBeGreaterThan(0);
    expect(result.totalReturnPct).toBeCloseTo(40, 0);
  });

  test("always-short loses in an uptrend", () => {
    const bars = makeBars([100, 110, 120, 130, 140]);
    const result = runBacktest(bars, () => "short", { feePct: 0 });
    expect(result.totalReturnPct).toBeLessThan(0);
  });

  test("invalid signal value throws", () => {
    const bars = makeBars([100, 101, 102]);
    expect(() => runBacktest(bars, () => "bogus" as any)).toThrow(BacktestError);
  });

  test("signalFn exception is wrapped in BacktestError", () => {
    const bars = makeBars([100, 101, 102]);
    expect(() => runBacktest(bars, () => { throw new Error("boom"); })).toThrow(BacktestError);
  });

  test("no lookahead bias — signalFn only sees history up to current bar", () => {
    const bars = makeBars([100, 101, 102, 103, 104, 105]);
    const seenLengths: number[] = [];
    runBacktest(bars, (history) => { seenLengths.push(history.length); return "flat"; });
    expect(seenLengths).toEqual([2, 3, 4, 5, 6]);
  });

  test("trade log records entry and exit", () => {
    const bars = makeBars([100, 105, 110, 115, 120]);
    const signalFn = (history: BarLike[]) => {
      if (history.length < 2) return "flat" as const;
      if (history.length >= 4) return "flat" as const;
      return "long" as const;
    };
    const result = runBacktest(bars, signalFn, { feePct: 0 });
    expect(result.numTrades).toBeGreaterThanOrEqual(1);
    expect(result.trades[0].direction).toBe("long");
    expect(result.trades[0].entryPrice).toBeGreaterThan(0);
  });

  test("fees reduce total return", () => {
    const bars = makeBars([100, 110, 120, 130, 140]);
    const noFee = runBacktest(bars, () => "long", { feePct: 0 });
    const withFee = runBacktest(bars, () => "long", { feePct: 0.01 });
    expect(withFee.totalReturnPct).toBeLessThan(noFee.totalReturnPct);
  });
});

describe("computeSharpe", () => {
  test("zero volatility returns zero", () => {
    expect(computeSharpe([0, 0, 0], 0, 252)).toBe(0);
  });

  test("positive consistent returns produce positive Sharpe", () => {
    expect(computeSharpe([0.01, 0.02, 0.015, 0.01, 0.018], 0, 252)).toBeGreaterThan(0);
  });

  test("insufficient data returns zero", () => {
    expect(computeSharpe([0.01], 0, 252)).toBe(0);
  });
});

describe("computeMaxDrawdown", () => {
  test("monotonic increase has zero drawdown", () => {
    expect(computeMaxDrawdown([100, 110, 120, 130])).toBe(0);
  });

  test("detects a drawdown correctly", () => {
    const dd = computeMaxDrawdown([100, 120, 90, 110]);
    expect(dd).toBeCloseTo(25, 0);
  });

  test("single value has zero drawdown", () => {
    expect(computeMaxDrawdown([100])).toBe(0);
  });
});

describe("strategy presets", () => {
  test("SMA crossover returns a valid signal", () => {
    const signalFn = makeSMACrossoverSignal(2, 4);
    const result = signalFn(makeBars([100, 101, 102, 103, 104, 105]));
    expect(["long", "flat"]).toContain(result);
  });

  test("SMA crossover with insufficient history returns flat", () => {
    const signalFn = makeSMACrossoverSignal(50, 200);
    expect(signalFn(makeBars([100, 101, 102]))).toBe("flat");
  });

  test("RSI mean reversion returns a valid signal", () => {
    const signalFn = makeRSIMeanReversionSignal(3);
    const result = signalFn(makeBars([100, 95, 90, 85, 80, 75]));
    expect(["long", "flat"]).toContain(result);
  });

  test("breakout returns a valid signal", () => {
    const signalFn = makeBreakoutSignal(3);
    const result = signalFn(makeBars([100, 101, 100, 99, 105]));
    expect(["long", "flat"]).toContain(result);
  });

  test("breakout with insufficient history returns flat", () => {
    const signalFn = makeBreakoutSignal(20);
    expect(signalFn(makeBars([100, 101]))).toBe("flat");
  });
});

// ── Order proposal safety boundary ─────────────────────────────────────────────
describe("order proposal safety", () => {
  let tradingAgent: typeof import("../src/trading_agent");

  beforeAll(async () => {
    tradingAgent = await import("../src/trading_agent");
  });

  test("proposeOrder creates a valid proposal", () => {
    const p = tradingAgent.proposeOrder({ symbol: "AAPL", side: "buy", quantity: 10, rationale: "test" });
    expect(p.symbol).toBe("AAPL");
    expect(p.side).toBe("buy");
    expect(p.status).toContain("REQUIRES HUMAN CONFIRMATION");
    expect(p.proposalId).toBeTruthy();
  });

  test("proposeOrder rejects invalid side", () => {
    expect(() => tradingAgent.proposeOrder({ symbol: "AAPL", side: "invalid" as any, quantity: 10, rationale: "x" })).toThrow();
  });

  test("proposeOrder rejects non-positive quantity", () => {
    expect(() => tradingAgent.proposeOrder({ symbol: "AAPL", side: "buy", quantity: 0, rationale: "x" })).toThrow();
    expect(() => tradingAgent.proposeOrder({ symbol: "AAPL", side: "buy", quantity: -5, rationale: "x" })).toThrow();
  });

  test("limit order requires a limit price", () => {
    expect(() => tradingAgent.proposeOrder({
      symbol: "AAPL", side: "buy", quantity: 10, orderType: "limit", limitPrice: null, rationale: "x",
    })).toThrow();
  });

  test("getProposal round-trips a created proposal", () => {
    const p = tradingAgent.proposeOrder({ symbol: "BTC", side: "buy", quantity: 0.1, assetClass: "crypto", rationale: "x" });
    expect(tradingAgent.getProposal(p.proposalId)).toEqual(p);
  });

  test("getProposal returns undefined for unknown id", () => {
    expect(tradingAgent.getProposal("nonexistent-id")).toBeUndefined();
  });

  describe("orderExecuteIBKR safety gate", () => {
    test("rejects confirm=false", () => {
      const p = tradingAgent.proposeOrder({ symbol: "AAPL", side: "buy", quantity: 10, rationale: "x" });
      expect(() => tradingAgent.orderExecuteIBKR(p.proposalId, false)).toThrow(/confirm=true/);
    });

    test("rejects unknown proposal id even with confirm=true", () => {
      expect(() => tradingAgent.orderExecuteIBKR("nonexistent-id", true)).toThrow(/No proposal found/);
    });

    test("defaults to PAPER mode when IBKR_LIVE_TRADING is unset", () => {
      delete process.env.IBKR_LIVE_TRADING;
      const p = tradingAgent.proposeOrder({ symbol: "AAPL", side: "buy", quantity: 10, rationale: "x" });
      const result = tradingAgent.orderExecuteIBKR(p.proposalId, true);
      expect(result.mode).toBe("PAPER");
    });

    test("uses LIVE mode only when IBKR_LIVE_TRADING=true is explicitly set", () => {
      process.env.IBKR_LIVE_TRADING = "true";
      const p = tradingAgent.proposeOrder({ symbol: "AAPL", side: "buy", quantity: 10, rationale: "x" });
      const result = tradingAgent.orderExecuteIBKR(p.proposalId, true);
      expect(result.mode).toBe("LIVE");
      delete process.env.IBKR_LIVE_TRADING;
    });
  });

  test("orderExecuteIBKR is not exposed via toolRegistry", async () => {
    const { toolRegistry } = await import("../src/react_loop");
    expect(toolRegistry.has("order_execute_ibkr")).toBe(false);
    expect(toolRegistry.has("order_execute")).toBe(false);
  });
});
