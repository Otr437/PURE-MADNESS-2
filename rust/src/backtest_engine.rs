//! Backtest Engine — Rust
//! Tests a rule-based trading strategy against historical OHLCV bars (no money
//! at risk — pure computation). Mirrors backtest_engine.py exactly in behaviour.

use anyhow::{anyhow, Result};
use serde::Serialize;

use crate::market_data::{compute_rsi, compute_sma, OHLCVBar};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Signal { Long, Short, Flat }

pub type SignalFn<'a> = Box<dyn Fn(&[OHLCVBar]) -> Signal + 'a>;

#[derive(Debug, Clone, Serialize)]
pub struct Trade {
    pub entry_date: String, pub exit_date: String, pub direction: Signal,
    pub entry_price: f64, pub exit_price: f64, pub pnl_pct: f64, pub bars_held: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BacktestResult {
    pub total_return_pct: f64,
    pub annualized_return_pct: f64,
    pub sharpe_ratio: f64,
    pub max_drawdown_pct: f64,
    pub win_rate_pct: f64,
    pub num_trades: usize,
    pub avg_trade_pct: f64,
    pub best_trade_pct: f64,
    pub worst_trade_pct: f64,
    pub trades: Vec<Trade>,
    pub equity_curve: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
pub struct BacktestOptions {
    pub initial_capital: f64,
    pub fee_pct: f64,
    pub risk_free_rate_annual: f64,
    pub bars_per_year: u32,
}

impl Default for BacktestOptions {
    fn default() -> Self {
        Self { initial_capital: 10_000.0, fee_pct: 0.001, risk_free_rate_annual: 0.0, bars_per_year: 252 }
    }
}

pub fn run_backtest(bars: &[OHLCVBar], signal_fn: SignalFn, opts: BacktestOptions) -> Result<BacktestResult> {
    if bars.len() < 2 {
        return Err(anyhow!("need at least 2 bars to run a backtest"));
    }

    let mut equity = opts.initial_capital;
    let mut equity_curve = vec![equity];
    let mut position = Signal::Flat;
    let mut entry_price = 0.0_f64;
    let mut entry_idx = 0usize;
    let mut trades: Vec<Trade> = Vec::new();
    let mut returns: Vec<f64> = Vec::new();

    for i in 1..bars.len() {
        let history = &bars[..=i];
        let new_signal = signal_fn(history);

        let current_close = bars[i].close;
        let prev_close = bars[i - 1].close;

        let bar_return = match position {
            Signal::Long  => (current_close - prev_close) / prev_close,
            Signal::Short => (prev_close - current_close) / prev_close,
            Signal::Flat  => 0.0,
        };
        equity *= 1.0 + bar_return;
        returns.push(bar_return);
        equity_curve.push(equity);

        if new_signal != position {
            if position != Signal::Flat {
                let exit_price = current_close;
                let mut pnl_pct = match position {
                    Signal::Long  => (exit_price - entry_price) / entry_price,
                    Signal::Short => (entry_price - exit_price) / entry_price,
                    Signal::Flat  => 0.0,
                } * 100.0;
                pnl_pct -= opts.fee_pct * 100.0;
                equity *= 1.0 - opts.fee_pct;
                trades.push(Trade {
                    entry_date: bars[entry_idx].date.clone(), exit_date: bars[i].date.clone(),
                    direction: position, entry_price, exit_price, pnl_pct, bars_held: i - entry_idx,
                });
            }
            if new_signal != Signal::Flat {
                entry_price = current_close;
                entry_idx = i;
                equity *= 1.0 - opts.fee_pct;
            }
            position = new_signal;
        }
    }

    if position != Signal::Flat {
        let exit_price = bars[bars.len() - 1].close;
        let mut pnl_pct = match position {
            Signal::Long  => (exit_price - entry_price) / entry_price,
            Signal::Short => (entry_price - exit_price) / entry_price,
            Signal::Flat  => 0.0,
        } * 100.0;
        pnl_pct -= opts.fee_pct * 100.0;
        trades.push(Trade {
            entry_date: bars[entry_idx].date.clone(), exit_date: bars[bars.len() - 1].date.clone(),
            direction: position, entry_price, exit_price, pnl_pct, bars_held: bars.len() - 1 - entry_idx,
        });
    }

    let final_equity = *equity_curve.last().unwrap();
    let total_return_pct = (final_equity - opts.initial_capital) / opts.initial_capital * 100.0;
    let num_periods = bars.len() - 1;
    let years = num_periods as f64 / opts.bars_per_year as f64;
    let annualized_return_pct = if years > 0.0 && final_equity > 0.0 {
        ((final_equity / opts.initial_capital).powf(1.0 / years) - 1.0) * 100.0
    } else { 0.0 };

    let sharpe_ratio = compute_sharpe(&returns, opts.risk_free_rate_annual, opts.bars_per_year);
    let max_drawdown_pct = compute_max_drawdown(&equity_curve);

    let winning: Vec<&Trade> = trades.iter().filter(|t| t.pnl_pct > 0.0).collect();
    let win_rate_pct = if trades.is_empty() { 0.0 } else { winning.len() as f64 / trades.len() as f64 * 100.0 };
    let avg_trade_pct = if trades.is_empty() { 0.0 } else { trades.iter().map(|t| t.pnl_pct).sum::<f64>() / trades.len() as f64 };
    let best_trade_pct = trades.iter().map(|t| t.pnl_pct).fold(f64::NEG_INFINITY, f64::max);
    let worst_trade_pct = trades.iter().map(|t| t.pnl_pct).fold(f64::INFINITY, f64::min);

    Ok(BacktestResult {
        total_return_pct, annualized_return_pct, sharpe_ratio, max_drawdown_pct, win_rate_pct,
        num_trades: trades.len(), avg_trade_pct,
        best_trade_pct: if trades.is_empty() { 0.0 } else { best_trade_pct },
        worst_trade_pct: if trades.is_empty() { 0.0 } else { worst_trade_pct },
        trades, equity_curve,
    })
}

pub fn compute_sharpe(returns: &[f64], risk_free_rate_annual: f64, bars_per_year: u32) -> f64 {
    if returns.len() < 2 { return 0.0; }
    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    let variance = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (returns.len() - 1) as f64;
    let std_dev = variance.sqrt();
    if std_dev == 0.0 { return 0.0; }
    let risk_free_per_period = risk_free_rate_annual / bars_per_year as f64;
    (mean - risk_free_per_period) / std_dev * (bars_per_year as f64).sqrt()
}

pub fn compute_max_drawdown(equity_curve: &[f64]) -> f64 {
    if equity_curve.len() < 2 { return 0.0; }
    let mut peak = equity_curve[0];
    let mut max_dd = 0.0_f64;
    for &v in equity_curve {
        if v > peak { peak = v; }
        let dd = if peak > 0.0 { (peak - v) / peak } else { 0.0 };
        max_dd = max_dd.max(dd);
    }
    max_dd * 100.0
}

// ── Built-in reference strategies ───────────────────────────────────────────────
pub fn make_sma_crossover_signal<'a>(fast_period: usize, slow_period: usize) -> SignalFn<'a> {
    let fast_period = if fast_period == 0 { 50 } else { fast_period };
    let slow_period = if slow_period == 0 { 200 } else { slow_period };
    Box::new(move |history: &[OHLCVBar]| {
        if history.len() < slow_period { return Signal::Flat; }
        let closes: Vec<f64> = history.iter().map(|b| b.close).collect();
        let fast = compute_sma(&closes, fast_period);
        let slow = compute_sma(&closes, slow_period);
        match (fast.last().copied().flatten(), slow.last().copied().flatten()) {
            (Some(f), Some(s)) if f > s => Signal::Long,
            _ => Signal::Flat,
        }
    })
}

pub fn make_rsi_mean_reversion_signal<'a>(period: usize, oversold: f64, overbought: f64) -> SignalFn<'a> {
    let period = if period == 0 { 14 } else { period };
    let oversold = if oversold == 0.0 { 30.0 } else { oversold };
    let _overbought = if overbought == 0.0 { 70.0 } else { overbought };
    Box::new(move |history: &[OHLCVBar]| {
        if history.len() < period + 1 { return Signal::Flat; }
        let closes: Vec<f64> = history.iter().map(|b| b.close).collect();
        let rsi = compute_rsi(&closes, period);
        match rsi.last().copied().flatten() {
            Some(r) if r < oversold => Signal::Long,
            _ => Signal::Flat,
        }
    })
}

pub fn make_breakout_signal<'a>(lookback: usize) -> SignalFn<'a> {
    let lookback = if lookback == 0 { 20 } else { lookback };
    Box::new(move |history: &[OHLCVBar]| {
        if history.len() < lookback + 1 { return Signal::Flat; }
        let window = &history[history.len() - lookback - 1..history.len() - 1];
        let range_high = window.iter().map(|b| b.high).fold(f64::NEG_INFINITY, f64::max);
        if history[history.len() - 1].close > range_high { Signal::Long } else { Signal::Flat }
    })
}

// ── Tests ──────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    fn make_bars(closes: &[f64]) -> Vec<OHLCVBar> {
        closes.iter().enumerate().map(|(i, &c)| OHLCVBar {
            date: format!("2024-01-{:02}", i + 1),
            open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000,
        }).collect()
    }

    #[test]
    fn test_requires_minimum_bars() {
        let bars = vec![OHLCVBar { date: "1".into(), open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 0 }];
        let result = run_backtest(&bars, Box::new(|_| Signal::Flat), BacktestOptions::default());
        assert!(result.is_err());
    }

    #[test]
    fn test_flat_signal_no_trades() {
        let bars = make_bars(&[100.0, 101.0, 102.0, 103.0, 104.0]);
        let result = run_backtest(&bars, Box::new(|_| Signal::Flat), BacktestOptions::default()).unwrap();
        assert_eq!(result.num_trades, 0);
        assert_eq!(result.total_return_pct, 0.0);
    }

    #[test]
    fn test_always_long_tracks_rise() {
        let bars = make_bars(&[100.0, 110.0, 120.0, 130.0, 140.0]);
        let opts = BacktestOptions { fee_pct: 0.0, ..Default::default() };
        let result = run_backtest(&bars, Box::new(|_| Signal::Long), opts).unwrap();
        assert!(result.total_return_pct > 0.0);
        assert!((result.total_return_pct - 40.0).abs() < 0.5);
    }

    #[test]
    fn test_always_short_loses_in_uptrend() {
        let bars = make_bars(&[100.0, 110.0, 120.0, 130.0, 140.0]);
        let opts = BacktestOptions { fee_pct: 0.0, ..Default::default() };
        let result = run_backtest(&bars, Box::new(|_| Signal::Short), opts).unwrap();
        assert!(result.total_return_pct < 0.0);
    }

    #[test]
    fn test_no_lookahead_bias() {
        let bars = make_bars(&[100.0, 101.0, 102.0, 103.0, 104.0, 105.0]);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_clone = seen.clone();
        run_backtest(&bars, Box::new(move |h| { seen_clone.lock().unwrap().push(h.len()); Signal::Flat }), BacktestOptions::default()).unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![2, 3, 4, 5, 6]);
    }

    #[test]
    fn test_fees_reduce_return() {
        let bars = make_bars(&[100.0, 110.0, 120.0, 130.0, 140.0]);
        let no_fee = run_backtest(&bars, Box::new(|_| Signal::Long), BacktestOptions { fee_pct: 0.0, ..Default::default() }).unwrap();
        let with_fee = run_backtest(&bars, Box::new(|_| Signal::Long), BacktestOptions { fee_pct: 0.01, ..Default::default() }).unwrap();
        assert!(with_fee.total_return_pct < no_fee.total_return_pct);
    }

    #[test]
    fn test_sharpe_zero_volatility() {
        assert_eq!(compute_sharpe(&[0.0, 0.0, 0.0], 0.0, 252), 0.0);
    }

    #[test]
    fn test_sharpe_positive_returns() {
        assert!(compute_sharpe(&[0.01, 0.02, 0.015, 0.01, 0.018], 0.0, 252) > 0.0);
    }

    #[test]
    fn test_max_drawdown_monotonic() {
        assert_eq!(compute_max_drawdown(&[100.0, 110.0, 120.0, 130.0]), 0.0);
    }

    #[test]
    fn test_max_drawdown_detected() {
        let dd = compute_max_drawdown(&[100.0, 120.0, 90.0, 110.0]);
        assert!((dd - 25.0).abs() < 0.5);
    }

    #[test]
    fn test_sma_crossover_insufficient_history() {
        let signal_fn = make_sma_crossover_signal(50, 200);
        let bars = make_bars(&[100.0, 101.0, 102.0]);
        assert_eq!(signal_fn(&bars), Signal::Flat);
    }

    #[test]
    fn test_breakout_insufficient_history() {
        let signal_fn = make_breakout_signal(20);
        let bars = make_bars(&[100.0, 101.0]);
        assert_eq!(signal_fn(&bars), Signal::Flat);
    }
}
