// src/risk.rs
// Portfolio-level and position-level risk management engine.
// Pure computation — no I/O, no network, no global state.
// Every function validates inputs before computing.
// Called from the bridge on every tick before any order is placed.

use crate::types::{
    PositionSnapshot, PositionSide, PortfolioRisk, RiskBreach, IndicatorError, Result,
};
use crate::indicators::{atr, kelly_criterion, max_drawdown, sharpe_ratio};
use crate::types::Candle;

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
/// Absolute maximum drawdown allowed before forced liquidation. Hard ceiling.
const HARD_MAX_DRAWDOWN_PCT:   f64 = 50.0;
/// Absolute maximum single position size as % of capital. Hard ceiling.
const HARD_MAX_POSITION_PCT:   f64 = 25.0;
/// Minimum capital floor — bot must stop if account drops below this.
const MIN_CAPITAL_FLOOR_USDT:  f64 = 10.0;
/// Max allowable leverage (notional / capital). Hard ceiling regardless of config.
const HARD_MAX_LEVERAGE:       f64 = 10.0;
/// Minimum risk/reward ratio we allow — trades below this are rejected.
const MIN_RISK_REWARD_RATIO:   f64 = 1.0;

// ── POSITION-LEVEL RISK ───────────────────────────────────────────────────────

/// Evaluate whether an open position should be closed based on current price.
/// Returns the exit reason if any condition is met.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PositionExitDecision {
    pub should_exit:   bool,
    pub reason:        Option<String>,
    pub urgency:       ExitUrgency,
    pub current_pnl:   f64,
    pub current_pnl_pct: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExitUrgency {
    None,
    Normal,   // take profit / planned exit
    Urgent,   // stop loss breached
    Emergency,// multiple limits breached simultaneously
}

pub fn evaluate_position_exit(
    pos:           &PositionSnapshot,
    max_hold_ms:   Option<u64>,
    trail_stop_pct:Option<f64>,
    break_even_atr_mult: f64,
    atr_val:       Option<f64>,
) -> Result<PositionExitDecision> {
    pos.validate()?;

    let pnl     = pos.net_pnl();
    let pnl_pct = pos.return_pct();
    let hold_ms = pos.hold_ms();
    let mut reasons: Vec<String> = Vec::new();
    let mut urgency = ExitUrgency::None;

    // ── Stop loss breach (urgent) ─────────────────────────────────────────────
    if pos.stop_breached() {
        reasons.push("stop_loss_breached".into());
        urgency = ExitUrgency::Urgent;
    }

    // ── Take profit reached (normal) ──────────────────────────────────────────
    if pos.tp_reached() {
        reasons.push("take_profit_reached".into());
        if urgency == ExitUrgency::None { urgency = ExitUrgency::Normal; }
    }

    // ── Max hold time exceeded (normal) ───────────────────────────────────────
    if let Some(max_ms) = max_hold_ms {
        if hold_ms > max_ms {
            reasons.push(format!("max_hold_time_{}ms_exceeded", max_ms));
            if urgency == ExitUrgency::None { urgency = ExitUrgency::Normal; }
        }
    }

    // ── Trailing stop ─────────────────────────────────────────────────────────
    if let (Some(trail_pct), true) = (trail_stop_pct, pnl_pct > 0.0) {
        let trail_stop = match pos.side {
            PositionSide::Long  => pos.current_price * (1.0 - trail_pct / 100.0),
            PositionSide::Short => pos.current_price * (1.0 + trail_pct / 100.0),
            PositionSide::Neutral => pos.entry_price,
        };
        let breached = match pos.side {
            PositionSide::Long  => pos.current_price <= trail_stop,
            PositionSide::Short => pos.current_price >= trail_stop,
            PositionSide::Neutral => false,
        };
        if breached {
            reasons.push(format!("trailing_stop_{trail_pct:.2}pct_breached"));
            if urgency == ExitUrgency::None { urgency = ExitUrgency::Normal; }
        }
    }

    // ── Break-even stop: if we're in profit >= break_even_atr_mult × ATR,
    //    stop loss should have been moved to break-even. Flag if price retraced.
    if let Some(atr) = atr_val {
        if atr > 0.0 && break_even_atr_mult > 0.0 {
            let be_threshold = atr * break_even_atr_mult;
            let profit_dist  = (pos.current_price - pos.entry_price).abs();
            if profit_dist >= be_threshold {
                // Already in break-even territory — check if we retraced back to entry
                let retraced = match pos.side {
                    PositionSide::Long  => pos.current_price <= pos.entry_price,
                    PositionSide::Short => pos.current_price >= pos.entry_price,
                    PositionSide::Neutral => false,
                };
                if retraced {
                    reasons.push("break_even_retraced".into());
                    if urgency == ExitUrgency::None { urgency = ExitUrgency::Normal; }
                }
            }
        }
    }

    // Emergency if both SL and another condition fire together
    if reasons.len() >= 2 && urgency == ExitUrgency::Urgent {
        urgency = ExitUrgency::Emergency;
    }

    Ok(PositionExitDecision {
        should_exit: !reasons.is_empty(),
        reason:      if reasons.is_empty() { None } else { Some(reasons.join("|")) },
        urgency,
        current_pnl:     pnl,
        current_pnl_pct: pnl_pct,
    })
}

// ── PORTFOLIO-LEVEL RISK ──────────────────────────────────────────────────────

/// Full portfolio risk evaluation.
/// Returns the first breach found, or None if all limits are within bounds.
pub fn evaluate_portfolio_risk(
    positions:           &[PositionSnapshot],
    peak_capital_usdt:   f64,
    current_capital_usdt:f64,
    daily_loss_usdt:     f64,
    max_drawdown_pct:    f64,
    daily_loss_limit:    f64,
    max_open_positions:  usize,
    max_notional_usdt:   f64,
) -> Result<Option<RiskBreach>> {
    // ── Input validation ──────────────────────────────────────────────────────
    if peak_capital_usdt < 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("evaluate_portfolio_risk: peak_capital must be >= 0, got {peak_capital_usdt}"),
        });
    }
    if current_capital_usdt < 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("evaluate_portfolio_risk: current_capital must be >= 0, got {current_capital_usdt}"),
        });
    }
    if max_drawdown_pct <= 0.0 || max_drawdown_pct > HARD_MAX_DRAWDOWN_PCT {
        return Err(IndicatorError::InvalidInput {
            msg: format!(
                "evaluate_portfolio_risk: max_drawdown_pct must be 0-{HARD_MAX_DRAWDOWN_PCT}, got {max_drawdown_pct}"
            ),
        });
    }
    for p in positions { p.validate()?; }

    // ── Hard floor: capital below absolute minimum ────────────────────────────
    if current_capital_usdt < MIN_CAPITAL_FLOOR_USDT {
        return Ok(Some(RiskBreach {
            kind:  "capital_floor".into(),
            value: current_capital_usdt,
            limit: MIN_CAPITAL_FLOOR_USDT,
        }));
    }

    let risk = PortfolioRisk::from_positions(
        positions, peak_capital_usdt, current_capital_usdt, daily_loss_usdt,
    )?;

    // ── Delegate to PortfolioRisk::check_limits ───────────────────────────────
    if let Some(breach) = risk.check_limits(
        max_drawdown_pct, daily_loss_limit, max_open_positions, max_notional_usdt,
    ) {
        return Ok(Some(breach));
    }

    // ── Additional checks beyond check_limits ─────────────────────────────────

    // Leverage check: total open notional / current capital
    if current_capital_usdt > 0.0 {
        let leverage = risk.total_notional_usdt / current_capital_usdt;
        if leverage > HARD_MAX_LEVERAGE {
            return Ok(Some(RiskBreach {
                kind:  "max_leverage".into(),
                value: leverage,
                limit: HARD_MAX_LEVERAGE,
            }));
        }
    }

    Ok(None)
}

// ── POSITION SIZING ───────────────────────────────────────────────────────────

/// Compute optimal position size respecting risk per trade, Kelly, and hard limits.
/// Returns the USDT notional to trade.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PositionSizeResult {
    pub notional_usdt:  f64,
    pub quantity:       f64,
    pub risk_usdt:      f64,
    pub risk_pct:       f64,
    pub kelly_fraction: f64,
    pub capped:         bool,
    pub cap_reason:     Option<String>,
}

pub fn compute_position_size(
    capital_usdt:       f64,
    entry_price:        f64,
    stop_loss_price:    f64,
    max_risk_pct:       f64,     // max % of capital to risk per trade (e.g. 1.0 = 1%)
    max_position_pct:   f64,     // max % of capital in one position (e.g. 10.0 = 10%)
    win_rate:           Option<f64>,
    avg_win:            Option<f64>,
    avg_loss:           Option<f64>,
    is_long:            bool,
) -> Result<PositionSizeResult> {
    // ── Validate inputs ───────────────────────────────────────────────────────
    if capital_usdt <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("compute_position_size: capital_usdt must be > 0, got {capital_usdt}") });
    }
    if entry_price <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("compute_position_size: entry_price must be > 0, got {entry_price}") });
    }
    if stop_loss_price <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("compute_position_size: stop_loss_price must be > 0, got {stop_loss_price}") });
    }
    if max_risk_pct <= 0.0 || max_risk_pct > 100.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("compute_position_size: max_risk_pct must be 0-100, got {max_risk_pct}") });
    }
    if max_position_pct <= 0.0 || max_position_pct > HARD_MAX_POSITION_PCT {
        return Err(IndicatorError::InvalidInput {
            msg: format!("compute_position_size: max_position_pct must be 0-{HARD_MAX_POSITION_PCT}, got {max_position_pct}"),
        });
    }

    // ── Risk per share ────────────────────────────────────────────────────────
    let risk_per_unit = if is_long {
        entry_price - stop_loss_price
    } else {
        stop_loss_price - entry_price
    };

    if risk_per_unit <= 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!(
                "compute_position_size: stop_loss ({stop_loss_price}) is on wrong side of entry ({entry_price}) for {} position",
                if is_long { "LONG" } else { "SHORT" }
            ),
        });
    }

    // ── Fixed fractional sizing: risk USDT / risk per unit ────────────────────
    let max_risk_usdt     = capital_usdt * max_risk_pct / 100.0;
    let fixed_frac_qty    = max_risk_usdt / risk_per_unit;
    let fixed_frac_notional = fixed_frac_qty * entry_price;

    // ── Kelly sizing ──────────────────────────────────────────────────────────
    let kelly_fraction = match (win_rate, avg_win, avg_loss) {
        (Some(wr), Some(aw), Some(al)) if wr > 0.0 && aw > 0.0 && al > 0.0 => {
            kelly_criterion(wr, aw, al).unwrap_or(0.5)
        }
        _ => 0.5,
    };

    let kelly_notional = capital_usdt * kelly_fraction;

    // ── Take the more conservative of fixed-fractional and Kelly ──────────────
    let base_notional = fixed_frac_notional.min(kelly_notional);

    // ── Hard cap: max position size ───────────────────────────────────────────
    let max_notional  = capital_usdt * max_position_pct / 100.0;
    let (notional, capped, cap_reason) = if base_notional > max_notional {
        (max_notional, true, Some(format!("capped_at_{max_position_pct}pct_of_capital")))
    } else {
        (base_notional, false, None)
    };

    // ── Final notional must be positive ───────────────────────────────────────
    if notional <= 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("compute_position_size: computed notional {notional:.4} is not positive"),
        });
    }

    let quantity  = notional / entry_price;
    let risk_usdt = quantity * risk_per_unit;
    let risk_pct  = risk_usdt / capital_usdt * 100.0;

    Ok(PositionSizeResult {
        notional_usdt: notional,
        quantity,
        risk_usdt,
        risk_pct,
        kelly_fraction,
        capped,
        cap_reason,
    })
}

// ── RISK/REWARD VALIDATION ────────────────────────────────────────────────────

/// Validate that a proposed trade meets minimum risk/reward requirements.
pub fn validate_risk_reward(
    entry:       f64,
    stop_loss:   f64,
    take_profit: f64,
    min_rr:      f64,
    is_long:     bool,
) -> Result<f64> {
    if entry <= 0.0       { return Err(IndicatorError::InvalidInput { msg: format!("validate_risk_reward: entry must be > 0, got {entry}") }); }
    if stop_loss <= 0.0   { return Err(IndicatorError::InvalidInput { msg: format!("validate_risk_reward: stop_loss must be > 0, got {stop_loss}") }); }
    if take_profit <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("validate_risk_reward: take_profit must be > 0, got {take_profit}") }); }
    if min_rr < MIN_RISK_REWARD_RATIO {
        return Err(IndicatorError::InvalidInput {
            msg: format!("validate_risk_reward: min_rr {min_rr} is below absolute minimum {MIN_RISK_REWARD_RATIO}"),
        });
    }

    let risk   = (entry - stop_loss).abs();
    let reward = (take_profit - entry).abs();

    if risk == 0.0 {
        return Err(IndicatorError::DivisionByZero { context: "validate_risk_reward: risk is zero (entry == stop_loss)".into() });
    }

    // SL/TP must be on correct sides for direction
    if is_long {
        if stop_loss >= entry {
            return Err(IndicatorError::InvalidInput {
                msg: format!("validate_risk_reward: LONG stop_loss ({stop_loss}) must be < entry ({entry})"),
            });
        }
        if take_profit <= entry {
            return Err(IndicatorError::InvalidInput {
                msg: format!("validate_risk_reward: LONG take_profit ({take_profit}) must be > entry ({entry})"),
            });
        }
    } else {
        if stop_loss <= entry {
            return Err(IndicatorError::InvalidInput {
                msg: format!("validate_risk_reward: SHORT stop_loss ({stop_loss}) must be > entry ({entry})"),
            });
        }
        if take_profit >= entry {
            return Err(IndicatorError::InvalidInput {
                msg: format!("validate_risk_reward: SHORT take_profit ({take_profit}) must be < entry ({entry})"),
            });
        }
    }

    let rr = reward / risk;
    if rr < min_rr {
        return Err(IndicatorError::InvalidInput {
            msg: format!("validate_risk_reward: R:R {rr:.3} is below minimum {min_rr:.3} (risk={risk:.4}, reward={reward:.4})"),
        });
    }

    Ok(rr)
}

// ── DRAWDOWN MONITOR ──────────────────────────────────────────────────────────

/// Compute real-time drawdown from an equity curve and flag any breach.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DrawdownReport {
    pub current_drawdown_pct: f64,
    pub max_drawdown_pct:     f64,
    pub peak_capital:         f64,
    pub current_capital:      f64,
    pub is_breached:          bool,
    pub breach_limit_pct:     f64,
}

pub fn compute_drawdown(
    equity_curve:     &[f64],
    drawdown_limit:   f64,
) -> Result<DrawdownReport> {
    if equity_curve.len() < 2 {
        return Err(IndicatorError::InsufficientData { needed: 2, got: equity_curve.len() });
    }
    for (i, &v) in equity_curve.iter().enumerate() {
        if !v.is_finite() || v < 0.0 {
            return Err(IndicatorError::NonFiniteInput { pos: i, value: v });
        }
    }
    if drawdown_limit <= 0.0 || drawdown_limit > 100.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("compute_drawdown: drawdown_limit must be 0-100, got {drawdown_limit}"),
        });
    }

    let mut peak    = equity_curve[0];
    let mut max_dd  = 0.0f64;

    for &v in equity_curve {
        if v > peak { peak = v; }
        if peak > 0.0 {
            let dd = (peak - v) / peak * 100.0;
            if dd > max_dd { max_dd = dd; }
        }
    }

    let current    = *equity_curve.last().unwrap();
    let current_dd = if peak > 0.0 { (peak - current) / peak * 100.0 } else { 0.0 };

    Ok(DrawdownReport {
        current_drawdown_pct: current_dd,
        max_drawdown_pct:     max_dd,
        peak_capital:         peak,
        current_capital:      current,
        is_breached:          current_dd >= drawdown_limit,
        breach_limit_pct:     drawdown_limit,
    })
}

// ── SHARPE / SORTINO MONITOR ──────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PerformanceMetrics {
    pub trade_count:      usize,
    pub win_count:        usize,
    pub loss_count:       usize,
    pub win_rate_pct:     f64,
    pub avg_win_usdt:     f64,
    pub avg_loss_usdt:    f64,
    pub profit_factor:    f64,
    pub total_pnl_usdt:   f64,
    pub sharpe:           Option<f64>,
    pub sortino:          Option<f64>,
    pub max_drawdown_pct: Option<f64>,
    pub kelly_fraction:   Option<f64>,
    pub expectancy_usdt:  f64,
}

pub fn compute_performance_metrics(
    pnl_series:    &[f64],  // net PnL per closed trade
    equity_curve:  &[f64],  // running equity after each trade
    risk_free:     f64,
    periods_per_year: f64,
) -> Result<PerformanceMetrics> {
    if pnl_series.is_empty() {
        return Ok(PerformanceMetrics {
            trade_count: 0, win_count: 0, loss_count: 0,
            win_rate_pct: 0.0, avg_win_usdt: 0.0, avg_loss_usdt: 0.0,
            profit_factor: 0.0, total_pnl_usdt: 0.0,
            sharpe: None, sortino: None, max_drawdown_pct: None,
            kelly_fraction: None, expectancy_usdt: 0.0,
        });
    }

    for (i, &v) in pnl_series.iter().enumerate() {
        if !v.is_finite() {
            return Err(IndicatorError::NonFiniteInput { pos: i, value: v });
        }
    }

    let wins:  Vec<f64> = pnl_series.iter().cloned().filter(|&p| p > 0.0).collect();
    let losses:Vec<f64> = pnl_series.iter().cloned().filter(|&p| p < 0.0).collect();

    let win_count  = wins.len();
    let loss_count = losses.len();
    let total      = pnl_series.len();
    let win_rate   = if total > 0 { win_count as f64 / total as f64 * 100.0 } else { 0.0 };

    let avg_win  = if win_count  > 0 { wins.iter().sum::<f64>()             / win_count  as f64 } else { 0.0 };
    let avg_loss = if loss_count > 0 { losses.iter().map(|p| p.abs()).sum::<f64>() / loss_count as f64 } else { 0.0 };

    let total_wins:   f64 = wins.iter().sum();
    let total_losses: f64 = losses.iter().map(|p| p.abs()).sum();
    let profit_factor = if total_losses > 0.0 { total_wins / total_losses } else { f64::INFINITY };

    let total_pnl: f64 = pnl_series.iter().sum();

    // Expectancy per trade
    let expectancy = (win_rate / 100.0) * avg_win - ((100.0 - win_rate) / 100.0) * avg_loss;

    // Sharpe/Sortino from PnL series
    let sharpe_val  = if pnl_series.len() >= 2 {
        sharpe_ratio(pnl_series, risk_free, periods_per_year).ok()
    } else { None };

    let sortino_val = if pnl_series.len() >= 2 {
        crate::indicators::sortino_ratio(pnl_series, risk_free, periods_per_year).ok()
    } else { None };

    let max_dd = if equity_curve.len() >= 2 {
        max_drawdown(equity_curve).ok()
    } else { None };

    let kelly = if win_rate > 0.0 && avg_win > 0.0 && avg_loss > 0.0 {
        kelly_criterion(win_rate / 100.0, avg_win, avg_loss).ok()
    } else { None };

    Ok(PerformanceMetrics {
        trade_count:      total,
        win_count,
        loss_count,
        win_rate_pct:     win_rate,
        avg_win_usdt:     avg_win,
        avg_loss_usdt:    avg_loss,
        profit_factor,
        total_pnl_usdt:   total_pnl,
        sharpe:           sharpe_val,
        sortino:          sortino_val,
        max_drawdown_pct: max_dd,
        kelly_fraction:   kelly,
        expectancy_usdt:  expectancy,
    })
}

// ── BREAK-EVEN STOP UPDATER ───────────────────────────────────────────────────

/// Compute new stop-loss price after moving to break-even.
/// Returns None if position has not yet reached the break-even threshold.
pub fn compute_break_even_stop(
    entry_price:     f64,
    current_price:   f64,
    atr_val:         f64,
    be_atr_mult:     f64,
    fee_pct:         f64,
    is_long:         bool,
) -> Result<Option<f64>> {
    if entry_price   <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("compute_break_even_stop: entry_price must be > 0, got {entry_price}") }); }
    if current_price <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("compute_break_even_stop: current_price must be > 0, got {current_price}") }); }
    if atr_val       <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("compute_break_even_stop: atr_val must be > 0, got {atr_val}") }); }
    if be_atr_mult   <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("compute_break_even_stop: be_atr_mult must be > 0, got {be_atr_mult}") }); }
    if fee_pct < 0.0        { return Err(IndicatorError::InvalidInput { msg: format!("compute_break_even_stop: fee_pct must be >= 0, got {fee_pct}") }); }

    let threshold = atr_val * be_atr_mult;
    let profit_dist = if is_long {
        current_price - entry_price
    } else {
        entry_price - current_price
    };

    if profit_dist < threshold {
        return Ok(None); // not yet in break-even territory
    }

    // New SL = entry + small buffer to cover fees
    let fee_buffer = entry_price * fee_pct / 100.0;
    let new_sl = if is_long {
        entry_price + fee_buffer
    } else {
        entry_price - fee_buffer
    };

    if new_sl <= 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("compute_break_even_stop: computed new_sl {new_sl:.4} is not positive"),
        });
    }

    Ok(Some(new_sl))
}

// ── DAILY LOSS LIMIT CHECKER ──────────────────────────────────────────────────

/// Returns true if the daily loss limit has been breached.
/// `closed_pnl_today` = sum of all net PnL for positions closed today (negative = loss).
pub fn is_daily_loss_breached(
    closed_pnl_today:   f64,
    daily_loss_limit:   f64,
) -> Result<bool> {
    if daily_loss_limit < 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("is_daily_loss_breached: daily_loss_limit must be >= 0, got {daily_loss_limit}"),
        });
    }
    // closed_pnl_today is negative when in loss; abs value vs limit
    Ok(closed_pnl_today < 0.0 && closed_pnl_today.abs() >= daily_loss_limit)
}

// ── LIQUIDATION PRICE CALCULATOR ─────────────────────────────────────────────

/// Compute the liquidation price for a leveraged position.
/// Returns the price at which the position is fully liquidated.
pub fn liquidation_price(
    entry_price:    f64,
    leverage:       f64,
    maintenance_margin_pct: f64,
    is_long:        bool,
) -> Result<f64> {
    if entry_price <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("liquidation_price: entry_price must be > 0, got {entry_price}") });
    }
    if leverage < 1.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("liquidation_price: leverage must be >= 1, got {leverage}") });
    }
    if leverage > HARD_MAX_LEVERAGE {
        return Err(IndicatorError::InvalidInput {
            msg: format!("liquidation_price: leverage {leverage} exceeds hard max {HARD_MAX_LEVERAGE}"),
        });
    }
    if maintenance_margin_pct < 0.0 || maintenance_margin_pct >= 100.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("liquidation_price: maintenance_margin_pct must be 0-100, got {maintenance_margin_pct}"),
        });
    }

    let mm_fraction = maintenance_margin_pct / 100.0;
    let liq = if is_long {
        entry_price * (1.0 - 1.0 / leverage + mm_fraction)
    } else {
        entry_price * (1.0 + 1.0 / leverage - mm_fraction)
    };

    if liq <= 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("liquidation_price: computed liquidation price {liq:.4} is not positive"),
        });
    }

    Ok(liq)
}
