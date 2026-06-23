// src/validation.rs
// Full candle feed validation pipeline.
// Called by the bridge before any indicator computation on live data.
// Returns a ValidationReport — caller decides whether to reject or warn.

use crate::types::{Candle, ValidationReport, IndicatorError};
use crate::indicators::{
    validate_price_sanity,
    validate_no_duplicate_timestamps,
    validate_timestamps_ascending,
    detect_volume_anomalies,
};

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
/// Maximum allowable single-candle price move before flagging as bad data.
const MAX_SINGLE_MOVE_PCT: f64 = 50.0;

/// Volume anomaly threshold — candles exceeding this many sigma flagged.
const VOLUME_ANOMALY_SIGMA: f64 = 5.0;

/// Volume rolling window for anomaly detection.
const VOLUME_ANOMALY_WINDOW: usize = 20;

/// Minimum close price — rejects tokens trading below $0.000001.
const MIN_CLOSE_PRICE: f64 = 0.000_001;

/// Maximum close price — sanity ceiling (BTC won't be $1B for a while).
const MAX_CLOSE_PRICE: f64 = 10_000_000.0;

/// Maximum spread between high and low as % of close — flags bad tick data.
const MAX_INTRACANDLE_RANGE_PCT: f64 = 40.0;

// ── FULL VALIDATION PIPELINE ──────────────────────────────────────────────────

/// Run every validation check against a candle slice.
/// Returns a ValidationReport. `report.valid` is false if any hard error found.
/// Warnings are advisory — callers may proceed with caution.
pub fn validate_candle_feed(candles: &[Candle]) -> ValidationReport {
    let mut report = ValidationReport::new();
    report.candle_count = candles.len();

    if candles.is_empty() {
        report.add_error("validate_candle_feed: candle slice is empty".into());
        return report;
    }

    // ── 1. Per-candle OHLC integrity ─────────────────────────────────────────
    for (i, c) in candles.iter().enumerate() {
        if let Err(e) = c.validate(i) {
            report.add_error(format!("{e}"));
            report.ohlc_integrity_errors.push(i);
        }
        // Price range bounds
        if c.close < MIN_CLOSE_PRICE {
            report.add_error(format!(
                "candle[{i}]: close price {:.8} below minimum {MIN_CLOSE_PRICE}",
                c.close
            ));
        }
        if c.close > MAX_CLOSE_PRICE {
            report.add_error(format!(
                "candle[{i}]: close price {:.2} exceeds maximum {MAX_CLOSE_PRICE}",
                c.close
            ));
        }
        // Intracandle range — extremely wide candles signal bad data
        if c.close > 0.0 {
            let range_pct = (c.high - c.low) / c.close * 100.0;
            if range_pct > MAX_INTRACANDLE_RANGE_PCT {
                report.add_warning(format!(
                    "candle[{i}]: intracandle range {range_pct:.2}% exceeds {MAX_INTRACANDLE_RANGE_PCT}% — possible bad tick"
                ));
            }
        }
        // Zero volume is suspicious but not an error — some exchanges report 0 on holidays
        if c.volume == 0.0 {
            report.add_warning(format!("candle[{i}]: zero volume"));
        }
    }

    // Stop here if basic OHLC integrity failed — subsequent checks may panic on bad data
    if !report.valid { return report; }

    // ── 2. Timestamp checks ───────────────────────────────────────────────────
    let has_timestamps = candles.iter().any(|c| c.time.is_some());
    if has_timestamps {
        if let Err(e) = validate_no_duplicate_timestamps(candles) {
            report.add_error(format!("{e}"));
        }
        if let Err(e) = validate_timestamps_ascending(candles) {
            report.add_error(format!("{e}"));
        }
        // Collect duplicate timestamps for the report
        {
            use std::collections::HashMap;
            let mut counts: HashMap<u64, usize> = HashMap::new();
            for c in candles {
                if let Some(ts) = c.time { *counts.entry(ts).or_insert(0) += 1; }
            }
            for (ts, count) in &counts {
                if *count > 1 { report.duplicate_timestamps.push(*ts); }
            }
        }
    }

    // ── 3. Inter-candle price sanity ──────────────────────────────────────────
    if let Err(e) = validate_price_sanity(candles, MAX_SINGLE_MOVE_PCT) {
        report.add_error(format!("{e}"));
    }

    // ── 4. Volume anomaly detection ───────────────────────────────────────────
    if candles.len() > VOLUME_ANOMALY_WINDOW {
        match detect_volume_anomalies(candles, VOLUME_ANOMALY_WINDOW, VOLUME_ANOMALY_SIGMA) {
            Ok(anomalies) => {
                if !anomalies.is_empty() {
                    report.add_warning(format!(
                        "{} candles with volume > {VOLUME_ANOMALY_SIGMA}σ above rolling mean: {:?}",
                        anomalies.len(),
                        &anomalies[..anomalies.len().min(10)]
                    ));
                    report.anomalous_volume_idx = anomalies;
                }
            }
            Err(e) => report.add_warning(format!("volume anomaly check failed: {e}")),
        }
    }

    // ── 5. Gap detection — missing candles in time series ─────────────────────
    if has_timestamps && candles.len() >= 2 {
        let gaps = detect_time_gaps(candles);
        for (idx, expected_ms, actual_ms) in &gaps {
            report.add_warning(format!(
                "time gap at candle[{idx}]: expected interval ~{expected_ms}ms, got {actual_ms}ms (possible missing candles)"
            ));
        }
    }

    // ── 6. Flat price detection — frozen feed guard ───────────────────────────
    if candles.len() >= 5 {
        let last5_closes: Vec<f64> = candles[candles.len()-5..].iter().map(|c| c.close).collect();
        if last5_closes.windows(2).all(|w| (w[0] - w[1]).abs() < f64::EPSILON) {
            report.add_error(format!(
                "validate_candle_feed: last 5 candles have identical close price {:.8} — frozen feed suspected",
                last5_closes[0]
            ));
        }
    }

    report
}

// ── GAP DETECTION ─────────────────────────────────────────────────────────────

/// Detect unexpected time gaps between consecutive candles.
/// Returns (index, expected_interval_ms, actual_interval_ms) for each gap.
/// A gap is flagged when actual > 2.5x the median interval (handles DST, weekends).
fn detect_time_gaps(candles: &[Candle]) -> Vec<(usize, u64, u64)> {
    if candles.len() < 3 { return Vec::new(); }

    // Compute all intervals
    let intervals: Vec<u64> = candles.windows(2)
        .filter_map(|w| {
            match (w[0].time, w[1].time) {
                (Some(a), Some(b)) if b > a => Some(b - a),
                _ => None,
            }
        })
        .collect();

    if intervals.is_empty() { return Vec::new(); }

    // Median interval = expected candle spacing
    let mut sorted = intervals.clone();
    sorted.sort_unstable();
    let median = sorted[sorted.len() / 2];
    let threshold = median * 5 / 2; // 2.5x

    let mut gaps = Vec::new();
    for (i, &interval) in intervals.iter().enumerate() {
        if interval > threshold {
            gaps.push((i + 1, median, interval));
        }
    }
    gaps
}

// ── ORDER PROPOSAL VALIDATOR ──────────────────────────────────────────────────

/// Validates an order proposal against exchange trading rules.
/// Returns Ok(()) if safe to send, Err with specific reason if not.
/// This runs in Rust before Node.js ever touches the exchange API.
pub fn validate_order_proposal(
    pair:            &str,
    side:            &str,
    quantity:        Option<f64>,
    quote_qty:       Option<f64>,
    price:           Option<f64>,
    stop_price:      Option<f64>,
    order_type:      &str,
    min_qty:         f64,
    max_qty:         f64,
    min_notional:    f64,
    step_size:       f64,
    tick_size:       f64,
) -> Result<(), IndicatorError> {
    // ── Pair format ──────────────────────────────────────────────────────────
    if pair.is_empty() {
        return Err(IndicatorError::InvalidInput { msg: "order: pair cannot be empty".into() });
    }
    if !pair.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '/') {
        return Err(IndicatorError::InvalidInput { msg: format!("order: invalid pair format '{pair}'") });
    }

    // ── Side ──────────────────────────────────────────────────────────────────
    let side_upper = side.to_uppercase();
    if side_upper != "BUY" && side_upper != "SELL" {
        return Err(IndicatorError::InvalidInput { msg: format!("order: side must be BUY or SELL, got '{side}'") });
    }

    // ── At least one size field required ──────────────────────────────────────
    if quantity.is_none() && quote_qty.is_none() {
        return Err(IndicatorError::InvalidInput { msg: "order: quantity or quote_qty required".into() });
    }

    // ── Quantity validation ───────────────────────────────────────────────────
    if let Some(q) = quantity {
        if !q.is_finite() || q <= 0.0 {
            return Err(IndicatorError::InvalidInput { msg: format!("order: quantity must be > 0, got {q}") });
        }
        if q < min_qty {
            return Err(IndicatorError::InvalidInput { msg: format!("order: quantity {q} below min_qty {min_qty}") });
        }
        if q > max_qty {
            return Err(IndicatorError::InvalidInput { msg: format!("order: quantity {q} exceeds max_qty {max_qty}") });
        }
        // Lot size (step size) compliance — quantity must be a multiple of step_size
        if step_size > 0.0 {
            let remainder = (q / step_size).fract();
            if remainder > 1e-8 && (1.0 - remainder) > 1e-8 {
                return Err(IndicatorError::InvalidInput {
                    msg: format!("order: quantity {q} is not a multiple of step_size {step_size}"),
                });
            }
        }
    }

    // ── Quote qty validation ──────────────────────────────────────────────────
    if let Some(qq) = quote_qty {
        if !qq.is_finite() || qq <= 0.0 {
            return Err(IndicatorError::InvalidInput { msg: format!("order: quote_qty must be > 0, got {qq}") });
        }
        if qq < min_notional {
            return Err(IndicatorError::InvalidInput { msg: format!("order: quote_qty {qq} below min_notional {min_notional}") });
        }
    }

    // ── Price validation (limit/stop-limit orders) ────────────────────────────
    let otype_upper = order_type.to_uppercase();
    match otype_upper.as_str() {
        "LIMIT" | "STOP_LIMIT" => {
            let p = price.ok_or_else(|| IndicatorError::InvalidInput {
                msg: format!("order: {order_type} requires price"),
            })?;
            if !p.is_finite() || p <= 0.0 {
                return Err(IndicatorError::InvalidInput { msg: format!("order: price must be > 0, got {p}") });
            }
            // Tick size compliance
            if tick_size > 0.0 {
                let remainder = (p / tick_size).fract();
                if remainder > 1e-8 && (1.0 - remainder) > 1e-8 {
                    return Err(IndicatorError::InvalidInput {
                        msg: format!("order: price {p} is not a multiple of tick_size {tick_size}"),
                    });
                }
            }
        }
        "STOP_MARKET" | "TRAILING_STOP_MARKET" => {
            let sp = stop_price.ok_or_else(|| IndicatorError::InvalidInput {
                msg: format!("order: {order_type} requires stop_price"),
            })?;
            if !sp.is_finite() || sp <= 0.0 {
                return Err(IndicatorError::InvalidInput { msg: format!("order: stop_price must be > 0, got {sp}") });
            }
        }
        "MARKET" | "OCO" => {} // no price required
        other => {
            return Err(IndicatorError::InvalidInput { msg: format!("order: unknown order_type '{other}'") });
        }
    }

    // ── Notional check for limit orders ───────────────────────────────────────
    if let (Some(q), Some(p)) = (quantity, price) {
        let notional = q * p;
        if notional < min_notional {
            return Err(IndicatorError::InvalidInput {
                msg: format!("order: notional ${notional:.4} (qty {q} × price {p}) below min_notional {min_notional}"),
            });
        }
    }

    Ok(())
}

// ── SLIPPAGE GUARD ────────────────────────────────────────────────────────────

/// Compare expected price vs re-fetched price and return slippage %.
/// Returns Err if slippage exceeds max_slippage_pct.
pub fn check_slippage(
    expected_price:   f64,
    current_price:    f64,
    max_slippage_pct: f64,
    side:             &str,
) -> Result<f64, IndicatorError> {
    if expected_price <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("check_slippage: expected_price must be > 0, got {expected_price}") });
    }
    if current_price <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("check_slippage: current_price must be > 0, got {current_price}") });
    }
    if max_slippage_pct < 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("check_slippage: max_slippage_pct must be >= 0, got {max_slippage_pct}") });
    }

    let slippage_pct = ((current_price - expected_price) / expected_price).abs() * 100.0;

    // For buys: adverse slippage means current > expected (paid more).
    // For sells: adverse slippage means current < expected (received less).
    let is_adverse = match side.to_uppercase().as_str() {
        "BUY"  => current_price > expected_price,
        "SELL" => current_price < expected_price,
        _      => true, // conservative — treat unknown side as adverse
    };

    if is_adverse && slippage_pct > max_slippage_pct {
        return Err(IndicatorError::InvalidInput {
            msg: format!(
                "check_slippage: {side} adverse slippage {slippage_pct:.4}% exceeds limit {max_slippage_pct}% \
                 (expected {expected_price:.4}, current {current_price:.4})"
            ),
        });
    }

    Ok(slippage_pct)
}

// ── ORACLE DEVIATION CHECK ────────────────────────────────────────────────────

/// Cross-validate a CEX price against an oracle price.
/// Returns the deviation % and Err if it exceeds the limit.
pub fn check_oracle_deviation(
    cex_price:       f64,
    oracle_price:    f64,
    max_dev_pct:     f64,
    symbol:          &str,
) -> Result<f64, IndicatorError> {
    if cex_price   <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("check_oracle_deviation: cex_price must be > 0, got {cex_price}") }); }
    if oracle_price <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("check_oracle_deviation: oracle_price must be > 0, got {oracle_price}") }); }
    if max_dev_pct  <  0.0 { return Err(IndicatorError::InvalidInput { msg: format!("check_oracle_deviation: max_dev_pct must be >= 0, got {max_dev_pct}") }); }

    let dev_pct = ((cex_price - oracle_price) / oracle_price).abs() * 100.0;

    if dev_pct > max_dev_pct {
        return Err(IndicatorError::InvalidInput {
            msg: format!(
                "check_oracle_deviation: {symbol} CEX/oracle deviation {dev_pct:.4}% exceeds limit {max_dev_pct}% \
                 (cex={cex_price:.4}, oracle={oracle_price:.4})"
            ),
        });
    }

    Ok(dev_pct)
}

// ── FUNDING RATE SANITY CHECK ─────────────────────────────────────────────────

/// Reject funding rates that are clearly erroneous (exchange bug / bad data).
/// Normal funding rates are -0.3% to +0.3% per 8h period.
pub fn validate_funding_rate(rate_pct: f64, symbol: &str) -> Result<(), IndicatorError> {
    const MAX_FUNDING_ABS_PCT: f64 = 2.0; // 2% per period is extremely abnormal
    if !rate_pct.is_finite() {
        return Err(IndicatorError::InvalidInput { msg: format!("validate_funding_rate: {symbol} rate is not finite: {rate_pct}") });
    }
    if rate_pct.abs() > MAX_FUNDING_ABS_PCT {
        return Err(IndicatorError::InvalidInput {
            msg: format!(
                "validate_funding_rate: {symbol} rate {rate_pct:.4}% is abnormally high \
                 (absolute limit {MAX_FUNDING_ABS_PCT}%) — possible exchange data error"
            ),
        });
    }
    Ok(())
}
