/**
 * Backtest Engine — Java
 * Tests a rule-based trading strategy against historical OHLCV bars.
 * No money at risk — pure computation. Mirrors backtest_engine.py exactly.
 */

import java.util.*;
import java.util.function.Function;

public class BacktestEngine {

    public enum Signal { LONG, SHORT, FLAT }

    @FunctionalInterface
    public interface SignalFn extends Function<List<MarketData.OHLCVBar>, Signal> {}

    public record Trade(
        String entryDate, String exitDate, Signal direction,
        double entryPrice, double exitPrice, double pnlPct, int barsHeld
    ) {}

    public record BacktestResult(
        double totalReturnPct,
        double annualizedReturnPct,
        double sharpeRatio,
        double maxDrawdownPct,
        double winRatePct,
        int numTrades,
        double avgTradePct,
        double bestTradePct,
        double worstTradePct,
        List<Trade> trades,
        List<Double> equityCurve
    ) {}

    public record BacktestOptions(
        double initialCapital,
        double feePct,
        double riskFreeRateAnnual,
        int barsPerYear
    ) {
        public static BacktestOptions defaults() {
            return new BacktestOptions(10_000.0, 0.001, 0.0, 252);
        }
        public static BacktestOptions withBarsPerYear(int bpy) {
            return new BacktestOptions(10_000.0, 0.001, 0.0, bpy);
        }
    }

    public static BacktestResult runBacktest(
        List<MarketData.OHLCVBar> bars,
        SignalFn signalFn,
        BacktestOptions opts
    ) {
        if (bars.size() < 2)
            throw new IllegalArgumentException("Need at least 2 bars to run a backtest");

        double equity = opts.initialCapital();
        List<Double> equityCurve = new ArrayList<>();
        equityCurve.add(equity);
        Signal position = Signal.FLAT;
        double entryPrice = 0.0;
        int entryIdx = 0;
        List<Trade> trades = new ArrayList<>();
        List<Double> returns = new ArrayList<>();

        for (int i = 1; i < bars.size(); i++) {
            List<MarketData.OHLCVBar> history = bars.subList(0, i + 1);
            Signal newSignal = signalFn.apply(history);
            if (newSignal == null) newSignal = Signal.FLAT;

            double currentClose = bars.get(i).close();
            double prevClose    = bars.get(i - 1).close();

            double barReturn = switch (position) {
                case LONG  -> (currentClose - prevClose) / prevClose;
                case SHORT -> (prevClose - currentClose) / prevClose;
                case FLAT  -> 0.0;
            };
            equity *= (1.0 + barReturn);
            returns.add(barReturn);
            equityCurve.add(equity);

            if (newSignal != position) {
                if (position != Signal.FLAT) {
                    double pnlPct = switch (position) {
                        case LONG  -> (currentClose - entryPrice) / entryPrice * 100.0;
                        case SHORT -> (entryPrice - currentClose) / entryPrice * 100.0;
                        case FLAT  -> 0.0;
                    };
                    pnlPct -= opts.feePct() * 100.0;
                    equity *= (1.0 - opts.feePct());
                    trades.add(new Trade(
                        bars.get(entryIdx).date(), bars.get(i).date(), position,
                        entryPrice, currentClose, pnlPct, i - entryIdx
                    ));
                }
                if (newSignal != Signal.FLAT) {
                    entryPrice = currentClose;
                    entryIdx   = i;
                    equity *= (1.0 - opts.feePct());
                }
                position = newSignal;
            }
        }

        // Close open position at final bar
        if (position != Signal.FLAT) {
            double exitPrice = bars.get(bars.size() - 1).close();
            double pnlPct = switch (position) {
                case LONG  -> (exitPrice - entryPrice) / entryPrice * 100.0;
                case SHORT -> (entryPrice - exitPrice) / entryPrice * 100.0;
                case FLAT  -> 0.0;
            };
            pnlPct -= opts.feePct() * 100.0;
            trades.add(new Trade(
                bars.get(entryIdx).date(), bars.get(bars.size() - 1).date(), position,
                entryPrice, exitPrice, pnlPct, bars.size() - 1 - entryIdx
            ));
        }

        double finalEquity     = equityCurve.get(equityCurve.size() - 1);
        double totalReturnPct  = (finalEquity - opts.initialCapital()) / opts.initialCapital() * 100.0;
        double years           = (bars.size() - 1.0) / opts.barsPerYear();
        double annualizedReturnPct = (years > 0 && finalEquity > 0)
            ? (Math.pow(finalEquity / opts.initialCapital(), 1.0 / years) - 1.0) * 100.0
            : 0.0;

        double sharpeRatio     = computeSharpe(returns, opts.riskFreeRateAnnual(), opts.barsPerYear());
        double maxDrawdownPct  = computeMaxDrawdown(equityCurve);

        long winCount = trades.stream().filter(t -> t.pnlPct() > 0).count();
        double winRatePct = trades.isEmpty() ? 0.0 : (double) winCount / trades.size() * 100.0;
        double avgTradePct = trades.isEmpty() ? 0.0 : trades.stream().mapToDouble(Trade::pnlPct).average().orElse(0.0);
        double bestTradePct  = trades.isEmpty() ? 0.0 : trades.stream().mapToDouble(Trade::pnlPct).max().orElse(0.0);
        double worstTradePct = trades.isEmpty() ? 0.0 : trades.stream().mapToDouble(Trade::pnlPct).min().orElse(0.0);

        return new BacktestResult(
            totalReturnPct, annualizedReturnPct, sharpeRatio, maxDrawdownPct,
            winRatePct, trades.size(), avgTradePct, bestTradePct, worstTradePct,
            trades, equityCurve
        );
    }

    public static double computeSharpe(List<Double> returns, double riskFreeRateAnnual, int barsPerYear) {
        if (returns.size() < 2) return 0.0;
        double mean = returns.stream().mapToDouble(Double::doubleValue).average().orElse(0.0);
        double variance = returns.stream().mapToDouble(r -> (r - mean) * (r - mean)).sum() / (returns.size() - 1);
        double stdDev = Math.sqrt(variance);
        if (stdDev == 0.0) return 0.0;
        double riskFreePerPeriod = riskFreeRateAnnual / barsPerYear;
        return (mean - riskFreePerPeriod) / stdDev * Math.sqrt(barsPerYear);
    }

    public static double computeMaxDrawdown(List<Double> equityCurve) {
        if (equityCurve.size() < 2) return 0.0;
        double peak = equityCurve.get(0), maxDd = 0.0;
        for (double v : equityCurve) {
            if (v > peak) peak = v;
            double dd = peak > 0 ? (peak - v) / peak : 0.0;
            if (dd > maxDd) maxDd = dd;
        }
        return maxDd * 100.0;
    }

    // ── Built-in reference strategies ─────────────────────────────────────────
    /** Golden/death-cross momentum. See knowledge/trading_strategies/momentum_strategies.txt */
    public static SignalFn makeSMACrossoverSignal(int fastPeriod, int slowPeriod) {
        int fast = fastPeriod <= 0 ? 50  : fastPeriod;
        int slow = slowPeriod <= 0 ? 200 : slowPeriod;
        return history -> {
            if (history.size() < slow) return Signal.FLAT;
            double[] closes = history.stream().mapToDouble(MarketData.OHLCVBar::close).toArray();
            double[] fastSMA = MarketData.computeSMA(closes, fast);
            double[] slowSMA = MarketData.computeSMA(closes, slow);
            int last = closes.length - 1;
            if (Double.isNaN(fastSMA[last]) || Double.isNaN(slowSMA[last])) return Signal.FLAT;
            return fastSMA[last] > slowSMA[last] ? Signal.LONG : Signal.FLAT;
        };
    }

    /** RSI oversold bounce. See knowledge/trading_strategies/mean_reversion_strategies.txt */
    public static SignalFn makeRSIMeanReversionSignal(int period, double oversold, double overbought) {
        int p  = period <= 0 ? 14 : period;
        double os = oversold <= 0 ? 30.0 : oversold;
        return history -> {
            if (history.size() < p + 1) return Signal.FLAT;
            double[] closes = history.stream().mapToDouble(MarketData.OHLCVBar::close).toArray();
            double[] rsi = MarketData.computeRSI(closes, p);
            double last = rsi[rsi.length - 1];
            if (Double.isNaN(last)) return Signal.FLAT;
            return last < os ? Signal.LONG : Signal.FLAT;
        };
    }

    /** Range breakout. See knowledge/trading_strategies/breakout_strategies.txt */
    public static SignalFn makeBreakoutSignal(int lookback) {
        int lb = lookback <= 0 ? 20 : lookback;
        return history -> {
            if (history.size() < lb + 1) return Signal.FLAT;
            List<MarketData.OHLCVBar> window = history.subList(history.size() - lb - 1, history.size() - 1);
            double rangeHigh = window.stream().mapToDouble(MarketData.OHLCVBar::high).max().orElse(0.0);
            return history.get(history.size() - 1).close() > rangeHigh ? Signal.LONG : Signal.FLAT;
        };
    }
}
