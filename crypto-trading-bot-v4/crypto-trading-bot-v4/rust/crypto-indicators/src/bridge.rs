// src/bridge.rs
// stdin/stdout JSON bridge between Node.js and the Rust binary.
// Protocol: one JSON object per line in, one JSON object per line out.
// Every request is validated before dispatch. Every error is caught and returned
// as a structured BridgeResponse — the binary never exits on a per-request error.
// Security: input size limited, function name allowlisted, params type-checked.

use std::io::{self, BufRead, Write};
use std::time::Instant;
use serde_json::Value;

use crate::types::{
    BridgeRequest, BridgeResponse, Candle, MaType,
    PositionSnapshot, BridgeStats, ValidationReport, IndicatorError,
};
use crate::indicators::*;
use crate::validation::{
    validate_candle_feed, validate_order_proposal,
    check_slippage, check_oracle_deviation, validate_funding_rate,
};
use crate::risk::{
    evaluate_position_exit, evaluate_portfolio_risk,
    compute_position_size, validate_risk_reward,
    compute_drawdown, compute_performance_metrics,
    compute_break_even_stop, is_daily_loss_breached,
    liquidation_price,
};
use crate::seasonal::{
    candle_returns, compute_pattern, compute_monthly_patterns,
    compute_dow_patterns, compute_seasonal_bias,
    find_most_similar_year, find_accumulation_months,
    compute_spike_reversion_stats, SpikeRecord,
};

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
/// Maximum bytes per request line. Prevents memory exhaustion from a malicious caller.
const MAX_LINE_BYTES: usize = 2_097_152; // 2 MB

/// Allowlisted function names. Any name not in this set is rejected immediately.
const ALLOWED_FN: &[&str] = &[
    "sma", "ema", "wilder_sma", "ema_history", "ma",
    "std_dev", "std_dev_sample", "z_score",
    "rsi", "rsi_history", "stoch_rsi",
    "macd", "atr", "bollinger", "vwap",
    "momentum", "crossover", "divergence",
    "ichimoku", "adx", "fibonacci", "pivot",
    "volume_profile", "donchian",
    "to_returns", "normalize", "correlation", "dtw",
    "sharpe", "sortino", "calmar", "max_drawdown", "kelly",
    "net_profit_pct", "tri_cycle", "grid_profit", "grid_spec",
    "scan_cross_arb", "scan_tri_cycles",
    "funding_payment", "funding_accum", "atr_stops",
    "trend_signal", "mean_reversion_signal", "momentum_scalp_signal",
    "dca_multiplier", "path_similarity",
    "validate_candles", "validate_order", "check_slippage",
    "check_oracle_deviation", "validate_funding_rate",
    "position_exit", "portfolio_risk", "position_size",
    "validate_rr", "drawdown", "performance_metrics",
    "break_even_stop", "daily_loss_breached", "liquidation_price",
    "seasonal_monthly", "seasonal_dow", "seasonal_bias",
    "find_similar_year", "accumulation_months",
    "spike_reversion", "candle_returns",
    "health", "stats",
];

// ── BRIDGE MAIN LOOP ──────────────────────────────────────────────────────────

pub fn run_bridge() {
    let stdin  = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let mut stats = BridgeStats::default();

    let start_time = Instant::now();

    log::info!("crypto-indicators bridge started. Waiting for requests on stdin.");

    for line_result in stdin.lock().lines() {
        // ── Read line ─────────────────────────────────────────────────────────
        let line = match line_result {
            Ok(l) => l,
            Err(e) => {
                log::error!("stdin read error: {e}");
                break;
            }
        };

        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        // ── Size guard ────────────────────────────────────────────────────────
        if trimmed.len() > MAX_LINE_BYTES {
            let resp = BridgeResponse::err(
                0,
                format!("request exceeds max size {} bytes (got {})", MAX_LINE_BYTES, trimmed.len()),
                "validation",
                0,
            );
            write_response(&mut out, &resp);
            continue;
        }

        // ── Parse envelope ────────────────────────────────────────────────────
        let req: BridgeRequest = match serde_json::from_str(trimmed) {
            Ok(r)  => r,
            Err(e) => {
                let resp = BridgeResponse::err(0, format!("JSON parse error: {e}"), "validation", 0);
                write_response(&mut out, &resp);
                continue;
            }
        };

        // ── Allowlist check ───────────────────────────────────────────────────
        if !ALLOWED_FN.contains(&req.fn_name.as_str()) {
            let resp = BridgeResponse::err(
                req.id,
                format!("unknown function '{}'. Allowed: {}", req.fn_name, ALLOWED_FN.join(", ")),
                "validation",
                0,
            );
            write_response(&mut out, &resp);
            continue;
        }

        // ── Dispatch ──────────────────────────────────────────────────────────
        let t0 = Instant::now();
        let result = dispatch(&req, &mut stats, start_time);
        let elapsed_us = t0.elapsed().as_micros() as u64;

        stats.record_call(elapsed_us, result.is_err());

        let resp = match result {
            Ok(data) => BridgeResponse::ok(req.id, data, elapsed_us),
            Err(e)   => {
                let kind = error_kind(&e);
                BridgeResponse::err(req.id, format!("{e}"), kind, elapsed_us)
            }
        };

        write_response(&mut out, &resp);
    }

    log::info!("Bridge stdin closed. Exiting.");
}

// ── WRITE RESPONSE ────────────────────────────────────────────────────────────

fn write_response(out: &mut impl Write, resp: &BridgeResponse) {
    match serde_json::to_string(resp) {
        Ok(s) => {
            if let Err(e) = writeln!(out, "{s}") {
                log::error!("stdout write error: {e}");
            }
            let _ = out.flush();
        }
        Err(e) => log::error!("response serialization failed: {e}"),
    }
}

// ── ERROR KIND CLASSIFIER ─────────────────────────────────────────────────────

fn error_kind(e: &IndicatorError) -> &'static str {
    match e {
        IndicatorError::InsufficientData { .. } => "validation",
        IndicatorError::InvalidPeriod    { .. } => "validation",
        IndicatorError::InvalidCandle    { .. } => "validation",
        IndicatorError::CandleIntegrity  { .. } => "validation",
        IndicatorError::NonFiniteInput   { .. } => "validation",
        IndicatorError::InvalidInput     { .. } => "validation",
        IndicatorError::DivisionByZero   { .. } => "computation",
    }
}

// ── PARAM HELPERS ─────────────────────────────────────────────────────────────

fn get_f64(p: &Value, key: &str) -> Result<f64, IndicatorError> {
    p.get(key)
        .and_then(|v| v.as_f64())
        .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("missing or invalid f64 param '{key}'") })
}

fn get_u64(p: &Value, key: &str) -> Result<u64, IndicatorError> {
    p.get(key)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("missing or invalid u64 param '{key}'") })
}

fn get_usize(p: &Value, key: &str) -> Result<usize, IndicatorError> {
    get_u64(p, key).map(|v| v as usize)
}

fn get_str<'a>(p: &'a Value, key: &str) -> Result<&'a str, IndicatorError> {
    p.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("missing or invalid string param '{key}'") })
}

fn get_bool(p: &Value, key: &str) -> Result<bool, IndicatorError> {
    p.get(key)
        .and_then(|v| v.as_bool())
        .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("missing or invalid bool param '{key}'") })
}

fn get_f64_opt(p: &Value, key: &str) -> Option<f64> {
    p.get(key).and_then(|v| v.as_f64())
}

fn get_usize_opt(p: &Value, key: &str) -> Option<usize> {
    p.get(key).and_then(|v| v.as_u64()).map(|v| v as usize)
}

fn parse_closes(p: &Value, key: &str) -> Result<Vec<f64>, IndicatorError> {
    let arr = p.get(key)
        .and_then(|v| v.as_array())
        .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("missing or invalid array param '{key}'") })?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, v) in arr.iter().enumerate() {
        let f = v.as_f64().ok_or_else(|| IndicatorError::NonFiniteInput { pos: i, value: f64::NAN })?;
        if !f.is_finite() { return Err(IndicatorError::NonFiniteInput { pos: i, value: f }); }
        out.push(f);
    }
    Ok(out)
}

fn parse_candles(p: &Value, key: &str) -> Result<Vec<Candle>, IndicatorError> {
    let arr = p.get(key)
        .and_then(|v| v.as_array())
        .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("missing or invalid array param '{key}'") })?;

    let mut candles = Vec::with_capacity(arr.len());
    for (i, v) in arr.iter().enumerate() {
        let c: Candle = serde_json::from_value(v.clone())
            .map_err(|e| IndicatorError::InvalidInput { msg: format!("candle[{i}] parse error: {e}") })?;
        c.validate(i)?;
        candles.push(c);
    }
    Ok(candles)
}

fn parse_ma_type(p: &Value, key: &str) -> Result<MaType, IndicatorError> {
    match get_str(p, key)?.to_uppercase().as_str() {
        "SMA"  => Ok(MaType::Sma),
        "EMA"  => Ok(MaType::Ema),
        "WSMA" => Ok(MaType::Wsma),
        other  => Err(IndicatorError::InvalidInput { msg: format!("unknown MaType '{other}'. Use SMA, EMA, or WSMA") }),
    }
}

// ── DISPATCHER ────────────────────────────────────────────────────────────────

fn dispatch(req: &BridgeRequest, stats: &mut BridgeStats, start: Instant) -> Result<Value, IndicatorError> {
    let p = &req.params;

    match req.fn_name.as_str() {

        // ── Moving Averages ───────────────────────────────────────────────────
        "sma" => {
            let data = parse_closes(p, "data")?;
            let n    = get_usize(p, "n")?;
            Ok(serde_json::json!(sma(&data, n)?))
        }
        "ema" => {
            let data = parse_closes(p, "data")?;
            let n    = get_usize(p, "n")?;
            Ok(serde_json::json!(ema(&data, n)?))
        }
        "wilder_sma" => {
            let data = parse_closes(p, "data")?;
            let n    = get_usize(p, "n")?;
            Ok(serde_json::json!(wilder_sma(&data, n)?))
        }
        "ema_history" => {
            let data = parse_closes(p, "data")?;
            let n    = get_usize(p, "n")?;
            Ok(serde_json::json!(ema_history(&data, n)?))
        }
        "ma" => {
            let data    = parse_closes(p, "data")?;
            let n       = get_usize(p, "n")?;
            let ma_type = parse_ma_type(p, "type")?;
            Ok(serde_json::json!(ma(&data, n, &ma_type)?))
        }

        // ── Statistics ────────────────────────────────────────────────────────
        "std_dev" => {
            let data = parse_closes(p, "data")?;
            let n    = get_usize(p, "n")?;
            Ok(serde_json::json!(std_dev(&data, n)?))
        }
        "std_dev_sample" => {
            let data = parse_closes(p, "data")?;
            let n    = get_usize(p, "n")?;
            Ok(serde_json::json!(std_dev_sample(&data, n)?))
        }
        "z_score" => {
            let closes = parse_closes(p, "closes")?;
            let price  = get_f64(p, "price")?;
            let n      = get_usize(p, "n")?;
            Ok(serde_json::json!(z_score(price, &closes, n)?))
        }
        "normalize" => {
            let data = parse_closes(p, "data")?;
            Ok(serde_json::json!(normalize(&data)?))
        }
        "correlation" => {
            let a = parse_closes(p, "a")?;
            let b = parse_closes(p, "b")?;
            Ok(serde_json::json!(correlation(&a, &b)?))
        }
        "dtw" => {
            let a = parse_closes(p, "a")?;
            let b = parse_closes(p, "b")?;
            Ok(serde_json::json!(dtw_distance(&a, &b)?))
        }
        "to_returns" => {
            let prices = parse_closes(p, "prices")?;
            Ok(serde_json::json!(to_returns(&prices)?))
        }

        // ── RSI ───────────────────────────────────────────────────────────────
        "rsi" => {
            let closes = parse_closes(p, "closes")?;
            let n      = get_usize(p, "n")?;
            Ok(serde_json::json!(rsi(&closes, n)?))
        }
        "rsi_history" => {
            let closes = parse_closes(p, "closes")?;
            let n      = get_usize(p, "n")?;
            Ok(serde_json::json!(rsi_history(&closes, n)?))
        }
        "stoch_rsi" => {
            let closes       = parse_closes(p, "closes")?;
            let rsi_period   = get_usize(p, "rsi_period")?;
            let stoch_period = get_usize(p, "stoch_period")?;
            let smooth_k     = get_usize(p, "smooth_k")?;
            let smooth_d     = get_usize(p, "smooth_d")?;
            Ok(serde_json::to_value(stoch_rsi(&closes, rsi_period, stoch_period, smooth_k, smooth_d)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── MACD ──────────────────────────────────────────────────────────────
        "macd" => {
            let closes = parse_closes(p, "closes")?;
            let fast   = get_usize(p, "fast")?;
            let slow   = get_usize(p, "slow")?;
            let signal = get_usize(p, "signal")?;
            Ok(serde_json::to_value(macd(&closes, fast, slow, signal)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── ATR ───────────────────────────────────────────────────────────────
        "atr" => {
            let candles = parse_candles(p, "candles")?;
            let n       = get_usize(p, "n")?;
            Ok(serde_json::json!(atr(&candles, n)?))
        }

        // ── Bollinger Bands ───────────────────────────────────────────────────
        "bollinger" => {
            let closes = parse_closes(p, "closes")?;
            let n      = get_usize(p, "n")?;
            let k      = get_f64(p, "k")?;
            Ok(serde_json::to_value(bollinger_bands(&closes, n, k)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── VWAP ─────────────────────────────────────────────────────────────
        "vwap" => {
            let candles = parse_candles(p, "candles")?;
            Ok(serde_json::json!(vwap(&candles)?))
        }

        // ── Momentum ──────────────────────────────────────────────────────────
        "momentum" => {
            let closes = parse_closes(p, "closes")?;
            let n      = get_usize(p, "n")?;
            Ok(serde_json::json!(momentum(&closes, n)?))
        }

        // ── MA Crossover ──────────────────────────────────────────────────────
        "crossover" => {
            let closes  = parse_closes(p, "closes")?;
            let fast    = get_usize(p, "fast")?;
            let slow    = get_usize(p, "slow")?;
            let ma_type = parse_ma_type(p, "type")?;
            let result  = ma_crossover(&closes, fast, slow, &ma_type)?;
            Ok(serde_json::json!(result.map(|c| format!("{c:?}"))))
        }

        // ── RSI Divergence ────────────────────────────────────────────────────
        "divergence" => {
            let closes     = parse_closes(p, "closes")?;
            let rsi_values = parse_closes(p, "rsi_values")?;
            let lookback   = get_usize(p, "lookback")?;
            let result     = rsi_divergence(&closes, &rsi_values, lookback)?;
            Ok(serde_json::json!(result.map(|d| format!("{d:?}"))))
        }

        // ── Ichimoku ─────────────────────────────────────────────────────────
        "ichimoku" => {
            let candles = parse_candles(p, "candles")?;
            let tenkan  = get_usize(p, "tenkan")?;
            let kijun   = get_usize(p, "kijun")?;
            let senkou  = get_usize(p, "senkou")?;
            Ok(serde_json::to_value(ichimoku(&candles, tenkan, kijun, senkou)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── ADX ───────────────────────────────────────────────────────────────
        "adx" => {
            let candles = parse_candles(p, "candles")?;
            let n       = get_usize(p, "n")?;
            Ok(serde_json::to_value(adx(&candles, n)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── Fibonacci ─────────────────────────────────────────────────────────
        "fibonacci" => {
            let high = get_f64(p, "high")?;
            let low  = get_f64(p, "low")?;
            Ok(serde_json::to_value(fibonacci(high, low)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── Pivot Points ──────────────────────────────────────────────────────
        "pivot" => {
            let high  = get_f64(p, "high")?;
            let low   = get_f64(p, "low")?;
            let close = get_f64(p, "close")?;
            Ok(serde_json::to_value(pivot_points(high, low, close)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── Volume Profile ────────────────────────────────────────────────────
        "volume_profile" => {
            let candles = parse_candles(p, "candles")?;
            let bins    = get_usize(p, "bins")?;
            Ok(serde_json::to_value(volume_profile(&candles, bins)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── Donchian Channel ──────────────────────────────────────────────────
        "donchian" => {
            let candles = parse_candles(p, "candles")?;
            let n       = get_usize(p, "n")?;
            Ok(serde_json::to_value(donchian_channel(&candles, n)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── Performance Math ──────────────────────────────────────────────────
        "sharpe" => {
            let returns        = parse_closes(p, "returns")?;
            let risk_free      = get_f64(p, "risk_free")?;
            let periods        = get_f64(p, "periods_per_year")?;
            Ok(serde_json::json!(sharpe_ratio(&returns, risk_free, periods)?))
        }
        "sortino" => {
            let returns   = parse_closes(p, "returns")?;
            let risk_free = get_f64(p, "risk_free")?;
            let periods   = get_f64(p, "periods_per_year")?;
            Ok(serde_json::json!(sortino_ratio(&returns, risk_free, periods)?))
        }
        "calmar" => {
            let annual_ret = get_f64(p, "annual_return_pct")?;
            let max_dd     = get_f64(p, "max_drawdown_pct")?;
            Ok(serde_json::json!(calmar_ratio(annual_ret, max_dd)?))
        }
        "max_drawdown" => {
            let equity = parse_closes(p, "equity")?;
            Ok(serde_json::json!(max_drawdown(&equity)?))
        }
        "kelly" => {
            let win_rate = get_f64(p, "win_rate")?;
            let avg_win  = get_f64(p, "avg_win")?;
            let avg_loss = get_f64(p, "avg_loss")?;
            Ok(serde_json::json!(kelly_criterion(win_rate, avg_win, avg_loss)?))
        }

        // ── Trading Business Logic ────────────────────────────────────────────
        "net_profit_pct" => {
            let buy_ask  = get_f64(p, "buy_ask")?;
            let sell_bid = get_f64(p, "sell_bid")?;
            let fee_buy  = get_f64(p, "fee_buy_pct")?;
            let fee_sell = get_f64(p, "fee_sell_pct")?;
            Ok(serde_json::json!(net_profit_pct(buy_ask, sell_bid, fee_buy, fee_sell)?))
        }
        "tri_cycle" => {
            let start   = get_f64(p, "start_amount")?;
            let fee     = get_f64(p, "fee_pct")?;
            let legs_raw = p.get("legs")
                .and_then(|v| v.as_array())
                .ok_or_else(|| IndicatorError::InvalidInput { msg: "missing legs array".into() })?;
            let mut legs: Vec<(bool, f64)> = Vec::with_capacity(legs_raw.len());
            for (i, leg) in legs_raw.iter().enumerate() {
                let is_buy = leg.get("is_buy").and_then(|v| v.as_bool())
                    .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("leg[{i}] missing is_buy") })?;
                let price = leg.get("price").and_then(|v| v.as_f64())
                    .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("leg[{i}] missing price") })?;
                legs.push((is_buy, price));
            }
            let (end, pct) = simulate_tri_cycle(start, &legs, fee)?;
            Ok(serde_json::json!({ "end_amount": end, "profit_pct": pct }))
        }
        "grid_profit" => {
            let buy_price  = get_f64(p, "buy_price")?;
            let sell_price = get_f64(p, "sell_price")?;
            let qty        = get_f64(p, "qty")?;
            let fee        = get_f64(p, "maker_fee_pct")?;
            Ok(serde_json::json!(grid_fill_profit(buy_price, sell_price, qty, fee)?))
        }
        "grid_spec" => {
            let lower    = get_f64(p, "lower")?;
            let upper    = get_f64(p, "upper")?;
            let levels   = get_usize(p, "num_levels")?;
            let capital  = get_f64(p, "total_capital")?;
            let price    = get_f64(p, "current_price")?;
            let fee      = get_f64(p, "maker_fee_pct")?;
            Ok(serde_json::to_value(build_grid(lower, upper, levels, capital, price, fee)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "scan_cross_arb" => {
            let bid_a  = get_f64(p, "bid_a")?; let ask_a  = get_f64(p, "ask_a")?;
            let bs_a   = get_f64(p, "bid_size_a")?; let as_a = get_f64(p, "ask_size_a")?;
            let bid_b  = get_f64(p, "bid_b")?; let ask_b  = get_f64(p, "ask_b")?;
            let bs_b   = get_f64(p, "bid_size_b")?; let as_b = get_f64(p, "ask_size_b")?;
            let fee_a  = get_f64(p, "fee_a_pct")?;
            let fee_b  = get_f64(p, "fee_b_pct")?;
            let trade  = get_f64(p, "trade_usdt")?;
            let min_p  = get_f64(p, "min_profit_pct")?;
            let max_sp = get_f64(p, "max_spread_pct")?;
            let min_d  = get_f64(p, "min_depth_usdt")?;
            let result = scan_cross_arb(bid_a, ask_a, bs_a, as_a, bid_b, ask_b, bs_b, as_b,
                fee_a, fee_b, trade, min_p, max_sp, min_d)?;
            Ok(serde_json::to_value(result)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "scan_tri_cycles" => {
            let start       = get_f64(p, "start_amount")?;
            let fee         = get_f64(p, "fee_pct")?;
            let min_profit  = get_f64(p, "min_profit_pct")?;
            let cycles_raw  = p.get("cycles")
                .and_then(|v| v.as_array())
                .ok_or_else(|| IndicatorError::InvalidInput { msg: "missing cycles array".into() })?;
            let mut cycles: Vec<(String, Vec<(bool, String, f64)>)> = Vec::new();
            for c in cycles_raw {
                let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("unnamed").to_string();
                let legs_raw = c.get("legs").and_then(|v| v.as_array())
                    .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("cycle '{name}' missing legs") })?;
                let mut legs = Vec::new();
                for (i, leg) in legs_raw.iter().enumerate() {
                    let is_buy = leg.get("is_buy").and_then(|v| v.as_bool())
                        .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("cycle '{name}' leg[{i}] missing is_buy") })?;
                    let pair = leg.get("pair").and_then(|v| v.as_str())
                        .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("cycle '{name}' leg[{i}] missing pair") })?.to_string();
                    let price = leg.get("price").and_then(|v| v.as_f64())
                        .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("cycle '{name}' leg[{i}] missing price") })?;
                    legs.push((is_buy, pair, price));
                }
                cycles.push((name, legs));
            }
            Ok(serde_json::to_value(scan_tri_cycles(start, &cycles, fee, min_profit)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "funding_payment" => {
            let notional = get_f64(p, "notional_usdt")?;
            let rate     = get_f64(p, "funding_rate_pct")?;
            Ok(serde_json::json!(funding_payment(notional, rate)?))
        }
        "funding_accum" => {
            let notional = get_f64(p, "notional_usdt")?;
            let rates    = parse_closes(p, "rates")?;
            Ok(serde_json::to_value(accumulate_funding(notional, &rates)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "atr_stops" => {
            let entry    = get_f64(p, "entry")?;
            let atr_val  = get_f64(p, "atr")?;
            let mult     = get_f64(p, "multiplier")?;
            let rr       = get_f64(p, "rr_ratio")?;
            let is_long  = get_bool(p, "is_long")?;
            let (sl, tp) = atr_stops(entry, atr_val, mult, rr, is_long)?;
            Ok(serde_json::json!({ "stop_loss": sl, "take_profit": tp }))
        }
        "dca_multiplier" => {
            let price        = get_f64(p, "price")?;
            let closes       = parse_closes(p, "closes")?;
            let sma_period   = get_usize(p, "sma_period")?;
            let max_mult     = get_f64(p, "max_multiplier")?;
            let dips_raw     = p.get("dips").and_then(|v| v.as_array())
                .ok_or_else(|| IndicatorError::InvalidInput { msg: "missing dips array".into() })?;
            let mut dips: Vec<(f64, f64)> = Vec::new();
            for (i, d) in dips_raw.iter().enumerate() {
                let drop = d.get("drop_percent").and_then(|v| v.as_f64())
                    .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("dips[{i}] missing drop_percent") })?;
                let mult = d.get("multiplier").and_then(|v| v.as_f64())
                    .ok_or_else(|| IndicatorError::InvalidInput { msg: format!("dips[{i}] missing multiplier") })?;
                dips.push((drop, mult));
            }
            Ok(serde_json::to_value(dca_multiplier(price, &closes, sma_period, &dips, max_mult)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "path_similarity" => {
            let current = parse_closes(p, "current_prices")?;
            let prior   = parse_closes(p, "prior_prices")?;
            let year    = get_u64(p, "year")? as u32;
            Ok(serde_json::to_value(compare_path_similarity(&current, &prior, year)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── Compound Strategy Signals ─────────────────────────────────────────
        "trend_signal" => {
            let candles       = parse_candles(p, "candles")?;
            let fast          = get_usize(p, "fast_period")?;
            let slow          = get_usize(p, "slow_period")?;
            let ma_type       = parse_ma_type(p, "ma_type")?;
            let rsi_p         = get_usize(p, "rsi_period")?;
            let rsi_ob        = get_f64(p, "rsi_overbought")?;
            let rsi_os        = get_f64(p, "rsi_oversold")?;
            let adx_p         = get_usize(p, "adx_period")?;
            let min_adx       = get_f64(p, "min_adx")?;
            let vol_mult      = get_f64(p, "volume_mult")?;
            let use_vwap      = get_bool(p, "use_vwap")?;
            let allow_short   = get_bool(p, "allow_short")?;
            let trade_usdt    = get_f64(p, "trade_usdt")?;
            let atr_p         = get_usize(p, "atr_period")?;
            let atr_mult      = get_f64(p, "atr_mult")?;
            let rr            = get_f64(p, "rr_ratio")?;
            let win_rate      = get_f64_opt(p, "win_rate").unwrap_or(0.0);
            let avg_win       = get_f64_opt(p, "avg_win").unwrap_or(0.0);
            let avg_loss      = get_f64_opt(p, "avg_loss").unwrap_or(0.0);
            Ok(serde_json::to_value(trend_signal(
                &candles, fast, slow, &ma_type, rsi_p, rsi_ob, rsi_os,
                adx_p, min_adx, vol_mult, use_vwap, allow_short, trade_usdt,
                atr_p, atr_mult, rr, win_rate, avg_win, avg_loss,
            )?)
            .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "mean_reversion_signal" => {
            let candles    = parse_candles(p, "candles")?;
            let zp         = get_usize(p, "zscore_period")?;
            let ze         = get_f64(p, "zscore_entry")?;
            let zs         = get_f64(p, "zscore_short")?;
            let bbp        = get_usize(p, "bb_period")?;
            let bbk        = get_f64(p, "bb_k")?;
            let rsi_p      = get_usize(p, "rsi_period")?;
            let rsi_os     = get_f64(p, "rsi_oversold")?;
            let rsi_ob     = get_f64(p, "rsi_overbought")?;
            let rsi_hist   = parse_closes(p, "rsi_history")?;
            let allow_s    = get_bool(p, "allow_short")?;
            let trade_u    = get_f64(p, "trade_usdt")?;
            let atr_p      = get_usize(p, "atr_period")?;
            let atr_m      = get_f64(p, "atr_mult")?;
            let rr         = get_f64(p, "rr_ratio")?;
            let seas_dir   = p.get("seasonal_dir").and_then(|v| v.as_str());
            let seas_conf  = get_f64_opt(p, "min_seasonal_conf").unwrap_or(0.3);
            Ok(serde_json::to_value(mean_reversion_signal(
                &candles, zp, ze, zs, bbp, bbk, rsi_p, rsi_os, rsi_ob,
                &rsi_hist, allow_s, trade_u, atr_p, atr_m, rr, seas_dir, seas_conf,
            )?)
            .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "momentum_scalp_signal" => {
            let candles   = parse_candles(p, "candles")?;
            let rsi_p     = get_usize(p, "rsi_period")?;
            let rsi_bull  = get_f64(p, "rsi_bullish")?;
            let rsi_bear  = get_f64(p, "rsi_bearish")?;
            let stoch_p   = get_usize(p, "stoch_rsi_period")?;
            let sk        = get_usize(p, "stoch_k")?;
            let sd        = get_usize(p, "stoch_d")?;
            let stoch_bull= get_f64(p, "stoch_bullish")?;
            let stoch_bear= get_f64(p, "stoch_bearish")?;
            let mom_p     = get_usize(p, "momentum_period")?;
            let mom_min   = get_f64(p, "momentum_min_pct")?;
            let bo_lb     = get_usize(p, "breakout_lookback")?;
            let vol_m     = get_f64(p, "volume_mult")?;
            let bid_vol   = get_f64(p, "bid_vol")?;
            let ask_vol   = get_f64(p, "ask_vol")?;
            let spread    = get_f64(p, "spread_pct")?;
            let max_spread= get_f64(p, "max_spread_pct")?;
            let min_imb   = get_f64(p, "min_imbalance")?;
            let use_vwap  = get_bool(p, "use_vwap")?;
            let allow_s   = get_bool(p, "allow_short")?;
            let rsi_hist  = parse_closes(p, "rsi_history")?;
            let atr_p     = get_usize(p, "atr_period")?;
            let atr_m     = get_f64(p, "atr_mult")?;
            let rr        = get_f64(p, "rr_ratio")?;
            Ok(serde_json::to_value(momentum_scalp_signal(
                &candles, rsi_p, rsi_bull, rsi_bear, stoch_p, sk, sd,
                stoch_bull, stoch_bear, mom_p, mom_min, bo_lb, vol_m,
                bid_vol, ask_vol, spread, max_spread, min_imb, use_vwap,
                allow_s, &rsi_hist, atr_p, atr_m, rr,
            )?)
            .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // ── Validation ────────────────────────────────────────────────────────
        "validate_candles" => {
            let candles = parse_candles(p, "candles")?;
            Ok(serde_json::to_value(validate_candle_feed(&candles))
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "validate_order" => {
            let pair      = get_str(p, "pair")?.to_string();
            let side      = get_str(p, "side")?.to_string();
            let qty       = get_f64_opt(p, "quantity");
            let quote_qty = get_f64_opt(p, "quote_qty");
            let price     = get_f64_opt(p, "price");
            let stop_price= get_f64_opt(p, "stop_price");
            let otype     = get_str(p, "order_type")?.to_string();
            let min_qty   = get_f64(p, "min_qty")?;
            let max_qty   = get_f64(p, "max_qty")?;
            let min_not   = get_f64(p, "min_notional")?;
            let step      = get_f64(p, "step_size")?;
            let tick      = get_f64(p, "tick_size")?;
            validate_order_proposal(&pair, &side, qty, quote_qty, price, stop_price,
                &otype, min_qty, max_qty, min_not, step, tick)?;
            Ok(serde_json::json!({ "valid": true }))
        }
        "check_slippage" => {
            let expected = get_f64(p, "expected_price")?;
            let current  = get_f64(p, "current_price")?;
            let max_slip = get_f64(p, "max_slippage_pct")?;
            let side     = get_str(p, "side")?.to_string();
            let slippage = check_slippage(expected, current, max_slip, &side)?;
            Ok(serde_json::json!({ "slippage_pct": slippage, "within_limit": true }))
        }
        "check_oracle_deviation" => {
            let cex    = get_f64(p, "cex_price")?;
            let oracle = get_f64(p, "oracle_price")?;
            let max_d  = get_f64(p, "max_dev_pct")?;
            let sym    = get_str(p, "symbol")?.to_string();
            let dev    = check_oracle_deviation(cex, oracle, max_d, &sym)?;
            Ok(serde_json::json!({ "deviation_pct": dev, "within_limit": true }))
        }
        "validate_funding_rate" => {
            let rate = get_f64(p, "rate_pct")?;
            let sym  = get_str(p, "symbol")?.to_string();
            validate_funding_rate(rate, &sym)?;
            Ok(serde_json::json!({ "valid": true }))
        }

        // ── Risk ──────────────────────────────────────────────────────────────
        "position_exit" => {
            let pos: PositionSnapshot = serde_json::from_value(
                p.get("position").cloned()
                    .ok_or_else(|| IndicatorError::InvalidInput { msg: "missing position param".into() })?
            ).map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?;
            let max_hold  = p.get("max_hold_ms").and_then(|v| v.as_u64());
            let trail     = get_f64_opt(p, "trail_stop_pct");
            let be_mult   = get_f64_opt(p, "break_even_atr_mult").unwrap_or(1.0);
            let atr_v     = get_f64_opt(p, "atr");
            Ok(serde_json::to_value(evaluate_position_exit(&pos, max_hold, trail, be_mult, atr_v)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "portfolio_risk" => {
            let positions_raw = p.get("positions").and_then(|v| v.as_array())
                .ok_or_else(|| IndicatorError::InvalidInput { msg: "missing positions array".into() })?;
            let mut positions: Vec<PositionSnapshot> = Vec::new();
            for v in positions_raw {
                let pos: PositionSnapshot = serde_json::from_value(v.clone())
                    .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?;
                positions.push(pos);
            }
            let peak       = get_f64(p, "peak_capital_usdt")?;
            let current    = get_f64(p, "current_capital_usdt")?;
            let daily_loss = get_f64(p, "daily_loss_usdt")?;
            let max_dd     = get_f64(p, "max_drawdown_pct")?;
            let daily_lim  = get_f64(p, "daily_loss_limit")?;
            let max_pos    = get_usize(p, "max_open_positions")?;
            let max_not    = get_f64(p, "max_notional_usdt")?;
            let breach     = evaluate_portfolio_risk(
                &positions, peak, current, daily_loss,
                max_dd, daily_lim, max_pos, max_not,
            )?;
            Ok(serde_json::to_value(breach)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "position_size" => {
            let capital   = get_f64(p, "capital_usdt")?;
            let entry     = get_f64(p, "entry_price")?;
            let sl        = get_f64(p, "stop_loss_price")?;
            let max_risk  = get_f64(p, "max_risk_pct")?;
            let max_pos   = get_f64(p, "max_position_pct")?;
            let win_rate  = get_f64_opt(p, "win_rate");
            let avg_win   = get_f64_opt(p, "avg_win");
            let avg_loss  = get_f64_opt(p, "avg_loss");
            let is_long   = get_bool(p, "is_long")?;
            Ok(serde_json::to_value(compute_position_size(
                capital, entry, sl, max_risk, max_pos,
                win_rate, avg_win, avg_loss, is_long,
            )?)
            .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "validate_rr" => {
            let entry   = get_f64(p, "entry")?;
            let sl      = get_f64(p, "stop_loss")?;
            let tp      = get_f64(p, "take_profit")?;
            let min_rr  = get_f64(p, "min_rr")?;
            let is_long = get_bool(p, "is_long")?;
            let rr      = validate_risk_reward(entry, sl, tp, min_rr, is_long)?;
            Ok(serde_json::json!({ "rr": rr, "valid": true }))
        }
        "drawdown" => {
            let equity = parse_closes(p, "equity")?;
            let limit  = get_f64(p, "drawdown_limit")?;
            Ok(serde_json::to_value(compute_drawdown(&equity, limit)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "performance_metrics" => {
            let pnl_series   = parse_closes(p, "pnl_series")?;
            let equity_curve = parse_closes(p, "equity_curve")?;
            let risk_free    = get_f64(p, "risk_free")?;
            let periods      = get_f64(p, "periods_per_year")?;
            Ok(serde_json::to_value(compute_performance_metrics(&pnl_series, &equity_curve, risk_free, periods)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "break_even_stop" => {
            let entry    = get_f64(p, "entry_price")?;
            let current  = get_f64(p, "current_price")?;
            let atr_v    = get_f64(p, "atr")?;
            let be_mult  = get_f64(p, "be_atr_mult")?;
            let fee      = get_f64(p, "fee_pct")?;
            let is_long  = get_bool(p, "is_long")?;
            Ok(serde_json::json!(compute_break_even_stop(entry, current, atr_v, be_mult, fee, is_long)?))
        }
        "daily_loss_breached" => {
            let pnl   = get_f64(p, "closed_pnl_today")?;
            let limit = get_f64(p, "daily_loss_limit")?;
            Ok(serde_json::json!(is_daily_loss_breached(pnl, limit)?))
        }
        "liquidation_price" => {
            let entry    = get_f64(p, "entry_price")?;
            let leverage = get_f64(p, "leverage")?;
            let mm_pct   = get_f64(p, "maintenance_margin_pct")?;
            let is_long  = get_bool(p, "is_long")?;
            Ok(serde_json::json!(liquidation_price(entry, leverage, mm_pct, is_long)?))
        }

        // ── Seasonal ──────────────────────────────────────────────────────────
        "seasonal_monthly" => {
            let candles = parse_candles(p, "candles")?;
            let pair    = get_str(p, "pair")?.to_string();
            let interval= get_str(p, "interval")?.to_string();
            let years   = p.get("years_in_sample").and_then(|v| v.as_u64()).unwrap_or(3) as u8;
            Ok(serde_json::to_value(compute_monthly_patterns(&candles, &pair, &interval, years)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "seasonal_dow" => {
            let candles = parse_candles(p, "candles")?;
            let pair    = get_str(p, "pair")?.to_string();
            let interval= get_str(p, "interval")?.to_string();
            let years   = p.get("years_in_sample").and_then(|v| v.as_u64()).unwrap_or(3) as u8;
            Ok(serde_json::to_value(compute_dow_patterns(&candles, &pair, &interval, years)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "seasonal_bias" => {
            let pair     = get_str(p, "pair")?.to_string();
            let monthly  = p.get("monthly").and_then(|v| {
                serde_json::from_value::<crate::types::SeasonalPattern>(v.clone()).ok()
            });
            let dow      = p.get("dow").and_then(|v| {
                serde_json::from_value::<crate::types::SeasonalPattern>(v.clone()).ok()
            });
            let path_sim  = get_f64_opt(p, "path_sim_score");
            let sim_year  = p.get("most_similar_year").and_then(|v| v.as_u64()).map(|y| y as u32);
            let min_conf  = get_f64_opt(p, "min_confidence").unwrap_or(0.3);
            Ok(serde_json::to_value(compute_seasonal_bias(
                &pair,
                monthly.as_ref(),
                dow.as_ref(),
                path_sim,
                sim_year,
                min_conf,
            )?)
            .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "find_similar_year" => {
            let current    = parse_closes(p, "current_prices")?;
            let years_raw  = p.get("prior_years").and_then(|v| v.as_array())
                .ok_or_else(|| IndicatorError::InvalidInput { msg: "missing prior_years array".into() })?;
            let mut prior_years: Vec<(u32, Vec<f64>)> = Vec::new();
            for yr in years_raw {
                let year   = yr.get("year").and_then(|v| v.as_u64())
                    .ok_or_else(|| IndicatorError::InvalidInput { msg: "prior year missing 'year' field".into() })? as u32;
                let prices = parse_closes(yr, "prices")?;
                prior_years.push((year, prices));
            }
            Ok(serde_json::to_value(find_most_similar_year(&current, &prior_years)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "accumulation_months" => {
            let patterns_raw = p.get("monthly_patterns").and_then(|v| v.as_array())
                .ok_or_else(|| IndicatorError::InvalidInput { msg: "missing monthly_patterns array".into() })?;
            let mut patterns: Vec<crate::types::SeasonalPattern> = Vec::new();
            for v in patterns_raw {
                let pat: crate::types::SeasonalPattern = serde_json::from_value(v.clone())
                    .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?;
                patterns.push(pat);
            }
            let min_next = get_f64(p, "min_next_return")?;
            Ok(serde_json::to_value(find_accumulation_months(&patterns, min_next))
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "spike_reversion" => {
            let spikes_raw = p.get("spikes").and_then(|v| v.as_array())
                .ok_or_else(|| IndicatorError::InvalidInput { msg: "missing spikes array".into() })?;
            let mut spikes: Vec<SpikeRecord> = Vec::new();
            for v in spikes_raw {
                let s: SpikeRecord = serde_json::from_value(v.clone())
                    .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?;
                spikes.push(s);
            }
            let direction = get_str(p, "direction")?.to_string();
            Ok(serde_json::to_value(compute_spike_reversion_stats(&spikes, &direction)?)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }
        "candle_returns" => {
            let candles = parse_candles(p, "candles")?;
            Ok(serde_json::json!(candle_returns(&candles)))
        }

        // ── Health / Stats ────────────────────────────────────────────────────
        "health" => {
            Ok(serde_json::json!({
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION"),
                "uptime_s": start.elapsed().as_secs(),
            }))
        }
        "stats" => {
            stats.uptime_s = start.elapsed().as_secs();
            Ok(serde_json::to_value(&*stats)
                .map_err(|e| IndicatorError::InvalidInput { msg: e.to_string() })?)
        }

        // Unreachable — allowlist check above catches unknown names
        other => Err(IndicatorError::InvalidInput { msg: format!("unhandled function '{other}'") }),
    }
}
