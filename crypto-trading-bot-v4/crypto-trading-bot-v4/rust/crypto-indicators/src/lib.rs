// src/lib.rs
// Crate root. Declares all modules and re-exports the full public surface.
// All indicator functions are pure — no global state, no I/O, no panics on valid input.

#![deny(unsafe_code)]
#![deny(unused_must_use)]
#![warn(clippy::all)]
#![warn(clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::cast_precision_loss)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::missing_panics_doc)]

pub mod types;
pub mod indicators;
pub mod validation;
pub mod risk;
pub mod seasonal;
pub mod bridge;

// ── Types ────────────────────────────────────────────────────────────────────
pub use types::{
    Candle,
    Signal,
    BridgeRequest,
    BridgeResponse,
    BollingerBands,
    MacdResult,
    StochRsiResult,
    AdxResult,
    IchimokuResult,
    FibonacciResult,
    PivotPoints,
    VolumeProfileResult,
    VolumeProfileBin,
    DonchianChannel,
    Divergence,
    Crossover,
    MaType,
    PositionSnapshot,
    PositionSide,
    PositionStatus,
    OrderProposal,
    OrderSide,
    OrderType,
    OrderStatus,
    PortfolioRisk,
    RiskBreach,
    SeasonalPattern,
    SeasonalBias,
    ValidationReport,
    BridgeStats,
    IndicatorError,
    Result,
};

// ── Indicators ────────────────────────────────────────────────────────────────
pub use indicators::{
    // Moving averages
    sma,
    ema,
    ema_history,
    wilder_sma,
    ma,
    // Statistics
    std_dev,
    std_dev_sample,
    z_score,
    // Oscillators
    rsi,
    rsi_history,
    stoch_rsi,
    // Compound indicators
    macd,
    atr,
    bollinger_bands,
    vwap,
    // Trend / momentum
    momentum,
    ma_crossover,
    rsi_divergence,
    // Complex indicators
    ichimoku,
    adx,
    fibonacci,
    pivot_points,
    volume_profile,
    donchian_channel,
    // Math helpers
    to_returns,
    normalize,
    correlation,
    dtw_distance,
    // Performance metrics
    sharpe_ratio,
    sortino_ratio,
    calmar_ratio,
    max_drawdown,
    kelly_criterion,
    // Trading business logic
    net_profit_pct,
    simulate_tri_cycle,
    grid_fill_profit,
    funding_payment,
    atr_stops,
    scan_cross_arb,
    scan_tri_cycles,
    build_grid,
    accumulate_funding,
    dca_multiplier,
    compare_path_similarity,
    // Compound strategy signals
    trend_signal,
    mean_reversion_signal,
    momentum_scalp_signal,
    // Security / validation
    validate_price_sanity,
    validate_no_duplicate_timestamps,
    validate_timestamps_ascending,
    detect_volume_anomalies,
    // Structs returned by indicators
    ArbOpportunity,
    TriLegResult,
    TriCycleResult,
    GridLevel,
    GridSpec,
    DcaMultiplierResult,
    FundingAccumResult,
    PathSimilarity,
};

// ── Validation ────────────────────────────────────────────────────────────────
pub use validation::{
    validate_candle_feed,
    validate_order_proposal,
    check_slippage,
    check_oracle_deviation,
    validate_funding_rate,
};

// ── Risk ──────────────────────────────────────────────────────────────────────
pub use risk::{
    evaluate_position_exit,
    evaluate_portfolio_risk,
    compute_position_size,
    validate_risk_reward,
    compute_drawdown,
    compute_performance_metrics,
    compute_break_even_stop,
    is_daily_loss_breached,
    liquidation_price,
    PositionExitDecision,
    ExitUrgency,
    PositionSizeResult,
    DrawdownReport,
    PerformanceMetrics,
};

// ── Seasonal ──────────────────────────────────────────────────────────────────
pub use seasonal::{
    candle_returns,
    compute_pattern,
    compute_monthly_patterns,
    compute_dow_patterns,
    compute_seasonal_bias,
    find_most_similar_year,
    find_accumulation_months,
    compute_spike_reversion_stats,
    unix_week_of_year,
    unix_hour,
    AccumulationMonth,
    SpikeReversionStats,
    SpikeRecord,
};
