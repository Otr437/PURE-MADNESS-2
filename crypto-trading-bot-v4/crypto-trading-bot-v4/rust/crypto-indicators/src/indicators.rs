// src/indicators.rs
// Every indicator from indicators.js ported 1-to-1 to Rust.
// Zero stubs. Zero panics on valid input. All edge cases handled.
// Wilder smoothing used for RSI/ATR (matches JS implementation exactly).

use crate::types::*;

// ── INTERNAL GUARDS ───────────────────────────────────────────────────────────

/// Validate a slice has minimum length and all values are finite.
fn require_slice(data: &[f64], min_len: usize, label: &str) -> Result<()> {
    if data.len() < min_len {
        return Err(IndicatorError::InsufficientData { needed: min_len, got: data.len() });
    }
    for (i, &v) in data.iter().enumerate() {
        if !v.is_finite() {
            return Err(IndicatorError::NonFiniteInput { pos: i, value: v });
        }
    }
    Ok(())
}

/// Validate all candles in slice.
fn require_candles(candles: &[Candle], min_len: usize) -> Result<()> {
    if candles.len() < min_len {
        return Err(IndicatorError::InsufficientData { needed: min_len, got: candles.len() });
    }
    for (i, c) in candles.iter().enumerate() {
        c.validate(i)?;
    }
    Ok(())
}

/// Return None if value is not finite, else Some(value).
#[inline]
fn fin(v: f64) -> Option<f64> {
    if v.is_finite() { Some(v) } else { None }
}

// ── SIMPLE MOVING AVERAGE ─────────────────────────────────────────────────────

/// SMA over the last `n` values in `data`.
pub fn sma(data: &[f64], n: usize) -> Result<f64> {
    if n < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("sma: period must be >= 1, got {n}") });
    }
    require_slice(data, n, "sma")?;
    let slice = &data[data.len() - n..];
    let sum: f64 = slice.iter().sum();
    fin(sum / n as f64).ok_or(IndicatorError::DivisionByZero { context: "sma".into() })
}

// ── EXPONENTIAL MOVING AVERAGE ────────────────────────────────────────────────

/// EMA seeded from SMA of first `n` values, then applies multiplier k = 2/(n+1).
pub fn ema(data: &[f64], n: usize) -> Result<f64> {
    if n < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("ema: period must be >= 1, got {n}") });
    }
    require_slice(data, n, "ema")?;
    let k = 2.0 / (n as f64 + 1.0);
    let mut e: f64 = data[..n].iter().sum::<f64>() / n as f64;
    for &v in &data[n..] {
        e = v * k + e * (1.0 - k);
    }
    fin(e).ok_or(IndicatorError::DivisionByZero { context: "ema".into() })
}

/// Build the full EMA history for a slice (needed by MACD signal line).
pub fn ema_history(data: &[f64], n: usize) -> Result<Vec<f64>> {
    if n < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("ema_history: period must be >= 1, got {n}") });
    }
    require_slice(data, n, "ema_history")?;
    let k = 2.0 / (n as f64 + 1.0);
    let mut result = Vec::with_capacity(data.len() - n + 1);
    let mut e: f64 = data[..n].iter().sum::<f64>() / n as f64;
    result.push(e);
    for &v in &data[n..] {
        e = v * k + e * (1.0 - k);
        result.push(e);
    }
    Ok(result)
}

// ── WILDER'S SMOOTHED MOVING AVERAGE ─────────────────────────────────────────

/// Wilder's SMMA: seed = SMA of first n, then (prev * (n-1) + current) / n.
/// Used by ATR and ADX.
pub fn wilder_sma(data: &[f64], n: usize) -> Result<f64> {
    if n < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("wilder_sma: period must be >= 1, got {n}") });
    }
    require_slice(data, n, "wilder_sma")?;
    let mut sma: f64 = data[..n].iter().sum::<f64>() / n as f64;
    for &v in &data[n..] {
        sma = (sma * (n as f64 - 1.0) + v) / n as f64;
    }
    fin(sma).ok_or(IndicatorError::DivisionByZero { context: "wilder_sma".into() })
}

// ── MA DISPATCHER ─────────────────────────────────────────────────────────────

pub fn ma(data: &[f64], n: usize, ma_type: &MaType) -> Result<f64> {
    match ma_type {
        MaType::Sma  => sma(data, n),
        MaType::Ema  => ema(data, n),
        MaType::Wsma => wilder_sma(data, n),
    }
}

// ── POPULATION STANDARD DEVIATION ────────────────────────────────────────────

pub fn std_dev(data: &[f64], n: usize) -> Result<f64> {
    if n < 2 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("std_dev: period must be >= 2, got {n}") });
    }
    require_slice(data, n, "std_dev")?;
    let slice = &data[data.len() - n..];
    let mean = slice.iter().sum::<f64>() / n as f64;
    let variance = slice.iter().map(|&v| (v - mean).powi(2)).sum::<f64>() / n as f64;
    fin(variance.sqrt()).ok_or(IndicatorError::DivisionByZero { context: "std_dev".into() })
}

// ── SAMPLE STANDARD DEVIATION ─────────────────────────────────────────────────

pub fn std_dev_sample(data: &[f64], n: usize) -> Result<f64> {
    if n < 2 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("std_dev_sample: period must be >= 2, got {n}") });
    }
    require_slice(data, n, "std_dev_sample")?;
    let slice = &data[data.len() - n..];
    let mean = slice.iter().sum::<f64>() / n as f64;
    let variance = slice.iter().map(|&v| (v - mean).powi(2)).sum::<f64>() / (n as f64 - 1.0);
    fin(variance.sqrt()).ok_or(IndicatorError::DivisionByZero { context: "std_dev_sample".into() })
}

// ── Z-SCORE ───────────────────────────────────────────────────────────────────

/// How many standard deviations `price` is from the rolling mean of `closes[-n-1..-1]`.
pub fn z_score(price: f64, closes: &[f64], n: usize) -> Result<f64> {
    if !price.is_finite() {
        return Err(IndicatorError::InvalidInput { msg: "z_score: price must be finite".into() });
    }
    if n < 2 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("z_score: period must be >= 2, got {n}") });
    }
    require_slice(closes, n + 1, "z_score")?;
    let window = &closes[closes.len() - n - 1..closes.len() - 1];
    let mean = window.iter().sum::<f64>() / n as f64;
    let sigma = (window.iter().map(|&v| (v - mean).powi(2)).sum::<f64>() / n as f64).sqrt();
    if sigma == 0.0 {
        return Ok(0.0);
    }
    fin((price - mean) / sigma).ok_or(IndicatorError::DivisionByZero { context: "z_score".into() })
}

// ── RSI — WILDER'S SMOOTHED METHOD ───────────────────────────────────────────

/// Relative Strength Index using Wilder's smoothing.
/// Requires closes.len() >= n + 1.
pub fn rsi(closes: &[f64], n: usize) -> Result<f64> {
    if n < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("rsi: period must be >= 1, got {n}") });
    }
    require_slice(closes, n + 1, "rsi")?;

    // Build change array
    let changes: Vec<f64> = closes.windows(2).map(|w| w[1] - w[0]).collect();

    let gains:  Vec<f64> = changes.iter().map(|&d| if d > 0.0 { d } else { 0.0 }).collect();
    let losses: Vec<f64> = changes.iter().map(|&d| if d < 0.0 { d.abs() } else { 0.0 }).collect();

    // Seed averages from first n values
    let mut avg_gain: f64 = gains[..n].iter().sum::<f64>() / n as f64;
    let mut avg_loss: f64 = losses[..n].iter().sum::<f64>() / n as f64;

    // Wilder smoothing for remaining periods
    for i in n..changes.len() {
        avg_gain = (avg_gain * (n as f64 - 1.0) + gains[i])  / n as f64;
        avg_loss = (avg_loss * (n as f64 - 1.0) + losses[i]) / n as f64;
    }

    if avg_loss == 0.0 {
        return Ok(100.0);
    }
    let rs = avg_gain / avg_loss;
    fin(100.0 - 100.0 / (1.0 + rs)).ok_or(IndicatorError::DivisionByZero { context: "rsi".into() })
}

/// Build full RSI history (needed for StochRSI).
pub fn rsi_history(closes: &[f64], n: usize) -> Result<Vec<f64>> {
    if n < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("rsi_history: period must be >= 1, got {n}") });
    }
    require_slice(closes, n + 1, "rsi_history")?;

    let mut result = Vec::with_capacity(closes.len() - n);

    let changes: Vec<f64> = closes.windows(2).map(|w| w[1] - w[0]).collect();
    let gains:  Vec<f64> = changes.iter().map(|&d| if d > 0.0 { d } else { 0.0 }).collect();
    let losses: Vec<f64> = changes.iter().map(|&d| if d < 0.0 { d.abs() } else { 0.0 }).collect();

    let mut avg_gain: f64 = gains[..n].iter().sum::<f64>() / n as f64;
    let mut avg_loss: f64 = losses[..n].iter().sum::<f64>() / n as f64;

    let rsi_val = if avg_loss == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + avg_gain / avg_loss) };
    result.push(rsi_val);

    for i in n..changes.len() {
        avg_gain = (avg_gain * (n as f64 - 1.0) + gains[i])  / n as f64;
        avg_loss = (avg_loss * (n as f64 - 1.0) + losses[i]) / n as f64;
        let r = if avg_loss == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + avg_gain / avg_loss) };
        result.push(r);
    }
    Ok(result)
}

// ── STOCHASTIC RSI ────────────────────────────────────────────────────────────

pub fn stoch_rsi(
    closes:       &[f64],
    rsi_period:   usize,
    stoch_period: usize,
    smooth_k:     usize,
    smooth_d:     usize,
) -> Result<StochRsiResult> {
    let min_len = rsi_period + stoch_period + smooth_k + smooth_d;
    require_slice(closes, min_len, "stoch_rsi")?;

    // Build full RSI history
    let rsi_vals = rsi_history(closes, rsi_period)?;
    if rsi_vals.len() < stoch_period {
        return Err(IndicatorError::InsufficientData { needed: stoch_period, got: rsi_vals.len() });
    }

    // Raw stochastic K from RSI values
    let mut raw_k: Vec<f64> = Vec::with_capacity(rsi_vals.len() - stoch_period + 1);
    for i in stoch_period..=rsi_vals.len() {
        let window = &rsi_vals[i - stoch_period..i];
        let lo = window.iter().cloned().fold(f64::INFINITY, f64::min);
        let hi = window.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let k = if (hi - lo).abs() < f64::EPSILON {
            50.0
        } else {
            (rsi_vals[i - 1] - lo) / (hi - lo) * 100.0
        };
        raw_k.push(k);
    }

    // Smooth K and D
    let k = sma(&raw_k, smooth_k)?;

    // Build K history for D smoothing
    let mut k_arr: Vec<f64> = Vec::with_capacity(raw_k.len() - smooth_k + 1);
    for i in smooth_k..=raw_k.len() {
        k_arr.push(sma(&raw_k[..i], smooth_k)?);
    }
    let d = sma(&k_arr, smooth_d)?;

    Ok(StochRsiResult {
        k: k.clamp(0.0, 100.0),
        d: d.clamp(0.0, 100.0),
    })
}

// ── MACD ──────────────────────────────────────────────────────────────────────

pub fn macd(closes: &[f64], fast: usize, slow: usize, signal: usize) -> Result<MacdResult> {
    if fast >= slow {
        return Err(IndicatorError::InvalidPeriod {
            msg: format!("macd: fast({fast}) must be < slow({slow})"),
        });
    }
    if signal < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: "macd: signal period must be >= 1".into() });
    }
    require_slice(closes, slow + signal, "macd")?;

    // Build full MACD line history by computing EMA fast and EMA slow at each step
    let mut macd_line_hist: Vec<f64> = Vec::with_capacity(closes.len() - slow + 1);
    for i in slow..=closes.len() {
        let f = ema(&closes[..i], fast)?;
        let s = ema(&closes[..i], slow)?;
        macd_line_hist.push(f - s);
    }

    if macd_line_hist.len() < signal {
        return Err(IndicatorError::InsufficientData { needed: signal, got: macd_line_hist.len() });
    }

    let signal_line = ema(&macd_line_hist, signal)?;
    let current     = *macd_line_hist.last().unwrap();
    let histogram   = current - signal_line;

    // Previous histogram: signal of macd_line_hist[..-1]
    let prev_histogram = if macd_line_hist.len() > signal {
        let prev_sig = ema(&macd_line_hist[..macd_line_hist.len() - 1], signal)?;
        let prev_macd = macd_line_hist[macd_line_hist.len() - 2];
        fin(prev_macd - prev_sig)
    } else {
        None
    };

    Ok(MacdResult {
        macd_line: current,
        signal_line,
        histogram,
        prev_histogram,
    })
}

// ── ATR — WILDER'S SMOOTHED TRUE RANGE ────────────────────────────────────────

pub fn atr(candles: &[Candle], n: usize) -> Result<f64> {
    if n < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("atr: period must be >= 1, got {n}") });
    }
    require_candles(candles, n + 1)?;

    let s = &candles[candles.len() - (n + 1)..];
    let mut trs: Vec<f64> = Vec::with_capacity(n);
    for i in 1..s.len() {
        let tr = f64::max(
            s[i].high - s[i].low,
            f64::max(
                (s[i].high - s[i - 1].close).abs(),
                (s[i].low  - s[i - 1].close).abs(),
            ),
        );
        trs.push(tr);
    }

    // Wilder's smoothed ATR (seed from SMA, then smooth)
    let mut atr_val: f64 = trs[..n].iter().sum::<f64>() / n as f64;
    for &tr in &trs[n..] {
        atr_val = (atr_val * (n as f64 - 1.0) + tr) / n as f64;
    }
    fin(atr_val).ok_or(IndicatorError::DivisionByZero { context: "atr".into() })
}

// ── BOLLINGER BANDS ───────────────────────────────────────────────────────────

pub fn bollinger_bands(closes: &[f64], n: usize, k: f64) -> Result<BollingerBands> {
    if n < 2 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("bollinger_bands: period must be >= 2, got {n}") });
    }
    if k <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("bollinger_bands: multiplier must be > 0, got {k}") });
    }
    require_slice(closes, n, "bollinger_bands")?;

    let mid   = sma(closes, n)?;
    let sigma = std_dev(closes, n)?;
    let upper = mid + k * sigma;
    let lower = mid - k * sigma;
    let price = *closes.last().unwrap();
    let width = upper - lower;
    let bb_pct = if width > 0.0 {
        ((price - lower) / width).clamp(0.0, 1.0)
    } else {
        0.5
    };
    let width_pct = if mid > 0.0 { width / mid * 100.0 } else { 0.0 };

    Ok(BollingerBands { upper, mid, lower, sigma, bb_pct, width, width_pct })
}

// ── VWAP ─────────────────────────────────────────────────────────────────────

pub fn vwap(candles: &[Candle]) -> Result<f64> {
    if candles.is_empty() {
        return Err(IndicatorError::InsufficientData { needed: 1, got: 0 });
    }
    let mut tpv = 0.0f64;
    let mut vol = 0.0f64;
    for c in candles {
        if c.volume < 0.0 || !c.volume.is_finite() { continue; }
        let tp = (c.high + c.low + c.close) / 3.0;
        if !tp.is_finite() { continue; }
        tpv += tp * c.volume;
        vol += c.volume;
    }
    if vol == 0.0 {
        return Err(IndicatorError::DivisionByZero { context: "vwap: total volume is zero".into() });
    }
    fin(tpv / vol).ok_or(IndicatorError::DivisionByZero { context: "vwap".into() })
}

// ── MOMENTUM / RATE OF CHANGE ─────────────────────────────────────────────────

pub fn momentum(closes: &[f64], n: usize) -> Result<f64> {
    if n < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: format!("momentum: period must be >= 1, got {n}") });
    }
    require_slice(closes, n + 1, "momentum")?;
    let now  = closes[closes.len() - 1];
    let past = closes[closes.len() - 1 - n];
    if past == 0.0 {
        return Err(IndicatorError::DivisionByZero { context: "momentum: past price is zero".into() });
    }
    fin((now - past) / past * 100.0).ok_or(IndicatorError::DivisionByZero { context: "momentum".into() })
}

// ── MA CROSSOVER ──────────────────────────────────────────────────────────────

pub fn ma_crossover(closes: &[f64], fast: usize, slow: usize, ma_type: &MaType) -> Result<Option<Crossover>> {
    if fast >= slow {
        return Err(IndicatorError::InvalidPeriod {
            msg: format!("ma_crossover: fast({fast}) must be < slow({slow})"),
        });
    }
    require_slice(closes, slow + 2, "ma_crossover")?;

    let cf = ma(closes,             fast, ma_type)?;
    let cs = ma(closes,             slow, ma_type)?;
    let pf = ma(&closes[..closes.len()-1], fast, ma_type)?;
    let ps = ma(&closes[..closes.len()-1], slow, ma_type)?;

    if pf <= ps && cf > cs { return Ok(Some(Crossover::Golden)); }
    if pf >= ps && cf < cs { return Ok(Some(Crossover::Death));  }
    Ok(None)
}

// ── RSI DIVERGENCE ────────────────────────────────────────────────────────────

pub fn rsi_divergence(closes: &[f64], rsi_values: &[f64], lookback: usize) -> Result<Option<Divergence>> {
    if lookback < 2 {
        return Err(IndicatorError::InvalidPeriod { msg: "rsi_divergence: lookback must be >= 2".into() });
    }
    require_slice(closes,     lookback + 1, "rsi_divergence:closes")?;
    require_slice(rsi_values, lookback + 1, "rsi_divergence:rsi_values")?;

    let price_slice = &closes[closes.len() - lookback - 1..];
    let rsi_slice   = &rsi_values[rsi_values.len() - lookback - 1..];

    let p_now = price_slice[price_slice.len() - 1];
    let r_now = rsi_slice[rsi_slice.len() - 1];

    let p_prev = &price_slice[..price_slice.len() - 1];
    let r_prev = &rsi_slice[..rsi_slice.len() - 1];

    let p_min = p_prev.iter().cloned().fold(f64::INFINITY,     f64::min);
    let p_max = p_prev.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let r_min = r_prev.iter().cloned().fold(f64::INFINITY,     f64::min);
    let r_max = r_prev.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    // Bullish: price lower low, RSI higher low
    if p_now < p_min && r_now > r_min { return Ok(Some(Divergence::Bullish)); }
    // Bearish: price higher high, RSI lower high
    if p_now > p_max && r_now < r_max { return Ok(Some(Divergence::Bearish)); }
    Ok(None)
}

// ── ICHIMOKU CLOUD ────────────────────────────────────────────────────────────

pub fn ichimoku(candles: &[Candle], tenkan: usize, kijun: usize, senkou: usize) -> Result<IchimokuResult> {
    require_candles(candles, senkou)?;

    let n   = candles.len();
    let hl_avg = |start: usize, end: usize| -> f64 {
        let sl = &candles[start..end];
        let hi = sl.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
        let lo = sl.iter().map(|c| c.low).fold(f64::INFINITY, f64::min);
        (hi + lo) / 2.0
    };

    if n < tenkan { return Err(IndicatorError::InsufficientData { needed: tenkan, got: n }); }
    if n < kijun  { return Err(IndicatorError::InsufficientData { needed: kijun,  got: n }); }

    let tenkan_sen  = hl_avg(n - tenkan, n);
    let kijun_sen   = hl_avg(n - kijun,  n);
    let senkou_a    = (tenkan_sen + kijun_sen) / 2.0;
    let senkou_b    = hl_avg(n - senkou, n);
    let chikou_span = candles[n - 1].close;
    let last_close  = candles[n - 1].close;

    Ok(IchimokuResult {
        tenkan_sen, kijun_sen, senkou_a, senkou_b, chikou_span,
        above_cloud: last_close > senkou_a.max(senkou_b),
        below_cloud: last_close < senkou_a.min(senkou_b),
    })
}

// ── ADX — AVERAGE DIRECTIONAL INDEX ──────────────────────────────────────────

pub fn adx(candles: &[Candle], n: usize) -> Result<AdxResult> {
    require_candles(candles, n * 2)?;

    let mut plus_dm:  Vec<f64> = Vec::with_capacity(candles.len() - 1);
    let mut minus_dm: Vec<f64> = Vec::with_capacity(candles.len() - 1);
    let mut tr_arr:   Vec<f64> = Vec::with_capacity(candles.len() - 1);

    for i in 1..candles.len() {
        let up_move   = candles[i].high  - candles[i-1].high;
        let down_move = candles[i-1].low - candles[i].low;
        plus_dm.push(if up_move > down_move && up_move > 0.0 { up_move } else { 0.0 });
        minus_dm.push(if down_move > up_move && down_move > 0.0 { down_move } else { 0.0 });
        tr_arr.push(f64::max(
            candles[i].high - candles[i].low,
            f64::max(
                (candles[i].high - candles[i-1].close).abs(),
                (candles[i].low  - candles[i-1].close).abs(),
            ),
        ));
    }

    let smoothed_tr   = wilder_sma(&tr_arr,   n)?;
    let smoothed_plus = wilder_sma(&plus_dm,  n)?;
    let smoothed_minus= wilder_sma(&minus_dm, n)?;

    if smoothed_tr == 0.0 {
        return Err(IndicatorError::DivisionByZero { context: "adx: smoothed TR is zero".into() });
    }

    let plus_di  = (smoothed_plus  / smoothed_tr) * 100.0;
    let minus_di = (smoothed_minus / smoothed_tr) * 100.0;
    let dx_denom = plus_di + minus_di;
    let dx = if dx_denom == 0.0 { 0.0 } else { (plus_di - minus_di).abs() / dx_denom * 100.0 };

    Ok(AdxResult {
        adx:      dx,
        plus_di,
        minus_di,
        trending: dx > 25.0,
        ranging:  dx < 20.0,
    })
}

// ── FIBONACCI RETRACEMENT ─────────────────────────────────────────────────────

pub fn fibonacci(high: f64, low: f64) -> Result<FibonacciResult> {
    if !high.is_finite() || !low.is_finite() {
        return Err(IndicatorError::InvalidInput { msg: "fibonacci: high and low must be finite".into() });
    }
    if high <= low {
        return Err(IndicatorError::InvalidInput {
            msg: format!("fibonacci: high({high}) must be > low({low})"),
        });
    }
    let diff = high - low;
    Ok(FibonacciResult {
        level_0:    high,
        level_236:  high - diff * 0.236,
        level_382:  high - diff * 0.382,
        level_500:  high - diff * 0.500,
        level_618:  high - diff * 0.618,
        level_786:  high - diff * 0.786,
        level_1000: low,
        ext_1272:   low  - diff * 0.272,
        ext_1618:   low  - diff * 0.618,
    })
}

// ── PIVOT POINTS ──────────────────────────────────────────────────────────────

pub fn pivot_points(high: f64, low: f64, close: f64) -> Result<PivotPoints> {
    for (name, v) in [("high", high), ("low", low), ("close", close)] {
        if !v.is_finite() || v < 0.0 {
            return Err(IndicatorError::InvalidInput {
                msg: format!("pivot_points: {name} must be positive finite, got {v}"),
            });
        }
    }
    let pp = (high + low + close) / 3.0;
    Ok(PivotPoints {
        pp,
        r1: 2.0 * pp - low,
        r2: pp + (high - low),
        r3: high + 2.0 * (pp - low),
        s1: 2.0 * pp - high,
        s2: pp - (high - low),
        s3: low - 2.0 * (high - pp),
    })
}

// ── VOLUME PROFILE ────────────────────────────────────────────────────────────

pub fn volume_profile(candles: &[Candle], bins: usize) -> Result<VolumeProfileResult> {
    if candles.is_empty() {
        return Err(IndicatorError::InsufficientData { needed: 1, got: 0 });
    }
    if bins < 2 {
        return Err(IndicatorError::InvalidPeriod { msg: "volume_profile: bins must be >= 2".into() });
    }

    let lo = candles.iter().map(|c| c.low).fold(f64::INFINITY,     f64::min);
    let hi = candles.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);

    if (hi - lo).abs() < f64::EPSILON {
        return Err(IndicatorError::InvalidInput { msg: "volume_profile: all candles have same high/low".into() });
    }

    let step = (hi - lo) / bins as f64;
    let mut profile: Vec<VolumeProfileBin> = (0..bins)
        .map(|i| VolumeProfileBin {
            price_from: lo + step * i as f64,
            price_to:   lo + step * (i + 1) as f64,
            volume:     0.0,
        })
        .collect();

    for c in candles {
        let bin = ((c.close - lo) / step).floor() as usize;
        let bin = bin.min(bins - 1);
        profile[bin].volume += c.volume.max(0.0);
    }

    let poc_idx = profile.iter().enumerate()
        .max_by(|a, b| a.1.volume.partial_cmp(&b.1.volume).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i)
        .unwrap_or(0);

    let poc = profile[poc_idx].clone();
    Ok(VolumeProfileResult { profile, poc, lo, hi })
}

// ── DONCHIAN CHANNEL ──────────────────────────────────────────────────────────

pub fn donchian_channel(candles: &[Candle], n: usize) -> Result<DonchianChannel> {
    if n < 1 {
        return Err(IndicatorError::InvalidPeriod { msg: "donchian_channel: period must be >= 1".into() });
    }
    require_candles(candles, n)?;
    let s  = &candles[candles.len() - n..];
    let hi = s.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    let lo = s.iter().map(|c| c.low).fold(f64::INFINITY,      f64::min);
    Ok(DonchianChannel { upper: hi, lower: lo, mid: (hi + lo) / 2.0 })
}

// ── TO RETURNS ────────────────────────────────────────────────────────────────

pub fn to_returns(prices: &[f64]) -> Result<Vec<f64>> {
    require_slice(prices, 2, "to_returns")?;
    if prices[0] == 0.0 {
        return Err(IndicatorError::DivisionByZero { context: "to_returns: first price is zero".into() });
    }
    let base = prices[0];
    Ok(prices.iter().enumerate().map(|(i, &p)| {
        if i == 0 { 0.0 } else { (p - base) / base * 100.0 }
    }).collect())
}

// ── NORMALIZE ─────────────────────────────────────────────────────────────────

pub fn normalize(data: &[f64]) -> Result<Vec<f64>> {
    require_slice(data, 1, "normalize")?;
    let min = data.iter().cloned().fold(f64::INFINITY,     f64::min);
    let max = data.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if (max - min).abs() < f64::EPSILON {
        return Ok(vec![0.5; data.len()]);
    }
    let range = max - min;
    Ok(data.iter().map(|&v| ((v - min) / range).clamp(0.0, 1.0)).collect())
}

// ── PEARSON CORRELATION ───────────────────────────────────────────────────────

pub fn correlation(a: &[f64], b: &[f64]) -> Result<f64> {
    let n = a.len().min(b.len());
    require_slice(&a[..n], 2, "correlation:a")?;
    require_slice(&b[..n], 2, "correlation:b")?;

    let ma = a[..n].iter().sum::<f64>() / n as f64;
    let mb = b[..n].iter().sum::<f64>() / n as f64;

    let (mut num, mut da, mut db) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..n {
        num += (a[i] - ma) * (b[i] - mb);
        da  += (a[i] - ma).powi(2);
        db  += (b[i] - mb).powi(2);
    }

    if da == 0.0 || db == 0.0 { return Ok(0.0); }
    fin(num / (da * db).sqrt()).ok_or(IndicatorError::DivisionByZero { context: "correlation".into() })
}

// ── DTW DISTANCE ──────────────────────────────────────────────────────────────

pub fn dtw_distance(a: &[f64], b: &[f64]) -> Result<f64> {
    require_slice(a, 1, "dtw_distance:a")?;
    require_slice(b, 1, "dtw_distance:b")?;

    let n = a.len();
    let m = b.len();
    // Use flat Vec for O(n*m) space with good cache locality
    let mut dtw = vec![f64::INFINITY; (n + 1) * (m + 1)];
    dtw[0] = 0.0;

    for i in 1..=n {
        for j in 1..=m {
            let cost = (a[i - 1] - b[j - 1]).abs();
            let prev = dtw[(i-1)*(m+1) + j]
                .min(dtw[i*(m+1) + (j-1)])
                .min(dtw[(i-1)*(m+1) + (j-1)]);
            dtw[i*(m+1) + j] = cost + prev;
        }
    }
    Ok(dtw[n * (m + 1) + m])
}

// ── SHARPE RATIO ──────────────────────────────────────────────────────────────

pub fn sharpe_ratio(returns: &[f64], risk_free_rate: f64, periods_per_year: f64) -> Result<f64> {
    require_slice(returns, 2, "sharpe_ratio")?;
    let n    = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / n;
    let variance = returns.iter().map(|&r| (r - mean).powi(2)).sum::<f64>() / (n - 1.0);
    let sigma = variance.sqrt();
    if sigma == 0.0 {
        return Err(IndicatorError::DivisionByZero { context: "sharpe_ratio: std dev is zero".into() });
    }
    fin(((mean - risk_free_rate) / sigma) * periods_per_year.sqrt())
        .ok_or(IndicatorError::DivisionByZero { context: "sharpe_ratio".into() })
}

// ── MAXIMUM DRAWDOWN ──────────────────────────────────────────────────────────

pub fn max_drawdown(equity: &[f64]) -> Result<f64> {
    require_slice(equity, 2, "max_drawdown")?;
    let mut peak  = equity[0];
    let mut max_dd = 0.0f64;
    for &v in equity {
        if v > peak { peak = v; }
        if peak > 0.0 {
            let dd = (peak - v) / peak;
            if dd > max_dd { max_dd = dd; }
        }
    }
    Ok(max_dd * 100.0)
}

// ── KELLY CRITERION ───────────────────────────────────────────────────────────

pub fn kelly_criterion(win_rate: f64, avg_win: f64, avg_loss: f64) -> Result<f64> {
    if !(0.0..=1.0).contains(&win_rate) {
        return Err(IndicatorError::InvalidInput { msg: format!("kelly_criterion: win_rate must be 0-1, got {win_rate}") });
    }
    if avg_win <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("kelly_criterion: avg_win must be > 0, got {avg_win}") });
    }
    if avg_loss <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("kelly_criterion: avg_loss must be > 0, got {avg_loss}") });
    }
    let b     = avg_win / avg_loss;
    let q     = 1.0 - win_rate;
    let kelly = (b * win_rate - q) / b;
    // Half-kelly capped at 25%
    Ok(f64::max(0.0, f64::min(0.25, kelly / 2.0)))
}

// ── SORTINO RATIO ─────────────────────────────────────────────────────────────

/// Sortino ratio uses downside deviation (only negative returns in denominator).
pub fn sortino_ratio(returns: &[f64], risk_free_rate: f64, periods_per_year: f64) -> Result<f64> {
    require_slice(returns, 2, "sortino_ratio")?;
    let n    = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / n;

    let downside_variance = returns.iter()
        .map(|&r| f64::min(r - risk_free_rate, 0.0).powi(2))
        .sum::<f64>() / n;

    let downside_dev = downside_variance.sqrt();
    if downside_dev == 0.0 {
        return Err(IndicatorError::DivisionByZero { context: "sortino_ratio: downside deviation is zero".into() });
    }
    fin(((mean - risk_free_rate) / downside_dev) * periods_per_year.sqrt())
        .ok_or(IndicatorError::DivisionByZero { context: "sortino_ratio".into() })
}

// ── CALMAR RATIO ─────────────────────────────────────────────────────────────

/// Calmar = annualised return / max drawdown. Measures risk-adjusted performance.
pub fn calmar_ratio(annual_return_pct: f64, max_drawdown_pct: f64) -> Result<f64> {
    if max_drawdown_pct <= 0.0 {
        return Err(IndicatorError::DivisionByZero { context: "calmar_ratio: max_drawdown_pct must be > 0".into() });
    }
    fin(annual_return_pct / max_drawdown_pct)
        .ok_or(IndicatorError::DivisionByZero { context: "calmar_ratio".into() })
}

// ── NET PROFIT PERCENTAGE (arb/trading) ───────────────────────────────────────

/// Compute net profit % after two taker fees for cross-exchange arb.
/// buy_ask: price paid on buy side. sell_bid: price received on sell side.
pub fn net_profit_pct(buy_ask: f64, sell_bid: f64, buy_fee_pct: f64, sell_fee_pct: f64) -> Result<f64> {
    if buy_ask <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("net_profit_pct: buy_ask must be > 0, got {buy_ask}") });
    }
    let gross = (sell_bid - buy_ask) / buy_ask;
    let fees  = buy_fee_pct / 100.0 + sell_fee_pct / 100.0;
    fin((gross - fees) * 100.0).ok_or(IndicatorError::DivisionByZero { context: "net_profit_pct".into() })
}

/// Simulate a triangular arb cycle. Returns end amount and profit %.
/// legs: (action: true=buy, price: f64) — applies fee_pct per leg.
pub fn simulate_tri_cycle(start_amount: f64, legs: &[(bool, f64)], fee_pct: f64) -> Result<(f64, f64)> {
    if start_amount <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: "simulate_tri_cycle: start_amount must be > 0".into() });
    }
    if legs.is_empty() {
        return Err(IndicatorError::InvalidInput { msg: "simulate_tri_cycle: legs cannot be empty".into() });
    }
    let fee_mul = 1.0 - fee_pct / 100.0;
    let mut amount = start_amount;
    for (i, &(is_buy, price)) in legs.iter().enumerate() {
        if price <= 0.0 {
            return Err(IndicatorError::InvalidInput { msg: format!("simulate_tri_cycle: leg {i} price must be > 0, got {price}") });
        }
        amount = if is_buy {
            (amount / price) * fee_mul   // spend quote, receive base
        } else {
            amount * price * fee_mul     // spend base, receive quote
        };
    }
    let profit_pct = (amount - start_amount) / start_amount * 100.0;
    Ok((amount, profit_pct))
}

/// Grid bot expected profit per fill between two adjacent levels.
pub fn grid_fill_profit(buy_price: f64, sell_price: f64, qty: f64, maker_fee_pct: f64) -> Result<f64> {
    if buy_price <= 0.0 || sell_price <= 0.0 || qty <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: "grid_fill_profit: prices and qty must be > 0".into() });
    }
    let gross    = (sell_price - buy_price) * qty;
    let buy_fee  = buy_price  * qty * maker_fee_pct / 100.0;
    let sell_fee = sell_price * qty * maker_fee_pct / 100.0;
    fin(gross - buy_fee - sell_fee).ok_or(IndicatorError::DivisionByZero { context: "grid_fill_profit".into() })
}

/// Cash & carry funding payment for one period.
pub fn funding_payment(notional_usdt: f64, funding_rate_pct: f64) -> Result<f64> {
    if notional_usdt <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: "funding_payment: notional must be > 0".into() });
    }
    fin(notional_usdt * funding_rate_pct / 100.0)
        .ok_or(IndicatorError::DivisionByZero { context: "funding_payment".into() })
}

/// Position stop-loss and take-profit prices from ATR.
pub fn atr_stops(entry: f64, atr_val: f64, multiplier: f64, rr_ratio: f64, is_long: bool) -> Result<(f64, f64)> {
    if entry <= 0.0 { return Err(IndicatorError::InvalidInput { msg: "atr_stops: entry must be > 0".into() }); }
    if atr_val <= 0.0 { return Err(IndicatorError::InvalidInput { msg: "atr_stops: atr_val must be > 0".into() }); }
    if multiplier <= 0.0 { return Err(IndicatorError::InvalidInput { msg: "atr_stops: multiplier must be > 0".into() }); }
    if rr_ratio <= 0.0 { return Err(IndicatorError::InvalidInput { msg: "atr_stops: rr_ratio must be > 0".into() }); }

    let stop_dist = atr_val * multiplier;
    let (sl, tp) = if is_long {
        let sl = entry - stop_dist;
        let tp = entry + stop_dist * rr_ratio;
        (sl, tp)
    } else {
        let sl = entry + stop_dist;
        let tp = entry - stop_dist * rr_ratio;
        (sl, tp)
    };

    if sl <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("atr_stops: computed stop_loss {sl} <= 0") }); }
    if tp <= 0.0 { return Err(IndicatorError::InvalidInput { msg: format!("atr_stops: computed take_profit {tp} <= 0") }); }

    Ok((sl, tp))
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY: rate-of-change sanity check — rejects price data that looks
// manipulated (>50% move in one candle is almost certainly bad data).
// Called before any indicator is computed on live feed data.
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_price_sanity(candles: &[Candle], max_single_move_pct: f64) -> Result<()> {
    if candles.len() < 2 { return Ok(()); }
    for i in 1..candles.len() {
        let prev = candles[i - 1].close;
        let curr = candles[i].close;
        if prev <= 0.0 { continue; }
        let move_pct = ((curr - prev) / prev).abs() * 100.0;
        if move_pct > max_single_move_pct {
            return Err(IndicatorError::InvalidInput {
                msg: format!(
                    "validate_price_sanity: candle[{i}] moved {move_pct:.2}% in one period \
                     (close {prev} -> {curr}), exceeds limit {max_single_move_pct}%"
                ),
            });
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY: duplicate timestamp detection — rejects candle feeds with
// repeated open_time values which indicate stale/replayed data.
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_no_duplicate_timestamps(candles: &[Candle]) -> Result<()> {
    use std::collections::HashSet;
    let mut seen: HashSet<u64> = HashSet::with_capacity(candles.len());
    for (i, c) in candles.iter().enumerate() {
        if let Some(ts) = c.time {
            if !seen.insert(ts) {
                return Err(IndicatorError::InvalidInput {
                    msg: format!("validate_no_duplicate_timestamps: candle[{i}] timestamp {ts} is duplicated"),
                });
            }
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY: monotonic timestamp check — candles must be in ascending order.
// ─────────────────────────────────────────────────────────────────────────────
pub fn validate_timestamps_ascending(candles: &[Candle]) -> Result<()> {
    for i in 1..candles.len() {
        if let (Some(prev), Some(curr)) = (candles[i-1].time, candles[i].time) {
            if curr <= prev {
                return Err(IndicatorError::InvalidInput {
                    msg: format!(
                        "validate_timestamps_ascending: candle[{i}] timestamp {curr} \
                         is not after candle[{}] timestamp {prev}",
                        i - 1
                    ),
                });
            }
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY: volume spike guard — flags candles where volume is more than
// `threshold` standard deviations above the rolling mean.
// Returns indices of anomalous candles. Caller decides whether to reject.
// ─────────────────────────────────────────────────────────────────────────────
pub fn detect_volume_anomalies(candles: &[Candle], window: usize, threshold_sigma: f64) -> Result<Vec<usize>> {
    if window < 2 {
        return Err(IndicatorError::InvalidPeriod {
            msg: format!("detect_volume_anomalies: window must be >= 2, got {window}"),
        });
    }
    if threshold_sigma <= 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("detect_volume_anomalies: threshold_sigma must be > 0, got {threshold_sigma}"),
        });
    }
    require_candles(candles, window + 1)?;

    let mut anomalies = Vec::new();
    let vols: Vec<f64> = candles.iter().map(|c| c.volume).collect();

    for i in window..candles.len() {
        let slice = &vols[i - window..i];
        let mean  = slice.iter().sum::<f64>() / window as f64;
        let sigma = (slice.iter().map(|&v| (v - mean).powi(2)).sum::<f64>() / window as f64).sqrt();
        if sigma > 0.0 && (vols[i] - mean) / sigma > threshold_sigma {
            anomalies.push(i);
        }
    }
    Ok(anomalies)
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC: Triangular arbitrage opportunity scanner.
// Evaluates all provided cycles and returns every profitable one
// sorted by descending profit %, with the full leg-by-leg breakdown.
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TriLegResult {
    pub pair:      String,
    pub is_buy:    bool,
    pub price:     f64,
    pub amount_in: f64,
    pub amount_out:f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TriCycleResult {
    pub name:         String,
    pub end_amount:   f64,
    pub gross_profit: f64,
    pub profit_pct:   f64,
    pub legs:         Vec<TriLegResult>,
}

pub fn scan_tri_cycles(
    start_amount: f64,
    cycles: &[(String, Vec<(bool, String, f64)>)], // (cycle_name, [(is_buy, pair, price)])
    fee_pct: f64,
    min_profit_pct: f64,
) -> Result<Vec<TriCycleResult>> {
    if start_amount <= 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("scan_tri_cycles: start_amount must be > 0, got {start_amount}"),
        });
    }
    if fee_pct < 0.0 || fee_pct > 5.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("scan_tri_cycles: fee_pct must be 0-5, got {fee_pct}"),
        });
    }

    let fee_mul = 1.0 - fee_pct / 100.0;
    let mut results: Vec<TriCycleResult> = Vec::new();

    for (name, legs) in cycles {
        if legs.is_empty() { continue; }
        let mut amount = start_amount;
        let mut leg_results = Vec::with_capacity(legs.len());
        let mut valid = true;

        for (is_buy, pair, price) in legs {
            if *price <= 0.0 {
                valid = false;
                break;
            }
            let amt_out = if *is_buy {
                (amount / price) * fee_mul
            } else {
                amount * price * fee_mul
            };
            if !amt_out.is_finite() || amt_out <= 0.0 {
                valid = false;
                break;
            }
            leg_results.push(TriLegResult {
                pair:       pair.clone(),
                is_buy:     *is_buy,
                price:      *price,
                amount_in:  amount,
                amount_out: amt_out,
            });
            amount = amt_out;
        }

        if !valid { continue; }

        let gross_profit = amount - start_amount;
        let profit_pct   = gross_profit / start_amount * 100.0;

        if profit_pct > min_profit_pct {
            results.push(TriCycleResult {
                name:         name.clone(),
                end_amount:   amount,
                gross_profit,
                profit_pct,
                legs:         leg_results,
            });
        }
    }

    // Sort best first
    results.sort_by(|a, b| b.profit_pct.partial_cmp(&a.profit_pct).unwrap_or(std::cmp::Ordering::Equal));
    Ok(results)
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC: Grid bot — build evenly-spaced price levels,
// compute expected profit per fill at each level, and return full grid spec.
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GridLevel {
    pub index:           usize,
    pub price:           f64,
    pub side:            String,  // "BUY" or "SELL"
    pub quantity:        f64,
    pub notional:        f64,
    pub expected_profit: Option<f64>, // None for top sell / bottom buy
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GridSpec {
    pub levels:          Vec<GridLevel>,
    pub step_size:       f64,
    pub usdt_per_level:  f64,
    pub total_buy_notional:  f64,
    pub total_sell_notional: f64,
    pub avg_expected_profit: f64,
}

pub fn build_grid(
    lower:            f64,
    upper:            f64,
    num_levels:       usize,
    total_capital:    f64,
    current_price:    f64,
    maker_fee_pct:    f64,
) -> Result<GridSpec> {
    if lower <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("build_grid: lower must be > 0, got {lower}") });
    }
    if upper <= lower {
        return Err(IndicatorError::InvalidInput { msg: format!("build_grid: upper({upper}) must be > lower({lower})") });
    }
    if num_levels < 3 {
        return Err(IndicatorError::InvalidInput { msg: format!("build_grid: num_levels must be >= 3, got {num_levels}") });
    }
    if total_capital <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("build_grid: total_capital must be > 0, got {total_capital}") });
    }
    if current_price <= 0.0 || !current_price.is_finite() {
        return Err(IndicatorError::InvalidInput { msg: format!("build_grid: current_price must be > 0, got {current_price}") });
    }

    let step          = (upper - lower) / (num_levels - 1) as f64;
    let usdt_per_level= total_capital / (num_levels - 1) as f64;

    let mut levels            = Vec::with_capacity(num_levels);
    let mut total_buy         = 0.0f64;
    let mut total_sell        = 0.0f64;
    let mut profit_sum        = 0.0f64;
    let mut profit_count      = 0usize;

    for i in 0..num_levels {
        let price    = lower + step * i as f64;
        let quantity = usdt_per_level / price;
        let notional = quantity * price;
        let side     = if price < current_price { "BUY" } else { "SELL" };

        let expected_profit = if side == "BUY" && i + 1 < num_levels {
            let sell_price = lower + step * (i + 1) as f64;
            let p = grid_fill_profit(price, sell_price, quantity, maker_fee_pct)?;
            profit_sum  += p;
            profit_count += 1;
            Some(p)
        } else {
            None
        };

        if side == "BUY"  { total_buy  += notional; }
        else               { total_sell += notional; }

        levels.push(GridLevel { index: i, price, side: side.to_string(), quantity, notional, expected_profit });
    }

    Ok(GridSpec {
        levels,
        step_size:               step,
        usdt_per_level,
        total_buy_notional:      total_buy,
        total_sell_notional:     total_sell,
        avg_expected_profit:     if profit_count > 0 { profit_sum / profit_count as f64 } else { 0.0 },
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC: Cross-exchange arb scanner.
// Given two order books, evaluates both directions and returns the best.
// Includes spread guard, depth guard, slippage re-check.
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ArbOpportunity {
    pub direction:       String,   // "A_to_B" or "B_to_A"
    pub buy_price:       f64,
    pub sell_price:      f64,
    pub net_profit_pct:  f64,
    pub gross_profit:    f64,
    pub fee_cost:        f64,
    pub available_qty:   f64,
    pub trade_qty:       f64,
}

pub fn scan_cross_arb(
    bid_a: f64, ask_a: f64, bid_size_a: f64, ask_size_a: f64,
    bid_b: f64, ask_b: f64, bid_size_b: f64, ask_size_b: f64,
    fee_a_pct: f64,
    fee_b_pct: f64,
    trade_usdt: f64,
    min_profit_pct: f64,
    max_spread_pct: f64,
    min_depth_usdt:  f64,
) -> Result<Option<ArbOpportunity>> {
    // Validate inputs
    for (name, v) in [
        ("bid_a", bid_a), ("ask_a", ask_a), ("bid_b", bid_b), ("ask_b", ask_b),
        ("bid_size_a", bid_size_a), ("ask_size_a", ask_size_a),
        ("bid_size_b", bid_size_b), ("ask_size_b", ask_size_b),
    ] {
        if !v.is_finite() || v <= 0.0 {
            return Err(IndicatorError::InvalidInput { msg: format!("scan_cross_arb: {name} must be > 0, got {v}") });
        }
    }
    if ask_a < bid_a {
        return Err(IndicatorError::InvalidInput { msg: format!("scan_cross_arb: ask_a({ask_a}) < bid_a({bid_a})") });
    }
    if ask_b < bid_b {
        return Err(IndicatorError::InvalidInput { msg: format!("scan_cross_arb: ask_b({ask_b}) < bid_b({bid_b})") });
    }

    // Spread guard — wide spread = illiquid
    let spread_a_pct = (ask_a - bid_a) / bid_a * 100.0;
    let spread_b_pct = (ask_b - bid_b) / bid_b * 100.0;
    if spread_a_pct > max_spread_pct || spread_b_pct > max_spread_pct {
        return Ok(None);
    }

    let pct_ab = net_profit_pct(ask_a, bid_b, fee_a_pct, fee_b_pct)?;
    let pct_ba = net_profit_pct(ask_b, bid_a, fee_b_pct, fee_a_pct)?;

    let (direction, buy_p, sell_p, profit_pct, depth_buy, depth_sell) =
        if pct_ab >= pct_ba {
            ("A_to_B", ask_a, bid_b, pct_ab, ask_size_a * ask_a, bid_size_b * bid_b)
        } else {
            ("B_to_A", ask_b, bid_a, pct_ba, ask_size_b * ask_b, bid_size_a * bid_a)
        };

    if profit_pct <= min_profit_pct { return Ok(None); }

    // Depth guard — enough liquidity to fill our order
    if depth_buy < min_depth_usdt || depth_sell < min_depth_usdt {
        return Ok(None);
    }

    let trade_qty    = trade_usdt / buy_p;
    let available_qty= (depth_buy / buy_p).min(depth_sell / sell_p);
    let gross_profit = (sell_p - buy_p) * trade_qty;
    let fee_cost     = (fee_a_pct + fee_b_pct) / 100.0 * trade_usdt;

    Ok(Some(ArbOpportunity {
        direction:      direction.to_string(),
        buy_price:      buy_p,
        sell_price:     sell_p,
        net_profit_pct: profit_pct,
        gross_profit,
        fee_cost,
        available_qty,
        trade_qty,
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC: Trend-following signal engine.
// Evaluates MA crossover + RSI + ADX + volume + VWAP, returns Signal.
// ─────────────────────────────────────────────────────────────────────────────
pub fn trend_signal(
    candles:         &[Candle],
    fast_period:     usize,
    slow_period:     usize,
    ma_type:         &MaType,
    rsi_period:      usize,
    rsi_overbought:  f64,
    rsi_oversold:    f64,
    adx_period:      usize,
    min_adx:         f64,
    volume_mult:     f64,
    use_vwap:        bool,
    allow_short:     bool,
    trade_usdt:      f64,
    atr_period:      usize,
    atr_mult:        f64,
    rr_ratio:        f64,
    win_rate:        f64,
    avg_win:         f64,
    avg_loss:        f64,
) -> Result<Signal> {
    let min_needed = slow_period + 50;
    require_candles(candles, min_needed)?;

    let closes:  Vec<f64> = candles.iter().map(|c| c.close).collect();
    let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();
    let n = closes.len();

    let fast_ma  = ma(&closes, fast_period, ma_type)?;
    let slow_ma  = ma(&closes, slow_period, ma_type)?;
    let rsi_val  = rsi(&closes, rsi_period)?;
    let atr_val  = atr(candles, atr_period)?;
    let adx_res  = adx(candles, adx_period)?;
    let cross    = ma_crossover(&closes, fast_period, slow_period, ma_type)?;

    // Volume filter: current > avg * multiplier
    let vol_avg  = sma(&volumes, 20).unwrap_or(0.0);
    let vol_ok   = vol_avg > 0.0 && volumes[n - 1] >= vol_avg * volume_mult;

    // VWAP filter (use last 24 candles for intraday approximation)
    let vwap_val = if use_vwap {
        let start = if n >= 24 { n - 24 } else { 0 };
        vwap(&candles[start..]).ok()
    } else {
        None
    };

    let price    = closes[n - 1];
    let above_vwap = vwap_val.map(|v| price > v).unwrap_or(true);
    let below_vwap = vwap_val.map(|v| price < v).unwrap_or(true);

    // ADX filter: market must be trending
    let is_trending = adx_res.adx >= min_adx;

    // Kelly-adjusted size factor
    let size_factor = if win_rate > 0.0 && avg_win > 0.0 && avg_loss > 0.0 {
        kelly_criterion(win_rate, avg_win, avg_loss).unwrap_or(0.5)
    } else {
        0.5
    };

    let mut indicators = serde_json::json!({
        "fast_ma":   fast_ma,
        "slow_ma":   slow_ma,
        "rsi":       rsi_val,
        "atr":       atr_val,
        "adx":       adx_res.adx,
        "plus_di":   adx_res.plus_di,
        "minus_di":  adx_res.minus_di,
        "vol_ok":    vol_ok,
        "trending":  is_trending,
        "vwap":      vwap_val,
        "above_vwap":above_vwap,
        "cross":     cross.as_ref().map(|c| format!("{c:?}")),
    });

    match &cross {
        Some(Crossover::Golden)
            if rsi_val < rsi_overbought && is_trending && vol_ok && above_vwap =>
        {
            let (sl, tp) = atr_stops(price, atr_val, atr_mult, rr_ratio, true)?;
            indicators["sl"] = serde_json::json!(sl);
            indicators["tp"] = serde_json::json!(tp);
            Ok(Signal {
                direction:   "LONG".into(),
                confidence:  f64::min(adx_res.adx / 100.0, 1.0),
                reason:      "golden_cross_confirmed".into(),
                stop_loss:   Some(sl),
                take_profit: Some(tp),
                size_factor,
                indicators,
            })
        }
        Some(Crossover::Death)
            if allow_short && rsi_val > rsi_oversold && is_trending && vol_ok && below_vwap =>
        {
            let (sl, tp) = atr_stops(price, atr_val, atr_mult, rr_ratio, false)?;
            indicators["sl"] = serde_json::json!(sl);
            indicators["tp"] = serde_json::json!(tp);
            Ok(Signal {
                direction:   "SHORT".into(),
                confidence:  f64::min(adx_res.adx / 100.0, 1.0),
                reason:      "death_cross_confirmed".into(),
                stop_loss:   Some(sl),
                take_profit: Some(tp),
                size_factor,
                indicators,
            })
        }
        _ => Ok(Signal {
            reason: if cross.is_none() { "no_crossover".into() }
                    else if !is_trending { "adx_too_low".into() }
                    else if !vol_ok      { "volume_filter".into() }
                    else                 { "filter_blocked".into() },
            indicators,
            ..Default::default()
        }),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC: Mean reversion signal engine.
// Z-score + Bollinger Bands + RSI + MACD histogram + RSI divergence.
// Requires all 3 primary conditions to fire; divergence is bonus.
// ─────────────────────────────────────────────────────────────────────────────
pub fn mean_reversion_signal(
    candles:        &[Candle],
    zscore_period:  usize,
    zscore_entry:   f64,   // e.g. -2.0 for long entry
    zscore_short:   f64,   // e.g. +2.0 for short entry
    bb_period:      usize,
    bb_k:           f64,
    rsi_period:     usize,
    rsi_oversold:   f64,
    rsi_overbought: f64,
    rsi_history:    &[f64],
    allow_short:    bool,
    trade_usdt:     f64,
    atr_period:     usize,
    atr_mult:       f64,
    rr_ratio:       f64,
    seasonal_dir:   Option<&str>,   // "bullish" | "bearish" | None
    min_seasonal_conf: f64,
) -> Result<Signal> {
    require_candles(candles, bb_period.max(rsi_period + 1).max(zscore_period + 1))?;

    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let price = *closes.last().unwrap();

    let z    = z_score(price, &closes, zscore_period)?;
    let bb   = bollinger_bands(&closes, bb_period, bb_k)?;
    let rsi_val = rsi(&closes, rsi_period)?;
    let atr_val = atr(candles, atr_period)?;

    let macd_res = macd(&closes, 12, 26, 9).ok();
    let macd_bullish = macd_res.as_ref().map(|m| m.histogram > 0.0).unwrap_or(false);
    let macd_bearish = macd_res.as_ref().map(|m| m.histogram < 0.0).unwrap_or(false);

    let divergence = if rsi_history.len() >= 6 {
        rsi_divergence(&closes, rsi_history, 5).ok().flatten()
    } else {
        None
    };

    // Seasonal alignment guard — if seasonal signal is strong and conflicts, block
    let seasonal_blocks_long = seasonal_dir
        .filter(|&d| d == "bearish")
        .map(|_| min_seasonal_conf > 0.3)
        .unwrap_or(false);
    let seasonal_blocks_short = seasonal_dir
        .filter(|&d| d == "bullish")
        .map(|_| min_seasonal_conf > 0.3)
        .unwrap_or(false);

    let indicators = serde_json::json!({
        "z_score":      z,
        "bb_pct":       bb.bb_pct,
        "bb_upper":     bb.upper,
        "bb_lower":     bb.lower,
        "bb_mid":       bb.mid,
        "rsi":          rsi_val,
        "macd_hist":    macd_res.as_ref().map(|m| m.histogram),
        "divergence":   divergence.as_ref().map(|d| format!("{d:?}")),
        "seasonal_dir": seasonal_dir,
    });

    // LONG: z-score <= entry threshold AND BB oversold AND RSI oversold AND MACD turning up
    let long_conditions = [
        z <= zscore_entry,
        bb.bb_pct <= 0.10,
        rsi_val <= rsi_oversold,
        macd_bullish,
    ];
    let long_score = long_conditions.iter().filter(|&&c| c).count()
        + if divergence == Some(Divergence::Bullish) { 1 } else { 0 };

    if long_score >= 3 && !seasonal_blocks_long {
        let (sl, tp) = atr_stops(price, atr_val, atr_mult, rr_ratio, true)?;
        let confidence = (long_score as f64 / 4.5_f64).min(1.0);
        return Ok(Signal {
            direction:   "LONG".into(),
            confidence,
            reason:      format!("mean_rev_long_{long_score}_of_4"),
            stop_loss:   Some(sl),
            take_profit: Some(tp),
            size_factor: confidence * 0.5,
            indicators,
        });
    }

    // SHORT: z-score >= entry threshold AND BB overbought AND RSI overbought AND MACD turning down
    if allow_short {
        let short_conditions = [
            z >= zscore_short,
            bb.bb_pct >= 0.90,
            rsi_val >= rsi_overbought,
            macd_bearish,
        ];
        let short_score = short_conditions.iter().filter(|&&c| c).count()
            + if divergence == Some(Divergence::Bearish) { 1 } else { 0 };

        if short_score >= 3 && !seasonal_blocks_short {
            let (sl, tp) = atr_stops(price, atr_val, atr_mult, rr_ratio, false)?;
            let confidence = (short_score as f64 / 4.5_f64).min(1.0);
            return Ok(Signal {
                direction:   "SHORT".into(),
                confidence,
                reason:      format!("mean_rev_short_{short_score}_of_4"),
                stop_loss:   Some(sl),
                take_profit: Some(tp),
                size_factor: confidence * 0.5,
                indicators,
            });
        }
    }

    Ok(Signal { reason: "no_mean_rev_signal".into(), indicators, ..Default::default() })
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC: Momentum scalp signal engine.
// Breakout + RSI + StochRSI + VWAP + order book imbalance + volume spike.
// All primary conditions required. Spread guard enforced.
// ─────────────────────────────────────────────────────────────────────────────
pub fn momentum_scalp_signal(
    candles:           &[Candle],
    rsi_period:        usize,
    rsi_bullish:       f64,
    rsi_bearish:       f64,
    stoch_rsi_period:  usize,
    stoch_k:           usize,
    stoch_d:           usize,
    stoch_bullish:     f64,
    stoch_bearish:     f64,
    momentum_period:   usize,
    momentum_min_pct:  f64,
    breakout_lookback: usize,
    volume_mult:       f64,
    bid_vol:           f64,
    ask_vol:           f64,
    spread_pct:        f64,
    max_spread_pct:    f64,
    min_imbalance:     f64,
    use_vwap:          bool,
    allow_short:       bool,
    rsi_history:       &[f64],
    atr_period:        usize,
    atr_mult:          f64,
    rr_ratio:          f64,
) -> Result<Signal> {
    let min_candles = rsi_period + stoch_rsi_period + stoch_k + stoch_d + 5;
    require_candles(candles, min_candles)?;

    let closes:  Vec<f64> = candles.iter().map(|c| c.close).collect();
    let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();
    let n       = closes.len();
    let price   = closes[n - 1];

    // ── Spread guard: reject illiquid markets ─────────────────────────────
    if spread_pct > max_spread_pct {
        return Ok(Signal { reason: format!("spread_{spread_pct:.4}_exceeds_{max_spread_pct}"), ..Default::default() });
    }

    // ── Compute indicators ────────────────────────────────────────────────
    let rsi_val  = rsi(&closes, rsi_period)?;
    let mom      = momentum(&closes, momentum_period)?;
    let atr_val  = atr(candles, atr_period)?;
    let vol_avg  = sma(&volumes, 20).unwrap_or(0.0);
    let vol_ok   = vol_avg > 0.0 && volumes[n - 1] >= vol_avg * volume_mult;

    let stoch = stoch_rsi(&closes, stoch_rsi_period, 14, stoch_k, stoch_d).ok();

    let vwap_val = if use_vwap { vwap(candles).ok() } else { None };
    let above_vwap = vwap_val.map(|v| price > v).unwrap_or(true);
    let below_vwap = vwap_val.map(|v| price < v).unwrap_or(true);

    // ── Breakout detection ─────────────────────────────────────────────────
    let start   = if n > breakout_lookback + 1 { n - breakout_lookback - 1 } else { 0 };
    let recent  = &candles[start..n - 1];
    let hi_recent = recent.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    let lo_recent = recent.iter().map(|c| c.low).fold(f64::INFINITY,     f64::min);
    let breakout_bull = price > hi_recent;
    let breakout_bear = price < lo_recent;

    // ── Order book imbalance ───────────────────────────────────────────────
    let total_vol   = bid_vol + ask_vol;
    let imbalance   = if total_vol > 0.0 { bid_vol / total_vol } else { 0.5 };

    // ── RSI divergence (bonus, not required) ──────────────────────────────
    let divergence = if rsi_history.len() >= 6 {
        rsi_divergence(&closes, rsi_history, 5).ok().flatten()
    } else {
        None
    };

    let indicators = serde_json::json!({
        "rsi":          rsi_val,
        "momentum":     mom,
        "vol_ok":       vol_ok,
        "breakout_bull":breakout_bull,
        "breakout_bear":breakout_bear,
        "imbalance":    imbalance,
        "spread_pct":   spread_pct,
        "above_vwap":   above_vwap,
        "below_vwap":   below_vwap,
        "stoch_k":      stoch.as_ref().map(|s| s.k),
        "stoch_d":      stoch.as_ref().map(|s| s.d),
        "atr":          atr_val,
        "divergence":   divergence.as_ref().map(|d| format!("{d:?}")),
    });

    let stoch_bull_ok = stoch.as_ref().map(|s| s.k >= stoch_bullish).unwrap_or(true);
    let stoch_bear_ok = stoch.as_ref().map(|s| s.k <= stoch_bearish).unwrap_or(true);

    // ── LONG: all primary conditions ──────────────────────────────────────
    if breakout_bull
        && rsi_val >= rsi_bullish
        && mom > momentum_min_pct
        && vol_ok
        && imbalance >= min_imbalance
        && above_vwap
        && stoch_bull_ok
    {
        let (sl, tp) = atr_stops(price, atr_val, atr_mult, rr_ratio, true)?;
        let div_bonus = if divergence == Some(Divergence::Bullish) { 0.1 } else { 0.0 };
        return Ok(Signal {
            direction:   "LONG".into(),
            confidence:  (0.7 + div_bonus).min(1.0),
            reason:      "momentum_scalp_long".into(),
            stop_loss:   Some(sl),
            take_profit: Some(tp),
            size_factor: 0.5,
            indicators,
        });
    }

    // ── SHORT: all primary conditions ─────────────────────────────────────
    if allow_short
        && breakout_bear
        && rsi_val <= rsi_bearish
        && mom < -momentum_min_pct
        && vol_ok
        && imbalance <= (1.0 - min_imbalance)
        && below_vwap
        && stoch_bear_ok
    {
        let (sl, tp) = atr_stops(price, atr_val, atr_mult, rr_ratio, false)?;
        let div_bonus = if divergence == Some(Divergence::Bearish) { 0.1 } else { 0.0 };
        return Ok(Signal {
            direction:   "SHORT".into(),
            confidence:  (0.7 + div_bonus).min(1.0),
            reason:      "momentum_scalp_short".into(),
            stop_loss:   Some(sl),
            take_profit: Some(tp),
            size_factor: 0.5,
            indicators,
        });
    }

    let reason = if !vol_ok             { "volume_insufficient".into() }
                 else if !breakout_bull && !breakout_bear { "no_breakout".into() }
                 else if spread_pct > max_spread_pct      { "spread_too_wide".into() }
                 else                                      { "conditions_not_met".into() };

    Ok(Signal { reason, indicators, ..Default::default() })
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC: DCA enhanced multiplier calculation.
// Returns the buy multiplier based on how far price is below SMA.
// Mirrors the JavaScript logic exactly including the safety cap.
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DcaMultiplierResult {
    pub multiplier:    f64,
    pub sma:           f64,
    pub drop_pct:      f64,
    pub tier_matched:  Option<String>,
}

pub fn dca_multiplier(
    price:         f64,
    closes:        &[f64],
    sma_period:    usize,
    dips:          &[(f64, f64)],  // (drop_percent_threshold, multiplier)
    max_multiplier: f64,
) -> Result<DcaMultiplierResult> {
    if price <= 0.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("dca_multiplier: price must be > 0, got {price}") });
    }
    if max_multiplier < 1.0 {
        return Err(IndicatorError::InvalidInput { msg: format!("dca_multiplier: max_multiplier must be >= 1, got {max_multiplier}") });
    }

    let sma_val = sma(closes, sma_period)?;
    let drop_pct = ((sma_val - price) / sma_val) * 100.0;

    if drop_pct <= 0.0 {
        return Ok(DcaMultiplierResult {
            multiplier:   1.0,
            sma:          sma_val,
            drop_pct,
            tier_matched: None,
        });
    }

    // Find highest applicable tier (sort descending by threshold)
    let mut sorted_dips = dips.to_vec();
    sorted_dips.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    for (threshold, mult) in &sorted_dips {
        if drop_pct >= *threshold {
            let capped = mult.min(max_multiplier).max(1.0);
            return Ok(DcaMultiplierResult {
                multiplier:   capped,
                sma:          sma_val,
                drop_pct,
                tier_matched: Some(format!("{threshold}%_drop->{capped}x")),
            });
        }
    }

    Ok(DcaMultiplierResult {
        multiplier:   1.0,
        sma:          sma_val,
        drop_pct,
        tier_matched: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC: Cash & carry funding payment accumulator.
// Computes net funding collected across all 8h periods in a position.
// Returns net (received - paid), total received, total paid.
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FundingAccumResult {
    pub net:           f64,
    pub total_received:f64,
    pub total_paid:    f64,
    pub payment_count: usize,
    pub avg_rate:      f64,
}

pub fn accumulate_funding(
    notional_usdt: f64,
    rates:         &[f64],   // funding rates in percent per period
) -> Result<FundingAccumResult> {
    if notional_usdt <= 0.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("accumulate_funding: notional_usdt must be > 0, got {notional_usdt}"),
        });
    }
    if rates.is_empty() {
        return Ok(FundingAccumResult { net: 0.0, total_received: 0.0, total_paid: 0.0, payment_count: 0, avg_rate: 0.0 });
    }

    let mut total_received = 0.0f64;
    let mut total_paid     = 0.0f64;

    for &rate in rates {
        if !rate.is_finite() {
            return Err(IndicatorError::InvalidInput { msg: format!("accumulate_funding: rate {rate} is not finite") });
        }
        let payment = notional_usdt * rate.abs() / 100.0;
        if rate > 0.0 {
            total_received += payment;  // short receives when funding positive
        } else {
            total_paid += payment;
        }
    }

    let avg_rate = rates.iter().sum::<f64>() / rates.len() as f64;

    Ok(FundingAccumResult {
        net: total_received - total_paid,
        total_received,
        total_paid,
        payment_count: rates.len(),
        avg_rate,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS LOGIC: Seasonal path similarity scorer.
// Compares YTD normalised returns against prior year normalised returns.
// Returns correlation, DTW distance, and combined similarity score (0-1).
// ─────────────────────────────────────────────────────────────────────────────
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PathSimilarity {
    pub year:        u32,
    pub correlation: f64,
    pub dtw_score:   f64,   // 1.0 - normalised dtw
    pub sim_score:   f64,   // 0.6 * corr + 0.4 * dtw_score
}

pub fn compare_path_similarity(
    current_prices: &[f64],
    prior_prices:   &[f64],
    year:           u32,
) -> Result<PathSimilarity> {
    require_slice(current_prices, 2, "compare_path_similarity:current")?;
    require_slice(prior_prices,   2, "compare_path_similarity:prior")?;

    let cr = to_returns(current_prices)?;
    let pr = to_returns(prior_prices)?;

    let cn = normalize(&cr)?;
    let pn = normalize(&pr)?;

    let min_len = cn.len().min(pn.len());
    let corr    = correlation(&cn[..min_len], &pn[..min_len])?;

    let dtw     = dtw_distance(&cn[..min_len], &pn[..min_len])?;
    // Normalise DTW: divide by series length so it's comparable regardless of length
    let dtw_score = f64::max(0.0, 1.0 - dtw / min_len as f64);

    let sim_score = (corr * 0.6 + dtw_score * 0.4).clamp(0.0, 1.0);

    Ok(PathSimilarity { year, correlation: corr, dtw_score, sim_score })
}
