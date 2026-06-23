// src/seasonal.rs
// Seasonal pattern computation engine — pure math layer.
// Reads pre-loaded candle data and pattern structs, computes statistics.
// No I/O, no DB, no network. All data passed in from the bridge.

use crate::types::{Candle, SeasonalPattern, SeasonalBias, IndicatorError, Result};
use crate::indicators::{sma, std_dev, correlation, dtw_distance, to_returns, normalize};

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const MIN_SAMPLE_COUNT:      usize = 3;
const BULLISH_BIAS_WIN_RATE: f64   = 55.0;
const BEARISH_BIAS_WIN_RATE: f64   = 45.0;
const BULLISH_AVG_RETURN:    f64   = 0.5;
const BEARISH_AVG_RETURN:    f64   = -0.5;

// ── PER-CANDLE RETURN ─────────────────────────────────────────────────────────

/// Compute percent return for each candle relative to the previous close.
/// Returns empty vec if fewer than 2 candles.
pub fn candle_returns(candles: &[Candle]) -> Vec<f64> {
    if candles.len() < 2 { return Vec::new(); }
    candles.windows(2)
        .map(|w| {
            if w[0].close <= 0.0 { 0.0 }
            else { (w[1].close - w[0].close) / w[0].close * 100.0 }
        })
        .collect()
}

// ── ONE-SAMPLE T-STATISTIC ────────────────────────────────────────────────────
// Tests whether the mean of returns is significantly different from zero.

fn t_stat(returns: &[f64]) -> Option<f64> {
    if returns.len() < 2 { return None; }
    let n    = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / n;
    let var  = returns.iter().map(|&r| (r - mean).powi(2)).sum::<f64>() / (n - 1.0);
    let std  = var.sqrt();
    if std == 0.0 { return None; }
    Some(mean / std * n.sqrt())
}

// ── APPROXIMATE P-VALUE FROM T-STATISTIC ─────────────────────────────────────
// Uses normal approximation (valid for df >= 30). Conservative for small samples.

fn p_value_from_t(t: f64, _df: usize) -> f64 {
    let abs_t = t.abs();
    // Abramowitz & Stegun approximation of complementary error function
    let x   = abs_t / std::f64::consts::SQRT_2;
    let t_v = 1.0 / (1.0 + 0.3275911 * x);
    let poly = t_v * (0.254829592
        + t_v * (-0.284496736
        + t_v * (1.421413741
        + t_v * (-1.453152027
        + t_v * 1.061405429))));
    let p_one_tail = 0.5 * poly * (-x * x).exp();
    (2.0 * p_one_tail).min(1.0).max(0.0)
}

// ── SIGNAL STRENGTH ───────────────────────────────────────────────────────────
// Composite score 0-1 combining win rate bias, p-value significance, sample size.

fn signal_strength(win_rate: f64, p_value: f64, sample_count: usize) -> f64 {
    let win_bias    = (win_rate - 50.0).abs() / 50.0;          // 0-1
    let sig_factor  = (1.0 - p_value.min(1.0)).max(0.0);       // 0-1
    let size_factor = (sample_count as f64 / 36.0).min(1.0);   // caps at 3yr monthly
    (win_bias * 0.40 + sig_factor * 0.40 + size_factor * 0.20).clamp(0.0, 1.0)
}

// ── COMPUTE SEASONAL PATTERN FROM RETURNS ─────────────────────────────────────

/// Build a SeasonalPattern from a slice of returns for a given period dimension.
pub fn compute_pattern(
    pair:            String,
    interval:        String,
    returns:         &[f64],
    volumes:         &[f64],      // parallel slice, same length as returns
    avg_volume:      f64,         // baseline volume for ratio computation
    years_in_sample: u8,
    month:           Option<u8>,
    week_of_year:    Option<u8>,
    day_of_week:     Option<u8>,
    hour_of_day:     Option<u8>,
    spike_frequency_pct: Option<f64>,
) -> Result<SeasonalPattern> {
    if returns.len() < MIN_SAMPLE_COUNT {
        return Err(IndicatorError::InsufficientData { needed: MIN_SAMPLE_COUNT, got: returns.len() });
    }
    for (i, &r) in returns.iter().enumerate() {
        if !r.is_finite() {
            return Err(IndicatorError::NonFiniteInput { pos: i, value: r });
        }
    }
    if years_in_sample == 0 {
        return Err(IndicatorError::InvalidInput { msg: "compute_pattern: years_in_sample must be > 0".into() });
    }

    let n        = returns.len();
    let mean     = returns.iter().sum::<f64>() / n as f64;
    let wins     = returns.iter().filter(|&&r| r > 0.0).count();
    let win_rate = wins as f64 / n as f64 * 100.0;

    // Median (sorted copy)
    let mut sorted = returns.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = if n % 2 == 0 {
        (sorted[n/2 - 1] + sorted[n/2]) / 2.0
    } else {
        sorted[n/2]
    };

    let std      = if n >= 2 { std_dev(returns, n).unwrap_or(0.0) } else { 0.0 };
    let min_ret  = sorted[0];
    let max_ret  = sorted[n - 1];

    let t        = t_stat(returns);
    let p        = t.map(|tv| p_value_from_t(tv, n - 1));
    let strength = signal_strength(win_rate, p.unwrap_or(1.0), n);

    // Volume ratio vs baseline
    let avg_vol_ratio = if avg_volume > 0.0 && !volumes.is_empty() {
        let slice_vol = volumes.iter().sum::<f64>() / volumes.len() as f64;
        Some(slice_vol / avg_volume)
    } else {
        None
    };

    let pattern = SeasonalPattern {
        pair,
        interval,
        month,
        week_of_year,
        day_of_week,
        hour_of_day,
        years_in_sample,
        sample_count:       n as u32,
        avg_return_pct:     mean,
        median_return_pct:  median,
        std_return_pct:     std,
        min_return_pct:     min_ret,
        max_return_pct:     max_ret,
        win_rate_pct:       win_rate,
        t_stat:             t,
        p_value:            p,
        signal_strength:    strength,
        bullish_bias:       mean >= BULLISH_AVG_RETURN && win_rate >= BULLISH_BIAS_WIN_RATE,
        bearish_bias:       mean <= BEARISH_AVG_RETURN && win_rate <= BEARISH_BIAS_WIN_RATE,
        avg_volume_ratio:   avg_vol_ratio,
        spike_frequency_pct,
    };

    pattern.validate()?;
    Ok(pattern)
}

// ── COMPUTE ALL MONTHLY PATTERNS FOR A PAIR ───────────────────────────────────

/// Given a full candle history with timestamps, compute one SeasonalPattern per month (1-12).
/// Candles must have `time` set to Unix ms.
pub fn compute_monthly_patterns(
    candles:         &[Candle],
    pair:            &str,
    interval:        &str,
    years_in_sample: u8,
) -> Result<Vec<SeasonalPattern>> {
    if candles.len() < 30 {
        return Err(IndicatorError::InsufficientData { needed: 30, got: candles.len() });
    }

    let returns = candle_returns(candles);
    let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();
    let avg_vol = volumes.iter().sum::<f64>() / volumes.len() as f64;

    // Group returns by calendar month (1-12)
    let mut by_month: std::collections::HashMap<u8, (Vec<f64>, Vec<f64>)> =
        std::collections::HashMap::new();

    for (i, c) in candles[1..].iter().enumerate() {
        if let Some(ts_ms) = c.time {
            let ts_s   = ts_ms / 1000;
            // Simple month extraction from Unix timestamp (no chrono dependency)
            let month  = unix_month(ts_s);
            let entry  = by_month.entry(month).or_insert_with(|| (Vec::new(), Vec::new()));
            entry.0.push(returns[i]);
            entry.1.push(c.volume);
        }
    }

    let mut patterns = Vec::with_capacity(12);
    let mut months: Vec<u8> = by_month.keys().cloned().collect();
    months.sort_unstable();

    for month in months {
        let (rets, vols) = &by_month[&month];
        if rets.len() < MIN_SAMPLE_COUNT { continue; }
        match compute_pattern(
            pair.to_string(), interval.to_string(),
            rets, vols, avg_vol, years_in_sample,
            Some(month), None, None, None, None,
        ) {
            Ok(p)  => patterns.push(p),
            Err(e) => eprintln!("[SEASONAL] Month {month} pattern error: {e}"),
        }
    }

    Ok(patterns)
}

// ── COMPUTE DOW PATTERNS ──────────────────────────────────────────────────────

pub fn compute_dow_patterns(
    candles:         &[Candle],
    pair:            &str,
    interval:        &str,
    years_in_sample: u8,
) -> Result<Vec<SeasonalPattern>> {
    if candles.len() < 14 {
        return Err(IndicatorError::InsufficientData { needed: 14, got: candles.len() });
    }

    let returns = candle_returns(candles);
    let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();
    let avg_vol = volumes.iter().sum::<f64>() / volumes.len() as f64;

    let mut by_dow: std::collections::HashMap<u8, (Vec<f64>, Vec<f64>)> =
        std::collections::HashMap::new();

    for (i, c) in candles[1..].iter().enumerate() {
        if let Some(ts_ms) = c.time {
            let dow = unix_dow(ts_ms / 1000); // 0=Sun..6=Sat
            let e   = by_dow.entry(dow).or_insert_with(|| (Vec::new(), Vec::new()));
            e.0.push(returns[i]);
            e.1.push(c.volume);
        }
    }

    let mut patterns = Vec::with_capacity(7);
    for dow in 0u8..7 {
        if let Some((rets, vols)) = by_dow.get(&dow) {
            if rets.len() < MIN_SAMPLE_COUNT { continue; }
            match compute_pattern(
                pair.to_string(), interval.to_string(),
                rets, vols, avg_vol, years_in_sample,
                None, None, Some(dow), None, None,
            ) {
                Ok(p)  => patterns.push(p),
                Err(e) => eprintln!("[SEASONAL] DOW {dow} pattern error: {e}"),
            }
        }
    }

    Ok(patterns)
}

// ── COMPOSITE SEASONAL BIAS ───────────────────────────────────────────────────

/// Combine monthly + DOW patterns + path similarity into one SeasonalBias.
/// Weights: monthly 50%, DOW 30%, path similarity 20%.
pub fn compute_seasonal_bias(
    pair:            &str,
    monthly:         Option<&SeasonalPattern>,
    dow:             Option<&SeasonalPattern>,
    path_sim_score:  Option<f64>,
    most_similar_year: Option<u32>,
    min_confidence:  f64,
) -> Result<SeasonalBias> {
    if min_confidence < 0.0 || min_confidence > 1.0 {
        return Err(IndicatorError::InvalidInput {
            msg: format!("compute_seasonal_bias: min_confidence must be 0-1, got {min_confidence}"),
        });
    }

    let mut score  = 0.0f64;
    let mut weight = 0.0f64;
    let mut monthly_score_out = None;
    let mut dow_score_out     = None;
    let mut path_score_out    = None;

    if let Some(mp) = monthly {
        mp.validate()?;
        let (ms, _, _)  = mp.composite_signal();
        // Scale by signal strength
        let weighted = ms * mp.signal_strength as f64;
        score  += weighted * 0.50;
        weight += 0.50;
        monthly_score_out = Some(weighted);
    }

    if let Some(dp) = dow {
        dp.validate()?;
        let (ds, _, _)  = dp.composite_signal();
        let weighted = ds * dp.signal_strength as f64;
        score  += weighted * 0.30;
        weight += 0.30;
        dow_score_out = Some(weighted);
    }

    if let Some(ps) = path_sim_score {
        if !ps.is_finite() || ps < 0.0 || ps > 1.0 {
            return Err(IndicatorError::InvalidInput {
                msg: format!("compute_seasonal_bias: path_sim_score must be 0-1, got {ps}"),
            });
        }
        // High similarity = follow the prior year's direction
        // ps > 0.6 is strong, bias it bullish/bearish based on prior year
        let sim_component = if ps > 0.6 { ps - 0.5 } else { 0.0 }; // small positive push
        score  += sim_component * 0.20;
        weight += 0.20;
        path_score_out = Some(ps);
    }

    let normalised = if weight > 0.0 { score / weight } else { 0.0 };
    let clamped    = normalised.clamp(-1.0, 1.0);
    let confidence = clamped.abs();

    let direction = if clamped > 0.15 && confidence >= min_confidence {
        "bullish"
    } else if clamped < -0.15 && confidence >= min_confidence {
        "bearish"
    } else {
        "neutral"
    };

    Ok(SeasonalBias {
        pair:              pair.to_string(),
        score:             clamped,
        direction:         direction.to_string(),
        confidence,
        monthly_score:     monthly_score_out,
        dow_score:         dow_score_out,
        path_sim_score:    path_score_out,
        most_similar_year,
    })
}

// ── PATH SIMILARITY BATCH ─────────────────────────────────────────────────────

/// Compare current YTD price path against multiple prior year paths.
/// Returns results sorted by descending similarity score.
pub fn find_most_similar_year(
    current_prices:  &[f64],
    prior_years:     &[(u32, Vec<f64>)],  // (year, price_series)
) -> Result<Vec<crate::indicators::PathSimilarity>> {
    if current_prices.len() < 5 {
        return Err(IndicatorError::InsufficientData { needed: 5, got: current_prices.len() });
    }

    let mut results = Vec::with_capacity(prior_years.len());

    for (year, prices) in prior_years {
        if prices.len() < 5 { continue; }
        match crate::indicators::compare_path_similarity(current_prices, prices, *year) {
            Ok(sim) => results.push(sim),
            Err(e)  => eprintln!("[SEASONAL] Path similarity for year {year}: {e}"),
        }
    }

    results.sort_by(|a, b| b.sim_score.partial_cmp(&a.sim_score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(results)
}

// ── ACCUMULATION MONTH DETECTOR ───────────────────────────────────────────────

/// Find months where current month has negative avg return but NEXT month is strongly positive.
/// These are the "buy the dip before the rally" months.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AccumulationMonth {
    pub month:              u8,
    pub this_month_avg:     f64,
    pub next_month_avg:     f64,
    pub next_month_win_rate:f64,
    pub opportunity_score:  f64,
}

pub fn find_accumulation_months(
    monthly_patterns: &[SeasonalPattern],
    min_next_return:  f64,
) -> Vec<AccumulationMonth> {
    let mut result = Vec::new();

    for p in monthly_patterns {
        let month = match p.month { Some(m) => m, None => continue };
        if p.avg_return_pct >= 0.0 { continue; } // only dip months

        let next_month = if month == 12 { 1 } else { month + 1 };
        if let Some(next) = monthly_patterns.iter().find(|np| np.month == Some(next_month)) {
            if next.avg_return_pct >= min_next_return {
                let score = next.avg_return_pct * next.signal_strength
                    - p.avg_return_pct.abs() * 0.3; // penalise deep dip slightly
                result.push(AccumulationMonth {
                    month,
                    this_month_avg:      p.avg_return_pct,
                    next_month_avg:      next.avg_return_pct,
                    next_month_win_rate: next.win_rate_pct,
                    opportunity_score:   score,
                });
            }
        }
    }

    result.sort_by(|a, b| b.opportunity_score.partial_cmp(&a.opportunity_score).unwrap_or(std::cmp::Ordering::Equal));
    result
}

// ── SPIKE REVERSION STATISTICS ────────────────────────────────────────────────

/// Compute average reversion outcomes for a set of historical spikes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpikeReversionStats {
    pub direction:          String,
    pub spike_count:        usize,
    pub avg_spike_pct:      f64,
    pub avg_revert_1h_pct:  f64,
    pub avg_revert_4h_pct:  f64,
    pub avg_revert_24h_pct: f64,
    pub avg_revert_7d_pct:  f64,
    pub reversion_rate_pct: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpikeRecord {
    pub pct_move:      f64,
    pub is_up:         bool,  // true = upward spike
    pub revert_1h:     Option<f64>,
    pub revert_4h:     Option<f64>,
    pub revert_24h:    Option<f64>,
    pub revert_7d:     Option<f64>,
}

pub fn compute_spike_reversion_stats(
    spikes:    &[SpikeRecord],
    direction: &str,
) -> Result<SpikeReversionStats> {
    if spikes.is_empty() {
        return Err(IndicatorError::InsufficientData { needed: 1, got: 0 });
    }

    let n            = spikes.len() as f64;
    let avg_spike    = spikes.iter().map(|s| s.pct_move.abs()).sum::<f64>() / n;

    let avg_r1h  = avg_optional(spikes.iter().map(|s| s.revert_1h));
    let avg_r4h  = avg_optional(spikes.iter().map(|s| s.revert_4h));
    let avg_r24h = avg_optional(spikes.iter().map(|s| s.revert_24h));
    let avg_r7d  = avg_optional(spikes.iter().map(|s| s.revert_7d));

    // Reversion rate: % of spikes where 24h move was opposite to spike direction
    let reverted = spikes.iter().filter(|s| {
        if let Some(r24) = s.revert_24h {
            if s.is_up  { r24 < 0.0 }  // upward spike reverts downward
            else        { r24 > 0.0 }  // downward spike reverts upward
        } else { false }
    }).count();

    let reversion_rate = if spikes.iter().any(|s| s.revert_24h.is_some()) {
        let total_with_data = spikes.iter().filter(|s| s.revert_24h.is_some()).count();
        if total_with_data > 0 { reverted as f64 / total_with_data as f64 * 100.0 } else { 0.0 }
    } else { 0.0 };

    Ok(SpikeReversionStats {
        direction:          direction.to_string(),
        spike_count:        spikes.len(),
        avg_spike_pct:      avg_spike,
        avg_revert_1h_pct:  avg_r1h,
        avg_revert_4h_pct:  avg_r4h,
        avg_revert_24h_pct: avg_r24h,
        avg_revert_7d_pct:  avg_r7d,
        reversion_rate_pct: reversion_rate,
    })
}

fn avg_optional(iter: impl Iterator<Item = Option<f64>>) -> f64 {
    let (sum, count) = iter.fold((0.0, 0usize), |(s, c), v| {
        if let Some(x) = v { (s + x, c + 1) } else { (s, c) }
    });
    if count > 0 { sum / count as f64 } else { 0.0 }
}

// ── UNIX TIMESTAMP HELPERS (no external dependencies) ────────────────────────
// Basic Gregorian calendar math — sufficient for month/DOW extraction.

/// Extract month (1-12) from Unix timestamp seconds.
fn unix_month(ts_s: u64) -> u8 {
    let days_since_epoch = ts_s / 86400;
    // Shift to March 1, 2000 epoch for easier month calculation
    let days = days_since_epoch as i64 - 10957; // days from 1970-01-01 to 2000-01-01
    let era       = if days >= 0 { days } else { days - 146096 } / 146097;
    let doe       = days - era * 146097;
    let yoe       = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let doy       = doe - (365*yoe + yoe/4 - yoe/100);
    let mp        = (5*doy + 2) / 153;
    let month_mar = (mp + 3 - 1) % 12 + 1; // convert March-based to Jan-based
    month_mar as u8
}

/// Extract day of week (0=Sun, 1=Mon, ..., 6=Sat) from Unix timestamp seconds.
fn unix_dow(ts_s: u64) -> u8 {
    // 1970-01-01 was a Thursday (4)
    ((ts_s / 86400 + 4) % 7) as u8
}

/// Extract week of year (1-53, ISO 8601 approximation) from Unix timestamp seconds.
pub fn unix_week_of_year(ts_s: u64) -> u8 {
    let days = ts_s / 86400;
    let dow  = (days + 4) % 7; // 0=Sun
    let week = (days + 7 - dow) / 7;
    ((week % 53) + 1) as u8
}

/// Extract hour of day (0-23) from Unix timestamp seconds.
pub fn unix_hour(ts_s: u64) -> u8 {
    ((ts_s % 86400) / 3600) as u8
}
