// Test suite — Trading Agent modules (Go)
// Tests backtest_engine (pure computation), market_data indicator functions
// (pure computation), and trading_agent's order proposal safety boundary.
//
// go test ./... -run TestTrading -v
// go test ./... -run TestBacktest -v
// go test ./... -run TestMarketData -v
// go test ./... -run TestComputeSMA -v
// go test ./... -run TestComputeRSI -v
// go test ./... -run TestComputeATR -v
// go test ./... -run TestSharpe -v
// go test ./... -run TestMaxDrawdown -v
// go test ./... -run TestStrategyPreset -v
// go test ./... -run TestOrderProposal -v
// go test ./... -run TestOrderExecution -v

package main

import (
	"math"
	"os"
	"testing"
)

// ── market_data: indicator computation ──────────────────────────────────────────
func TestComputeSMABasic(t *testing.T) {
	closes := []float64{1, 2, 3, 4, 5}
	result := computeSMA(closes, 3)
	if result[0] != nil || result[1] != nil {
		t.Fatalf("expected nil for first two entries")
	}
	if result[2] == nil || *result[2] != 2.0 {
		t.Fatalf("expected SMA[2]=2.0, got %v", result[2])
	}
	if result[4] == nil || *result[4] != 4.0 {
		t.Fatalf("expected SMA[4]=4.0, got %v", result[4])
	}
}

func TestComputeSMAPeriodOne(t *testing.T) {
	closes := []float64{1, 2, 3}
	result := computeSMA(closes, 1)
	for i, v := range result {
		if v == nil || *v != closes[i] {
			t.Fatalf("period=1 should equal input values, got %v at %d", v, i)
		}
	}
}

func TestComputeSMAEmptyInput(t *testing.T) {
	result := computeSMA([]float64{}, 3)
	if len(result) != 0 {
		t.Fatalf("expected empty result for empty input")
	}
}

func TestComputeRSIInsufficientData(t *testing.T) {
	closes := []float64{1, 2, 3}
	result := computeRSI(closes, 14)
	for _, v := range result {
		if v != nil {
			t.Fatalf("expected all nil for insufficient data")
		}
	}
}

func TestComputeRSIAllGains(t *testing.T) {
	closes := make([]float64, 19)
	for i := range closes {
		closes[i] = float64(i + 1)
	}
	result := computeRSI(closes, 14)
	last := result[len(result)-1]
	if last == nil || *last != 100.0 {
		t.Fatalf("expected RSI=100 for all-gains sequence, got %v", last)
	}
}

func TestComputeRSIBounded(t *testing.T) {
	closes := []float64{10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17, 16, 18, 17, 19}
	result := computeRSI(closes, 14)
	for _, v := range result {
		if v != nil && (*v < 0 || *v > 100) {
			t.Fatalf("RSI out of bounds: %v", *v)
		}
	}
}

func TestComputeATRBasic(t *testing.T) {
	bars := []OHLCVBar{
		{High: 10, Low: 8, Close: 9},
		{High: 11, Low: 9, Close: 10},
		{High: 12, Low: 10, Close: 11},
	}
	result := computeATR(bars, 2)
	if len(result) != len(bars) {
		t.Fatalf("expected result length %d, got %d", len(bars), len(result))
	}
	last := result[len(result)-1]
	if last == nil || *last <= 0 {
		t.Fatalf("expected positive ATR, got %v", last)
	}
}

func TestComputeATRTooFewBars(t *testing.T) {
	bars := []OHLCVBar{{High: 10, Low: 9, Close: 9.5}}
	result := computeATR(bars, 14)
	for _, v := range result {
		if v != nil {
			t.Fatalf("expected all nil for too few bars")
		}
	}
}

func TestMDTTLCache(t *testing.T) {
	cache := newMDCache(0) // expires immediately
	cache.Set("key1", "value1")
	if _, ok := cache.Get("key1"); ok {
		t.Fatalf("expected immediate expiry to produce a cache miss")
	}
}

// ── backtest_engine: core simulation logic ──────────────────────────────────────
func makeTestBars(closes []float64) []OHLCVBar {
	bars := make([]OHLCVBar, len(closes))
	for i, c := range closes {
		bars[i] = OHLCVBar{
			Date: "2024-01-" + string(rune('0'+i%10)), Open: c, High: c * 1.01, Low: c * 0.99, Close: c, Volume: 1000,
		}
	}
	return bars
}

func TestBacktestRequiresMinimumBars(t *testing.T) {
	bars := []OHLCVBar{{Open: 1, High: 1, Low: 1, Close: 1}}
	_, err := RunBacktest(bars, func(h []OHLCVBar) Signal { return SignalFlat }, DefaultBacktestOptions())
	if err == nil {
		t.Fatalf("expected error for insufficient bars")
	}
}

func TestBacktestFlatSignalNoTrades(t *testing.T) {
	bars := makeTestBars([]float64{100, 101, 102, 103, 104})
	result, err := RunBacktest(bars, func(h []OHLCVBar) Signal { return SignalFlat }, DefaultBacktestOptions())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.NumTrades != 0 || result.TotalReturnPct != 0 {
		t.Fatalf("expected zero trades and zero return, got %d trades, %.2f%%", result.NumTrades, result.TotalReturnPct)
	}
}

func TestBacktestAlwaysLongTracksRise(t *testing.T) {
	bars := makeTestBars([]float64{100, 110, 120, 130, 140})
	opts := DefaultBacktestOptions()
	opts.FeePct = 0
	result, err := RunBacktest(bars, func(h []OHLCVBar) Signal { return SignalLong }, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if math.Abs(result.TotalReturnPct-40.0) > 0.5 {
		t.Fatalf("expected ~40%% return, got %.2f%%", result.TotalReturnPct)
	}
}

func TestBacktestAlwaysShortLosesInUptrend(t *testing.T) {
	bars := makeTestBars([]float64{100, 110, 120, 130, 140})
	opts := DefaultBacktestOptions()
	opts.FeePct = 0
	result, err := RunBacktest(bars, func(h []OHLCVBar) Signal { return SignalShort }, opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.TotalReturnPct >= 0 {
		t.Fatalf("expected negative return for short in uptrend, got %.2f%%", result.TotalReturnPct)
	}
}

func TestBacktestInvalidSignalErrors(t *testing.T) {
	bars := makeTestBars([]float64{100, 101, 102})
	_, err := RunBacktest(bars, func(h []OHLCVBar) Signal { return Signal("invalid") }, DefaultBacktestOptions())
	if err == nil {
		t.Fatalf("expected error for invalid signal value")
	}
}

func TestBacktestNoLookaheadBias(t *testing.T) {
	bars := makeTestBars([]float64{100, 101, 102, 103, 104, 105})
	var seenLengths []int
	_, err := RunBacktest(bars, func(h []OHLCVBar) Signal {
		seenLengths = append(seenLengths, len(h))
		return SignalFlat
	}, DefaultBacktestOptions())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := []int{2, 3, 4, 5, 6}
	if len(seenLengths) != len(expected) {
		t.Fatalf("expected %d calls, got %d", len(expected), len(seenLengths))
	}
	for i, v := range expected {
		if seenLengths[i] != v {
			t.Fatalf("at call %d expected history length %d, got %d", i, v, seenLengths[i])
		}
	}
}

func TestBacktestFeesReduceReturn(t *testing.T) {
	bars := makeTestBars([]float64{100, 110, 120, 130, 140})
	noFeeOpts := DefaultBacktestOptions()
	noFeeOpts.FeePct = 0
	withFeeOpts := DefaultBacktestOptions()
	withFeeOpts.FeePct = 0.01

	noFee, _ := RunBacktest(bars, func(h []OHLCVBar) Signal { return SignalLong }, noFeeOpts)
	withFee, _ := RunBacktest(bars, func(h []OHLCVBar) Signal { return SignalLong }, withFeeOpts)

	if withFee.TotalReturnPct >= noFee.TotalReturnPct {
		t.Fatalf("expected fees to reduce return: noFee=%.2f withFee=%.2f", noFee.TotalReturnPct, withFee.TotalReturnPct)
	}
}

func TestSharpeZeroVolatility(t *testing.T) {
	if computeSharpe([]float64{0, 0, 0}, 0, 252) != 0 {
		t.Fatalf("expected zero Sharpe for zero volatility")
	}
}

func TestSharpePositiveReturns(t *testing.T) {
	sharpe := computeSharpe([]float64{0.01, 0.02, 0.015, 0.01, 0.018}, 0, 252)
	if sharpe <= 0 {
		t.Fatalf("expected positive Sharpe, got %.4f", sharpe)
	}
}

func TestMaxDrawdownMonotonicIncrease(t *testing.T) {
	dd := computeMaxDrawdown([]float64{100, 110, 120, 130})
	if dd != 0 {
		t.Fatalf("expected zero drawdown for monotonic increase, got %.2f", dd)
	}
}

func TestMaxDrawdownDetected(t *testing.T) {
	dd := computeMaxDrawdown([]float64{100, 120, 90, 110})
	if math.Abs(dd-25.0) > 0.5 {
		t.Fatalf("expected ~25%% drawdown, got %.2f%%", dd)
	}
}

func TestStrategyPresetSMACrossover(t *testing.T) {
	signalFn := MakeSMACrossoverSignal(2, 4)
	bars := makeTestBars([]float64{100, 101, 102, 103, 104, 105})
	result := signalFn(bars)
	if result != SignalLong && result != SignalFlat {
		t.Fatalf("expected long or flat, got %s", result)
	}
}

func TestStrategyPresetSMACrossoverInsufficientHistory(t *testing.T) {
	signalFn := MakeSMACrossoverSignal(50, 200)
	bars := makeTestBars([]float64{100, 101, 102})
	if signalFn(bars) != SignalFlat {
		t.Fatalf("expected flat for insufficient history")
	}
}

func TestStrategyPresetBreakout(t *testing.T) {
	signalFn := MakeBreakoutSignal(3)
	bars := makeTestBars([]float64{100, 101, 100, 99, 105})
	result := signalFn(bars)
	if result != SignalLong && result != SignalFlat {
		t.Fatalf("expected long or flat, got %s", result)
	}
}

func TestStrategyPresetBreakoutInsufficientHistory(t *testing.T) {
	signalFn := MakeBreakoutSignal(20)
	bars := makeTestBars([]float64{100, 101})
	if signalFn(bars) != SignalFlat {
		t.Fatalf("expected flat for insufficient history")
	}
}

// ── trading_agent: order proposal safety boundary ────────────────────────────────
func TestOrderProposalCreatesProposal(t *testing.T) {
	p, err := ProposeOrder("AAPL", "buy", 10, "equity", "market", nil, "test rationale")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Symbol != "AAPL" || p.Side != "buy" {
		t.Fatalf("unexpected proposal fields: %+v", p)
	}
	if p.Status != "PROPOSED — REQUIRES HUMAN CONFIRMATION" {
		t.Fatalf("unexpected status: %s", p.Status)
	}
}

func TestOrderProposalInvalidSide(t *testing.T) {
	_, err := ProposeOrder("AAPL", "invalid", 10, "equity", "market", nil, "x")
	if err == nil {
		t.Fatalf("expected error for invalid side")
	}
}

func TestOrderProposalNonPositiveQuantity(t *testing.T) {
	if _, err := ProposeOrder("AAPL", "buy", 0, "equity", "market", nil, "x"); err == nil {
		t.Fatalf("expected error for zero quantity")
	}
	if _, err := ProposeOrder("AAPL", "buy", -5, "equity", "market", nil, "x"); err == nil {
		t.Fatalf("expected error for negative quantity")
	}
}

func TestOrderProposalLimitRequiresPrice(t *testing.T) {
	_, err := ProposeOrder("AAPL", "buy", 10, "equity", "limit", nil, "x")
	if err == nil {
		t.Fatalf("expected error for limit order without price")
	}
}

func TestGetProposalRoundtrip(t *testing.T) {
	p, _ := ProposeOrder("BTC", "buy", 0.1, "crypto", "market", nil, "x")
	fetched, ok := GetProposal(p.ProposalID)
	if !ok || fetched.ProposalID != p.ProposalID {
		t.Fatalf("expected to retrieve the same proposal")
	}
}

func TestGetNonexistentProposal(t *testing.T) {
	if _, ok := GetProposal("nonexistent-id"); ok {
		t.Fatalf("expected ok=false for nonexistent proposal")
	}
}

// ── Critical safety tests: OrderExecuteIBKR must never execute without confirm=true ──
func TestOrderExecutionRequiresConfirmTrue(t *testing.T) {
	p, _ := ProposeOrder("AAPL", "buy", 10, "equity", "market", nil, "x")
	_, err := OrderExecuteIBKR(p.ProposalID, false)
	if err == nil {
		t.Fatalf("expected error when confirm=false")
	}
}

func TestOrderExecutionUnknownProposalRaises(t *testing.T) {
	_, err := OrderExecuteIBKR("nonexistent-id", true)
	if err == nil {
		t.Fatalf("expected error for unknown proposal id")
	}
}

func TestOrderExecutionDefaultsToPaperMode(t *testing.T) {
	os.Unsetenv("IBKR_LIVE_TRADING")
	p, _ := ProposeOrder("AAPL", "buy", 10, "equity", "market", nil, "x")
	result, err := OrderExecuteIBKR(p.ProposalID, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Mode != "PAPER" {
		t.Fatalf("expected PAPER mode by default, got %s", result.Mode)
	}
}

func TestOrderExecutionLiveRequiresExplicitEnvVar(t *testing.T) {
	os.Setenv("IBKR_LIVE_TRADING", "true")
	defer os.Unsetenv("IBKR_LIVE_TRADING")
	p, _ := ProposeOrder("AAPL", "buy", 10, "equity", "market", nil, "x")
	result, err := OrderExecuteIBKR(p.ProposalID, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Mode != "LIVE" {
		t.Fatalf("expected LIVE mode with explicit env var, got %s", result.Mode)
	}
}

func TestOrderExecuteIBKRNotInToolRegistry(t *testing.T) {
	if _, ok := GoToolRegistry["order_execute_ibkr"]; ok {
		t.Fatalf("order_execute_ibkr must never be registered as an agent tool")
	}
	if _, ok := GoToolRegistry["order_execute"]; ok {
		t.Fatalf("order_execute must never be registered as an agent tool")
	}
}
