// benches/indicators.rs
// Criterion benchmarks for every indicator.
// Run: cargo bench
// Results saved to target/criterion/

use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};
use crypto_indicators::{
    sma, ema, wilder_sma, rsi, rsi_history, macd, atr, bollinger_bands, vwap,
    z_score, stoch_rsi, adx, ichimoku, momentum, ma_crossover,
    rsi_divergence, fibonacci, pivot_points, volume_profile, donchian_channel,
    sharpe_ratio, sortino_ratio, max_drawdown, kelly_criterion,
    net_profit_pct, simulate_tri_cycle, grid_fill_profit, atr_stops,
    scan_cross_arb, build_grid, accumulate_funding, dca_multiplier,
    compare_path_similarity, trend_signal, mean_reversion_signal,
    momentum_scalp_signal, Candle, MaType,
    validation::{validate_candle_feed, validate_order_proposal},
    risk::{
        evaluate_position_exit, evaluate_portfolio_risk, compute_position_size,
        compute_drawdown, compute_performance_metrics,
    },
};

// ── TEST DATA GENERATORS ──────────────────────────────────────────────────────

fn make_closes(n: usize) -> Vec<f64> {
    // Deterministic synthetic price series — geometric random walk with seed
    let mut price = 50_000.0f64;
    let mut out   = Vec::with_capacity(n);
    for i in 0..n {
        // Simple LCG pseudo-random
        let r = ((i as u64).wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407)
            >> 33) as f64 / u32::MAX as f64;
        price *= 1.0 + (r - 0.5) * 0.02; // ±1% move per candle
        price = price.max(1.0);
        out.push(price);
    }
    out
}

fn make_candles(n: usize) -> Vec<Candle> {
    let closes = make_closes(n);
    closes.iter().enumerate().map(|(i, &c)| {
        let r = ((i as u64).wrapping_mul(2654435761).wrapping_add(12345) >> 32) as f64
            / u32::MAX as f64;
        Candle {
            open:   c * (1.0 - r * 0.005),
            high:   c * (1.0 + r * 0.01),
            low:    c * (1.0 - r * 0.01),
            close:  c,
            volume: 100.0 + r * 1000.0,
            time:   Some(1_700_000_000_000 + i as u64 * 3_600_000),
        }
    }).collect()
}

// ── MOVING AVERAGES ───────────────────────────────────────────────────────────

fn bench_sma(c: &mut Criterion) {
    let mut group = c.benchmark_group("sma");
    for n in [20, 50, 200] {
        let data = make_closes(500);
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            b.iter(|| sma(black_box(&data), black_box(n)))
        });
    }
    group.finish();
}

fn bench_ema(c: &mut Criterion) {
    let mut group = c.benchmark_group("ema");
    for n in [12, 26, 50, 200] {
        let data = make_closes(500);
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            b.iter(|| ema(black_box(&data), black_box(n)))
        });
    }
    group.finish();
}

// ── RSI ───────────────────────────────────────────────────────────────────────

fn bench_rsi(c: &mut Criterion) {
    let mut group = c.benchmark_group("rsi");
    for n in [7, 14] {
        let closes = make_closes(300);
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            b.iter(|| rsi(black_box(&closes), black_box(n)))
        });
    }
    group.finish();
}

fn bench_rsi_history(c: &mut Criterion) {
    let closes = make_closes(300);
    c.bench_function("rsi_history_14", |b| {
        b.iter(|| rsi_history(black_box(&closes), black_box(14)))
    });
}

fn bench_stoch_rsi(c: &mut Criterion) {
    let closes = make_closes(300);
    c.bench_function("stoch_rsi", |b| {
        b.iter(|| stoch_rsi(black_box(&closes), 14, 14, 3, 3))
    });
}

// ── MACD ──────────────────────────────────────────────────────────────────────

fn bench_macd(c: &mut Criterion) {
    let closes = make_closes(300);
    c.bench_function("macd_12_26_9", |b| {
        b.iter(|| macd(black_box(&closes), 12, 26, 9))
    });
}

// ── ATR ───────────────────────────────────────────────────────────────────────

fn bench_atr(c: &mut Criterion) {
    let candles = make_candles(300);
    c.bench_function("atr_14", |b| {
        b.iter(|| atr(black_box(&candles), 14))
    });
}

// ── BOLLINGER ─────────────────────────────────────────────────────────────────

fn bench_bollinger(c: &mut Criterion) {
    let closes = make_closes(300);
    c.bench_function("bollinger_20_2", |b| {
        b.iter(|| bollinger_bands(black_box(&closes), 20, 2.0))
    });
}

// ── VWAP ─────────────────────────────────────────────────────────────────────

fn bench_vwap(c: &mut Criterion) {
    let mut group = c.benchmark_group("vwap");
    for n in [24, 100, 500] {
        let candles = make_candles(n);
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {
            b.iter(|| vwap(black_box(&candles)))
        });
    }
    group.finish();
}

// ── ADX ───────────────────────────────────────────────────────────────────────

fn bench_adx(c: &mut Criterion) {
    let candles = make_candles(300);
    c.bench_function("adx_14", |b| {
        b.iter(|| adx(black_box(&candles), 14))
    });
}

// ── ICHIMOKU ──────────────────────────────────────────────────────────────────

fn bench_ichimoku(c: &mut Criterion) {
    let candles = make_candles(300);
    c.bench_function("ichimoku_9_26_52", |b| {
        b.iter(|| ichimoku(black_box(&candles), 9, 26, 52))
    });
}

// ── Z-SCORE ───────────────────────────────────────────────────────────────────

fn bench_zscore(c: &mut Criterion) {
    let closes = make_closes(300);
    let price  = closes[closes.len() - 1];
    c.bench_function("z_score_20", |b| {
        b.iter(|| z_score(black_box(price), black_box(&closes), 20))
    });
}

// ── VOLUME PROFILE ────────────────────────────────────────────────────────────

fn bench_volume_profile(c: &mut Criterion) {
    let candles = make_candles(500);
    c.bench_function("volume_profile_20bins", |b| {
        b.iter(|| volume_profile(black_box(&candles), 20))
    });
}

// ── DTW ───────────────────────────────────────────────────────────────────────

fn bench_dtw(c: &mut Criterion) {
    let mut group = c.benchmark_group("dtw");
    for n in [50, 200] {
        let a = make_closes(n);
        let b_data = make_closes(n);
        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {
            b.iter(|| crypto_indicators::dtw_distance(black_box(&a), black_box(&b_data)))
        });
    }
    group.finish();
}

// ── COMPOUND SIGNALS ──────────────────────────────────────────────────────────

fn bench_trend_signal(c: &mut Criterion) {
    let candles = make_candles(300);
    c.bench_function("trend_signal", |b| {
        b.iter(|| trend_signal(
            black_box(&candles),
            50, 200, &MaType::Ema,
            14, 70.0, 30.0,
            14, 20.0, 1.2, true, false,
            500.0, 14, 2.0, 2.0,
            0.55, 100.0, 80.0,
        ))
    });
}

fn bench_mean_reversion_signal(c: &mut Criterion) {
    let candles   = make_candles(200);
    let closes    = make_closes(200);
    let rsi_hist  = rsi_history(&closes, 7).unwrap();
    c.bench_function("mean_reversion_signal", |b| {
        b.iter(|| mean_reversion_signal(
            black_box(&candles),
            20, -2.0, 2.0,
            20, 2.0,
            14, 30.0, 70.0,
            black_box(&rsi_hist),
            false, 200.0,
            7, 2.5, 1.5,
            None, 0.3,
        ))
    });
}

fn bench_momentum_scalp_signal(c: &mut Criterion) {
    let candles  = make_candles(150);
    let closes   = make_closes(150);
    let rsi_hist = rsi_history(&closes, 7).unwrap();
    c.bench_function("momentum_scalp_signal", |b| {
        b.iter(|| momentum_scalp_signal(
            black_box(&candles),
            7, 55.0, 45.0,
            14, 3, 3,
            20.0, 80.0,
            10, 0.15, 5,
            1.5,
            600.0, 400.0, 0.01, 0.02, 0.60,
            true, false,
            black_box(&rsi_hist),
            7, 1.5, 1.5,
        ))
    });
}

// ── BUSINESS LOGIC ────────────────────────────────────────────────────────────

fn bench_grid_spec(c: &mut Criterion) {
    c.bench_function("build_grid_10_levels", |b| {
        b.iter(|| build_grid(
            black_box(80_000.0), black_box(100_000.0),
            black_box(10), black_box(1000.0),
            black_box(90_000.0), black_box(0.05),
        ))
    });
}

fn bench_scan_cross_arb(c: &mut Criterion) {
    c.bench_function("scan_cross_arb", |b| {
        b.iter(|| scan_cross_arb(
            black_box(50_000.0), black_box(50_010.0), black_box(1.0), black_box(1.0),
            black_box(50_080.0), black_box(50_090.0), black_box(1.0), black_box(1.0),
            0.1, 0.1, 100.0, 0.3, 0.05, 50.0,
        ))
    });
}

fn bench_performance_metrics(c: &mut Criterion) {
    let pnl: Vec<f64>    = (0..1000).map(|i| if i % 3 == 0 { -50.0 } else { 80.0 }).collect();
    let equity: Vec<f64> = {
        let mut eq = 10_000.0f64;
        pnl.iter().map(|p| { eq += p; eq }).collect()
    };
    c.bench_function("performance_metrics_1000trades", |b| {
        b.iter(|| compute_performance_metrics(
            black_box(&pnl), black_box(&equity), 0.0, 365.0,
        ))
    });
}

fn bench_path_similarity(c: &mut Criterion) {
    let current = make_closes(120);
    let prior   = make_closes(120);
    c.bench_function("compare_path_similarity_120", |b| {
        b.iter(|| compare_path_similarity(black_box(&current), black_box(&prior), 2023))
    });
}

fn bench_validate_candles(c: &mut Criterion) {
    let candles = make_candles(500);
    c.bench_function("validate_candle_feed_500", |b| {
        b.iter(|| validate_candle_feed(black_box(&candles)))
    });
}

// ── CRITERION GROUPS ──────────────────────────────────────────────────────────

criterion_group!(
    benches_indicators,
    bench_sma, bench_ema, bench_rsi, bench_rsi_history, bench_stoch_rsi,
    bench_macd, bench_atr, bench_bollinger, bench_vwap, bench_adx,
    bench_ichimoku, bench_zscore, bench_volume_profile, bench_dtw,
);

criterion_group!(
    benches_signals,
    bench_trend_signal, bench_mean_reversion_signal, bench_momentum_scalp_signal,
);

criterion_group!(
    benches_business,
    bench_grid_spec, bench_scan_cross_arb, bench_performance_metrics,
    bench_path_similarity, bench_validate_candles,
);

criterion_main!(benches_indicators, benches_signals, benches_business);
