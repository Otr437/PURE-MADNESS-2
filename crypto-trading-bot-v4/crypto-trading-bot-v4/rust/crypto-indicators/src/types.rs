// src/types.rs
// Shared data types used across all modules.
// All types derive Serde for JSON bridge protocol.

use serde::{Deserialize, Serialize};
use thiserror::Error;

// ── CANDLE ────────────────────────────────────────────────────────────────────
/// OHLCV candle. All prices must be > 0. high >= low, high >= close, low <= close.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Candle {
    pub open:   f64,
    pub high:   f64,
    pub low:    f64,
    pub close:  f64,
    pub volume: f64,
    /// Unix ms timestamp — optional, used by seasonal engine
    #[serde(default)]
    pub time:   Option<u64>,
}

impl Candle {
    pub fn validate(&self, idx: usize) -> Result<(), IndicatorError> {
        if !self.open.is_finite()   || self.open   <= 0.0 { return Err(IndicatorError::InvalidCandle { idx, field: "open".into(),   value: self.open   }); }
        if !self.high.is_finite()   || self.high   <= 0.0 { return Err(IndicatorError::InvalidCandle { idx, field: "high".into(),   value: self.high   }); }
        if !self.low.is_finite()    || self.low    <= 0.0 { return Err(IndicatorError::InvalidCandle { idx, field: "low".into(),    value: self.low    }); }
        if !self.close.is_finite()  || self.close  <= 0.0 { return Err(IndicatorError::InvalidCandle { idx, field: "close".into(),  value: self.close  }); }
        if !self.volume.is_finite() || self.volume <  0.0 { return Err(IndicatorError::InvalidCandle { idx, field: "volume".into(), value: self.volume }); }
        if self.high < self.low   { return Err(IndicatorError::CandleIntegrity { idx, msg: format!("high({}) < low({})",   self.high, self.low)   }); }
        if self.high < self.close { return Err(IndicatorError::CandleIntegrity { idx, msg: format!("high({}) < close({})", self.high, self.close) }); }
        if self.low  > self.close { return Err(IndicatorError::CandleIntegrity { idx, msg: format!("low({})  > close({})", self.low,  self.close) }); }
        Ok(())
    }
}

// ── BOLLINGER BANDS RESULT ────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BollingerBands {
    pub upper:     f64,
    pub mid:       f64,
    pub lower:     f64,
    pub sigma:     f64,
    /// Where current price sits within bands: 0 = at lower, 1 = at upper
    pub bb_pct:    f64,
    /// Band width (upper - lower)
    pub width:     f64,
    /// Band width as % of mid — useful for squeeze detection
    pub width_pct: f64,
}

// ── MACD RESULT ───────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacdResult {
    pub macd_line:      f64,
    pub signal_line:    f64,
    pub histogram:      f64,
    pub prev_histogram: Option<f64>,
}

// ── STOCH RSI RESULT ──────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StochRsiResult {
    pub k: f64,
    pub d: f64,
}

// ── ADX RESULT ────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdxResult {
    pub adx:      f64,
    pub plus_di:  f64,
    pub minus_di: f64,
    pub trending: bool,  // adx > 25
    pub ranging:  bool,  // adx < 20
}

// ── ICHIMOKU RESULT ───────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IchimokuResult {
    pub tenkan_sen:   f64,
    pub kijun_sen:    f64,
    pub senkou_a:     f64,
    pub senkou_b:     f64,
    pub chikou_span:  f64,
    pub above_cloud:  bool,
    pub below_cloud:  bool,
}

// ── FIBONACCI RESULT ──────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FibonacciResult {
    pub level_0:    f64,
    pub level_236:  f64,
    pub level_382:  f64,
    pub level_500:  f64,
    pub level_618:  f64,
    pub level_786:  f64,
    pub level_1000: f64,
    pub ext_1272:   f64,
    pub ext_1618:   f64,
}

// ── PIVOT POINTS RESULT ───────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotPoints {
    pub pp: f64,
    pub r1: f64, pub r2: f64, pub r3: f64,
    pub s1: f64, pub s2: f64, pub s3: f64,
}

// ── VOLUME PROFILE BIN ────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeProfileBin {
    pub price_from: f64,
    pub price_to:   f64,
    pub volume:     f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumeProfileResult {
    pub profile: Vec<VolumeProfileBin>,
    pub poc:     VolumeProfileBin,   // point of control (highest volume bin)
    pub lo:      f64,
    pub hi:      f64,
}

// ── DONCHIAN CHANNEL RESULT ───────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DonchianChannel {
    pub upper: f64,
    pub lower: f64,
    pub mid:   f64,
}

// ── DIVERGENCE TYPE ───────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Divergence {
    Bullish,
    Bearish,
}

// ── MA CROSSOVER ─────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Crossover {
    Golden,
    Death,
}

// ── MA TYPE ───────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum MaType {
    Sma,
    Ema,
    Wsma,
}

// ── STRATEGY SIGNAL ───────────────────────────────────────────────────────────
/// Unified signal output — every strategy returns this.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    /// "LONG", "SHORT", or "NEUTRAL"
    pub direction:  String,
    /// 0.0–1.0 — how strongly the signal fires
    pub confidence: f64,
    /// Human-readable reason code
    pub reason:     String,
    /// Recommended stop-loss price (None if not applicable)
    pub stop_loss:  Option<f64>,
    /// Recommended take-profit price
    pub take_profit:Option<f64>,
    /// Position size as fraction of configured capital (Kelly adjusted)
    pub size_factor:f64,
    /// All indicator values that contributed to the signal
    pub indicators: serde_json::Value,
}

impl Default for Signal {
    fn default() -> Self {
        Signal {
            direction:  "NEUTRAL".into(),
            confidence: 0.0,
            reason:     "no_signal".into(),
            stop_loss:  None,
            take_profit:None,
            size_factor:0.0,
            indicators: serde_json::Value::Null,
        }
    }
}

// ── ERRORS ────────────────────────────────────────────────────────────────────
#[derive(Debug, Error)]
pub enum IndicatorError {
    #[error("Insufficient data: need {needed} values, got {got}")]
    InsufficientData { needed: usize, got: usize },

    #[error("Invalid period: {msg}")]
    InvalidPeriod { msg: String },

    #[error("Invalid candle at index {idx}: field '{field}' = {value}")]
    InvalidCandle { idx: usize, field: String, value: f64 },

    #[error("Candle integrity error at index {idx}: {msg}")]
    CandleIntegrity { idx: usize, msg: String },

    #[error("Non-finite value in input at position {pos}: {value}")]
    NonFiniteInput { pos: usize, value: f64 },

    #[error("Invalid input: {msg}")]
    InvalidInput { msg: String },

    #[error("Division by zero in {context}")]
    DivisionByZero { context: String },
}

pub type Result<T> = std::result::Result<T, IndicatorError>;

// ── BRIDGE PROTOCOL TYPES ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeRequest {
    /// Monotonically increasing request ID. Response echoes this for matching.
    pub id:      u64,
    /// Function name: "sma"|"ema"|"rsi"|"atr"|"macd"|"bollinger"|"zscore"|
    /// "vwap"|"adx"|"ichimoku"|"stoch_rsi"|"momentum"|"crossover"|
    /// "divergence"|"fibonacci"|"pivot"|"volume_profile"|"donchian"|
    /// "sharpe"|"max_drawdown"|"kelly"|"sortino"|"calmar"|
    /// "net_profit_pct"|"tri_cycle"|"grid_profit"|"grid_spec"|
    /// "funding_payment"|"funding_accum"|"atr_stops"|"scan_cross_arb"|
    /// "scan_tri_cycles"|"trend_signal"|"mean_reversion_signal"|
    /// "momentum_scalp_signal"|"dca_multiplier"|"path_similarity"|
    /// "validate_candles"|"normalize"|"correlation"|"dtw"|"wilder_sma"
    pub fn_name: String,
    /// All parameters packed as JSON — dispatcher parses per fn_name.
    pub params:  serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeResponse {
    /// Echoed from request for async matching on Node.js side.
    pub id:    u64,
    /// true = computation succeeded, false = error occurred.
    pub ok:    bool,
    /// Result data when ok = true. Shape depends on fn_name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data:  Option<serde_json::Value>,
    /// Error message when ok = false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Error category for the JS side to handle (validation|computation|internal).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    /// Microseconds taken to compute — used by bridge to decide fallback.
    pub elapsed_us: u64,
}

impl BridgeResponse {
    pub fn ok(id: u64, data: serde_json::Value, elapsed_us: u64) -> Self {
        BridgeResponse { id, ok: true, data: Some(data), error: None, error_kind: None, elapsed_us }
    }

    pub fn err(id: u64, msg: String, kind: &str, elapsed_us: u64) -> Self {
        BridgeResponse { id, ok: false, data: None, error: Some(msg), error_kind: Some(kind.into()), elapsed_us }
    }
}

// ── POSITION TYPES ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum PositionSide { Long, Short, Neutral }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum PositionStatus { Open, Closed, Liquidated }

/// Snapshot of an open position passed in from Node for risk evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionSnapshot {
    pub position_id:      String,
    pub pair:             String,
    pub side:             PositionSide,
    pub quantity:         f64,
    pub entry_price:      f64,
    pub current_price:    f64,
    pub stop_loss_price:  Option<f64>,
    pub take_profit_price:Option<f64>,
    pub opened_at_ms:     u64,
    pub unrealised_pnl:   f64,
    pub fee_paid:         f64,
}

impl PositionSnapshot {
    /// Validate all numeric fields are sane before running any computation.
    pub fn validate(&self) -> Result<(), IndicatorError> {
        if self.quantity <= 0.0 {
            return Err(IndicatorError::InvalidInput { msg: format!("position {}: quantity must be > 0", self.position_id) });
        }
        if self.entry_price <= 0.0 {
            return Err(IndicatorError::InvalidInput { msg: format!("position {}: entry_price must be > 0", self.position_id) });
        }
        if self.current_price <= 0.0 {
            return Err(IndicatorError::InvalidInput { msg: format!("position {}: current_price must be > 0", self.position_id) });
        }
        if let Some(sl) = self.stop_loss_price {
            if sl <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("position {}: stop_loss_price must be > 0", self.position_id) }); }
        }
        if let Some(tp) = self.take_profit_price {
            if tp <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("position {}: take_profit_price must be > 0", self.position_id) }); }
        }
        Ok(())
    }

    /// Return-on-position as percentage.
    pub fn return_pct(&self) -> f64 {
        match self.side {
            PositionSide::Long | PositionSide::Neutral =>
                (self.current_price - self.entry_price) / self.entry_price * 100.0,
            PositionSide::Short =>
                (self.entry_price - self.current_price) / self.entry_price * 100.0,
        }
    }

    /// Notional value at current price.
    pub fn notional(&self) -> f64 { self.current_price * self.quantity }

    /// Net PnL after fees.
    pub fn net_pnl(&self) -> f64 { self.unrealised_pnl - self.fee_paid }

    /// True if stop-loss has been breached at current price.
    pub fn stop_breached(&self) -> bool {
        match (&self.side, self.stop_loss_price) {
            (PositionSide::Long,  Some(sl)) => self.current_price <= sl,
            (PositionSide::Short, Some(sl)) => self.current_price >= sl,
            _ => false,
        }
    }

    /// True if take-profit has been reached at current price.
    pub fn tp_reached(&self) -> bool {
        match (&self.side, self.take_profit_price) {
            (PositionSide::Long,  Some(tp)) => self.current_price >= tp,
            (PositionSide::Short, Some(tp)) => self.current_price <= tp,
            _ => false,
        }
    }

    /// Milliseconds the position has been open.
    pub fn hold_ms(&self) -> u64 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        now.saturating_sub(self.opened_at_ms)
    }
}

// ── ORDER TYPES ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderSide { Buy, Sell }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrderType { Market, Limit, StopMarket, StopLimit, Oco, TrailingStop }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrderStatus { Pending, Open, Filled, Partial, Cancelled, Failed, Expired }

/// Proposed order parameters — validated by Rust before JS sends to exchange.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderProposal {
    pub pair:          String,
    pub side:          OrderSide,
    pub order_type:    OrderType,
    pub quantity:      Option<f64>,
    pub quote_qty:     Option<f64>,
    pub price:         Option<f64>,
    pub stop_price:    Option<f64>,
    pub min_notional:  f64,
}

impl OrderProposal {
    /// Full validation: at least one of quantity/quote_qty, price required for limit orders,
    /// min notional enforced, all values positive.
    pub fn validate(&self) -> Result<(), IndicatorError> {
        if self.pair.is_empty() || !self.pair.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '/') {
            return Err(IndicatorError::InvalidInput { msg: format!("OrderProposal: invalid pair '{}'", self.pair) });
        }
        if self.quantity.is_none() && self.quote_qty.is_none() {
            return Err(IndicatorError::InvalidInput { msg: "OrderProposal: quantity or quote_qty required".into() });
        }
        if let Some(q) = self.quantity {
            if q <= 0.0 || !q.is_finite() {
                return Err(IndicatorError::InvalidInput { msg: format!("OrderProposal: quantity must be > 0, got {q}") });
            }
        }
        if let Some(qq) = self.quote_qty {
            if qq <= 0.0 || !qq.is_finite() {
                return Err(IndicatorError::InvalidInput { msg: format!("OrderProposal: quote_qty must be > 0, got {qq}") });
            }
            if qq < self.min_notional {
                return Err(IndicatorError::InvalidInput { msg: format!("OrderProposal: quote_qty {qq} below min_notional {}", self.min_notional) });
            }
        }
        match self.order_type {
            OrderType::Limit | OrderType::StopLimit => {
                if self.price.map(|p| p <= 0.0).unwrap_or(true) {
                    return Err(IndicatorError::InvalidInput { msg: "OrderProposal: limit/stop-limit orders require a positive price".into() });
                }
            }
            OrderType::StopMarket => {
                if self.stop_price.map(|p| p <= 0.0).unwrap_or(true) {
                    return Err(IndicatorError::InvalidInput { msg: "OrderProposal: stop-market orders require a positive stop_price".into() });
                }
            }
            _ => {}
        }
        Ok(())
    }
}

// ── RISK MANAGEMENT TYPES ─────────────────────────────────────────────────────

/// Portfolio-level risk snapshot — used by risk_check() in base_bot equivalent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortfolioRisk {
    pub total_notional_usdt:  f64,
    pub total_unrealised_pnl: f64,
    pub total_fee_paid:       f64,
    pub drawdown_pct:         f64,
    pub open_position_count:  usize,
    pub daily_loss_usdt:      f64,
    pub peak_capital_usdt:    f64,
    pub current_capital_usdt: f64,
}

impl PortfolioRisk {
    /// Build from a slice of open positions plus capital figures.
    pub fn from_positions(
        positions:        &[PositionSnapshot],
        peak_capital:     f64,
        current_capital:  f64,
        daily_loss:       f64,
    ) -> Result<Self, IndicatorError> {
        if peak_capital < 0.0 {
            return Err(IndicatorError::InvalidInput { msg: format!("PortfolioRisk: peak_capital must be >= 0, got {peak_capital}") });
        }
        for p in positions { p.validate()?; }

        let total_notional: f64 = positions.iter().map(|p| p.notional()).sum();
        let total_upnl:     f64 = positions.iter().map(|p| p.unrealised_pnl).sum();
        let total_fees:     f64 = positions.iter().map(|p| p.fee_paid).sum();
        let drawdown = if peak_capital > 0.0 {
            ((peak_capital - current_capital) / peak_capital * 100.0).max(0.0)
        } else { 0.0 };

        Ok(PortfolioRisk {
            total_notional_usdt:  total_notional,
            total_unrealised_pnl: total_upnl,
            total_fee_paid:       total_fees,
            drawdown_pct:         drawdown,
            open_position_count:  positions.len(),
            daily_loss_usdt:      daily_loss,
            peak_capital_usdt:    peak_capital,
            current_capital_usdt: current_capital,
        })
    }

    /// Check whether any risk limit is breached. Returns the first breach found.
    pub fn check_limits(
        &self,
        max_drawdown_pct:    f64,
        daily_loss_limit:    f64,
        max_open_positions:  usize,
        max_notional_usdt:   f64,
    ) -> Option<RiskBreach> {
        if self.drawdown_pct >= max_drawdown_pct {
            return Some(RiskBreach { kind: "max_drawdown".into(), value: self.drawdown_pct, limit: max_drawdown_pct });
        }
        if daily_loss_limit > 0.0 && self.daily_loss_usdt >= daily_loss_limit {
            return Some(RiskBreach { kind: "daily_loss".into(), value: self.daily_loss_usdt, limit: daily_loss_limit });
        }
        if max_open_positions > 0 && self.open_position_count >= max_open_positions {
            return Some(RiskBreach { kind: "max_positions".into(), value: self.open_position_count as f64, limit: max_open_positions as f64 });
        }
        if max_notional_usdt > 0.0 && self.total_notional_usdt >= max_notional_usdt {
            return Some(RiskBreach { kind: "max_notional".into(), value: self.total_notional_usdt, limit: max_notional_usdt });
        }
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskBreach {
    pub kind:  String,
    pub value: f64,
    pub limit: f64,
}

// ── SEASONAL PATTERN TYPES ────────────────────────────────────────────────────

/// A single seasonal pattern row — mirrors the DB table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeasonalPattern {
    pub pair:               String,
    pub interval:           String,
    pub month:              Option<u8>,
    pub week_of_year:       Option<u8>,
    pub day_of_week:        Option<u8>,
    pub hour_of_day:        Option<u8>,
    pub years_in_sample:    u8,
    pub sample_count:       u32,
    pub avg_return_pct:     f64,
    pub median_return_pct:  f64,
    pub std_return_pct:     f64,
    pub min_return_pct:     f64,
    pub max_return_pct:     f64,
    pub win_rate_pct:       f64,
    pub t_stat:             Option<f64>,
    pub p_value:            Option<f64>,
    pub signal_strength:    f64,
    pub bullish_bias:       bool,
    pub bearish_bias:       bool,
    pub avg_volume_ratio:   Option<f64>,
    pub spike_frequency_pct:Option<f64>,
}

impl SeasonalPattern {
    /// Validate all percentage fields are within reasonable bounds.
    pub fn validate(&self) -> Result<(), IndicatorError> {
        if !(0.0..=100.0).contains(&self.win_rate_pct) {
            return Err(IndicatorError::InvalidInput { msg: format!("SeasonalPattern: win_rate_pct {} out of 0-100 range", self.win_rate_pct) });
        }
        if !(0.0..=1.0).contains(&self.signal_strength) {
            return Err(IndicatorError::InvalidInput { msg: format!("SeasonalPattern: signal_strength {} out of 0-1 range", self.signal_strength) });
        }
        if self.sample_count == 0 {
            return Err(IndicatorError::InvalidInput { msg: "SeasonalPattern: sample_count must be > 0".into() });
        }
        if self.years_in_sample == 0 {
            return Err(IndicatorError::InvalidInput { msg: "SeasonalPattern: years_in_sample must be > 0".into() });
        }
        Ok(())
    }

    /// Compute composite signal score combining win rate bias, signal strength, and p-value.
    /// Returns (score: -1.0 to 1.0, direction: "bullish"|"bearish"|"neutral", confidence: 0.0-1.0)
    pub fn composite_signal(&self) -> (f64, &'static str, f64) {
        let win_bias = (self.win_rate_pct - 50.0) / 50.0;  // -1 to +1
        let ret_bias = (self.avg_return_pct / 10.0).clamp(-1.0, 1.0);
        let p_factor = if let Some(p) = self.p_value { (1.0 - p.min(1.0)).max(0.0) } else { 0.5 };

        let score = (win_bias * 0.35 + ret_bias * 0.40 + p_factor * 0.25)
            .clamp(-1.0, 1.0);

        let direction = if score > 0.15 { "bullish" } else if score < -0.15 { "bearish" } else { "neutral" };
        let confidence = score.abs();

        (score, direction, confidence)
    }
}

/// Composite seasonal bias combining monthly + DOW + path similarity signals.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeasonalBias {
    pub pair:           String,
    pub score:          f64,   // -1.0 to 1.0
    pub direction:      String, // "bullish" | "bearish" | "neutral"
    pub confidence:     f64,   // 0.0 to 1.0
    pub monthly_score:  Option<f64>,
    pub dow_score:      Option<f64>,
    pub path_sim_score: Option<f64>,
    pub most_similar_year: Option<u32>,
}

// ── INDICATOR COMPUTATION STATS ───────────────────────────────────────────────
// Tracks how many calls went to Rust vs JS fallback. Used by bridge health check.

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BridgeStats {
    pub rust_calls:      u64,
    pub rust_errors:     u64,
    pub fallback_calls:  u64,
    pub avg_latency_us:  f64,
    pub max_latency_us:  u64,
    pub uptime_s:        u64,
}

impl BridgeStats {
    pub fn record_call(&mut self, elapsed_us: u64, errored: bool) {
        self.rust_calls += 1;
        if errored { self.rust_errors += 1; }
        let n = self.rust_calls as f64;
        self.avg_latency_us = self.avg_latency_us * (n - 1.0) / n + elapsed_us as f64 / n;
        if elapsed_us > self.max_latency_us { self.max_latency_us = elapsed_us; }
    }
}

// ── CANDLE FEED VALIDATION REPORT ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationReport {
    pub candle_count:          usize,
    pub valid:                 bool,
    pub errors:                Vec<String>,
    pub warnings:              Vec<String>,
    pub duplicate_timestamps:  Vec<u64>,
    pub anomalous_volume_idx:  Vec<usize>,
    pub ohlc_integrity_errors: Vec<usize>,
}

impl ValidationReport {
    pub fn new() -> Self {
        ValidationReport {
            candle_count:          0,
            valid:                 true,
            errors:                Vec::new(),
            warnings:              Vec::new(),
            duplicate_timestamps:  Vec::new(),
            anomalous_volume_idx:  Vec::new(),
            ohlc_integrity_errors: Vec::new(),
        }
    }

    pub fn add_error(&mut self, msg: String) {
        self.valid = false;
        self.errors.push(msg);
    }

    pub fn add_warning(&mut self, msg: String) {
        self.warnings.push(msg);
    }
}

impl Default for ValidationReport {
    fn default() -> Self { Self::new() }
}
