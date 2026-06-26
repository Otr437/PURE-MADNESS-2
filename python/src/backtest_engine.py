"""
Backtest Engine — Python
Tests a rule-based trading strategy against historical OHLCV bars (no money at risk —
pure computation). Reports total return, Sharpe ratio, max drawdown, win rate, and trade log.

Strategies are expressed as a StrategySpec: a signal function that receives the bar
history up to (and including) the current bar and returns 'long', 'short', or 'flat'.
This keeps the engine strategy-agnostic — momentum, mean-reversion, breakout, or any
custom rule can be plugged in without changing the engine.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Literal

import structlog

structlog.configure(processors=[
    structlog.processors.TimeStamper(fmt="iso"),
    structlog.processors.add_log_level,
    structlog.processors.JSONRenderer(),
])
log = structlog.get_logger()

Signal = Literal["long", "short", "flat"]
SignalFn = Callable[[list[dict]], Signal]


class BacktestError(Exception):
    """Raised for invalid backtest configuration or data."""


@dataclass
class Trade:
    entry_date:  str
    exit_date:   str
    direction:   Signal
    entry_price: float
    exit_price:  float
    pnl_pct:     float
    bars_held:   int


@dataclass
class BacktestResult:
    total_return_pct:   float
    annualized_return_pct: float
    sharpe_ratio:       float
    max_drawdown_pct:   float
    win_rate_pct:       float
    num_trades:         int
    avg_trade_pct:      float
    best_trade_pct:     float
    worst_trade_pct:    float
    trades:             list[Trade] = field(default_factory=list)
    equity_curve:       list[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "total_return_pct":      round(self.total_return_pct, 4),
            "annualized_return_pct": round(self.annualized_return_pct, 4),
            "sharpe_ratio":          round(self.sharpe_ratio, 4),
            "max_drawdown_pct":      round(self.max_drawdown_pct, 4),
            "win_rate_pct":          round(self.win_rate_pct, 2),
            "num_trades":            self.num_trades,
            "avg_trade_pct":         round(self.avg_trade_pct, 4),
            "best_trade_pct":        round(self.best_trade_pct, 4),
            "worst_trade_pct":       round(self.worst_trade_pct, 4),
            "trades": [
                {
                    "entry_date":  t.entry_date,
                    "exit_date":   t.exit_date,
                    "direction":   t.direction,
                    "entry_price": round(t.entry_price, 4),
                    "exit_price":  round(t.exit_price, 4),
                    "pnl_pct":     round(t.pnl_pct, 4),
                    "bars_held":   t.bars_held,
                }
                for t in self.trades
            ],
        }


def run_backtest(
    bars: list[dict],
    signal_fn: SignalFn,
    initial_capital: float = 10_000.0,
    fee_pct: float = 0.001,
    risk_free_rate_annual: float = 0.0,
    bars_per_year: int = 252,
) -> BacktestResult:
    """
    Run a backtest of a rule-based signal function against historical OHLCV bars.

    Args:
        bars:        List of {date, open, high, low, close, volume} sorted oldest-first.
                     Crypto bars without 'date' may use 'timestamp' converted to string.
        signal_fn:   Function(bar_history) -> 'long' | 'short' | 'flat'.
                     Called once per bar with all bars up to and including the current
                     one (no lookahead — the function never sees future bars).
        initial_capital: Starting capital for the equity curve.
        fee_pct:     Round-trip transaction cost as a fraction (0.001 = 0.1%).
        risk_free_rate_annual: Annual risk-free rate for Sharpe ratio calculation.
        bars_per_year: Trading periods per year for annualization (252 for daily
                       stocks, 365 for daily crypto, 52 for weekly, etc).

    Returns:
        BacktestResult with performance metrics and full trade log.

    Raises:
        BacktestError if bars is too short or malformed.
    """
    if len(bars) < 2:
        raise BacktestError("Need at least 2 bars to run a backtest")
    for i, bar in enumerate(bars):
        for key in ("open", "high", "low", "close"):
            if key not in bar:
                raise BacktestError(f"Bar {i} missing required key '{key}'")

    equity = initial_capital
    equity_curve = [equity]
    position: Signal = "flat"
    entry_price = 0.0
    entry_idx   = 0
    trades: list[Trade] = []
    returns: list[float] = []

    def _bar_label(b: dict) -> str:
        return str(b.get("date") or b.get("timestamp") or "")

    for i in range(1, len(bars)):
        history = bars[: i + 1]
        try:
            new_signal = signal_fn(history)
        except Exception as e:
            log.error("backtest.signal_fn_error", bar_index=i, error=str(e))
            raise BacktestError(f"signal_fn raised an exception at bar {i}: {e}") from e

        if new_signal not in ("long", "short", "flat"):
            raise BacktestError(f"signal_fn returned invalid signal '{new_signal}' at bar {i} — must be long/short/flat")

        current_close = bars[i]["close"]
        prev_close    = bars[i - 1]["close"]

        # Mark-to-market the existing position for this bar's return
        if position == "long":
            bar_return = (current_close - prev_close) / prev_close
        elif position == "short":
            bar_return = (prev_close - current_close) / prev_close
        else:
            bar_return = 0.0
        equity *= (1 + bar_return)
        returns.append(bar_return)
        equity_curve.append(equity)

        # Handle signal transitions — close existing position, open new one
        if new_signal != position:
            if position != "flat":
                exit_price = current_close
                pnl_pct = (
                    (exit_price - entry_price) / entry_price
                    if position == "long"
                    else (entry_price - exit_price) / entry_price
                ) * 100
                pnl_pct -= fee_pct * 100  # round-trip fee deducted from realized P&L
                equity *= (1 - fee_pct)   # fee impact on equity curve
                trades.append(Trade(
                    entry_date=_bar_label(bars[entry_idx]),
                    exit_date=_bar_label(bars[i]),
                    direction=position,
                    entry_price=entry_price,
                    exit_price=exit_price,
                    pnl_pct=pnl_pct,
                    bars_held=i - entry_idx,
                ))
            if new_signal != "flat":
                entry_price = current_close
                entry_idx   = i
                equity *= (1 - fee_pct)  # entry fee
            position = new_signal

    # Close any open position at the final bar
    if position != "flat":
        exit_price = bars[-1]["close"]
        pnl_pct = (
            (exit_price - entry_price) / entry_price
            if position == "long"
            else (entry_price - exit_price) / entry_price
        ) * 100
        pnl_pct -= fee_pct * 100
        trades.append(Trade(
            entry_date=_bar_label(bars[entry_idx]),
            exit_date=_bar_label(bars[-1]),
            direction=position,
            entry_price=entry_price,
            exit_price=exit_price,
            pnl_pct=pnl_pct,
            bars_held=len(bars) - 1 - entry_idx,
        ))

    total_return_pct = ((equity_curve[-1] - initial_capital) / initial_capital) * 100
    num_periods = len(bars) - 1
    years = num_periods / bars_per_year if bars_per_year > 0 else 1
    annualized_return_pct = (
        ((equity_curve[-1] / initial_capital) ** (1 / years) - 1) * 100
        if years > 0 and equity_curve[-1] > 0
        else 0.0
    )

    sharpe_ratio = _compute_sharpe(returns, risk_free_rate_annual, bars_per_year)
    max_drawdown_pct = _compute_max_drawdown(equity_curve)

    winning_trades = [t for t in trades if t.pnl_pct > 0]
    win_rate_pct = (len(winning_trades) / len(trades) * 100) if trades else 0.0
    avg_trade_pct = (sum(t.pnl_pct for t in trades) / len(trades)) if trades else 0.0
    best_trade_pct = max((t.pnl_pct for t in trades), default=0.0)
    worst_trade_pct = min((t.pnl_pct for t in trades), default=0.0)

    log.info(
        "backtest.complete",
        bars=len(bars),
        trades=len(trades),
        total_return_pct=round(total_return_pct, 2),
        sharpe=round(sharpe_ratio, 2),
        max_dd=round(max_drawdown_pct, 2),
    )

    return BacktestResult(
        total_return_pct=total_return_pct,
        annualized_return_pct=annualized_return_pct,
        sharpe_ratio=sharpe_ratio,
        max_drawdown_pct=max_drawdown_pct,
        win_rate_pct=win_rate_pct,
        num_trades=len(trades),
        avg_trade_pct=avg_trade_pct,
        best_trade_pct=best_trade_pct,
        worst_trade_pct=worst_trade_pct,
        trades=trades,
        equity_curve=equity_curve,
    )


def _compute_sharpe(returns: list[float], risk_free_rate_annual: float, bars_per_year: int) -> float:
    if len(returns) < 2:
        return 0.0
    mean_return = sum(returns) / len(returns)
    variance = sum((r - mean_return) ** 2 for r in returns) / (len(returns) - 1)
    std_dev = math.sqrt(variance)
    if std_dev == 0:
        return 0.0
    risk_free_per_period = risk_free_rate_annual / bars_per_year
    excess_return = mean_return - risk_free_per_period
    return (excess_return / std_dev) * math.sqrt(bars_per_year)


def _compute_max_drawdown(equity_curve: list[float]) -> float:
    if len(equity_curve) < 2:
        return 0.0
    peak = equity_curve[0]
    max_dd = 0.0
    for value in equity_curve:
        if value > peak:
            peak = value
        drawdown = (peak - value) / peak if peak > 0 else 0.0
        max_dd = max(max_dd, drawdown)
    return max_dd * 100


# ── Built-in reference strategies (composable with market_data indicators) ──────
def make_sma_crossover_signal(fast_period: int = 50, slow_period: int = 200) -> SignalFn:
    """Golden-cross / death-cross signal generator. See knowledge/trading_strategies/momentum_strategies.txt"""
    from market_data import compute_sma

    def signal_fn(history: list[dict]) -> Signal:
        closes = [b["close"] for b in history]
        if len(closes) < slow_period:
            return "flat"
        fast = compute_sma(closes, fast_period)
        slow = compute_sma(closes, slow_period)
        if fast[-1] is None or slow[-1] is None:
            return "flat"
        return "long" if fast[-1] > slow[-1] else "flat"

    return signal_fn


def make_rsi_mean_reversion_signal(period: int = 14, oversold: float = 30, overbought: float = 70) -> SignalFn:
    """Classic RSI mean-reversion signal. See knowledge/trading_strategies/mean_reversion_strategies.txt"""
    from market_data import compute_rsi

    def signal_fn(history: list[dict]) -> Signal:
        closes = [b["close"] for b in history]
        if len(closes) < period + 1:
            return "flat"
        rsi = compute_rsi(closes, period)
        if rsi[-1] is None:
            return "flat"
        if rsi[-1] < oversold:
            return "long"
        if rsi[-1] > overbought:
            return "flat"
        return "flat"

    return signal_fn


def make_breakout_signal(lookback: int = 20) -> SignalFn:
    """Range breakout signal — long when close exceeds the prior N-bar high. See knowledge/trading_strategies/breakout_strategies.txt"""

    def signal_fn(history: list[dict]) -> Signal:
        if len(history) < lookback + 1:
            return "flat"
        window = history[-lookback - 1:-1]
        range_high = max(b["high"] for b in window)
        return "long" if history[-1]["close"] > range_high else "flat"

    return signal_fn
