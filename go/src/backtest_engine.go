// Backtest Engine — Go
// Tests a rule-based trading strategy against historical OHLCV bars (no money
// at risk — pure computation). Mirrors backtest_engine.py exactly in behaviour.

package main

import (
	"fmt"
	"math"
)

type Signal string

const (
	SignalLong  Signal = "long"
	SignalShort Signal = "short"
	SignalFlat  Signal = "flat"
)

type SignalFn func(history []OHLCVBar) Signal

type BacktestError struct{ Msg string }

func (e *BacktestError) Error() string { return e.Msg }

func btErrorf(format string, args ...interface{}) error {
	return &BacktestError{Msg: fmt.Sprintf(format, args...)}
}

type BTTrade struct {
	EntryDate  string  `json:"entry_date"`
	ExitDate   string  `json:"exit_date"`
	Direction  Signal  `json:"direction"`
	EntryPrice float64 `json:"entry_price"`
	ExitPrice  float64 `json:"exit_price"`
	PnlPct     float64 `json:"pnl_pct"`
	BarsHeld   int     `json:"bars_held"`
}

type BacktestResult struct {
	TotalReturnPct      float64   `json:"total_return_pct"`
	AnnualizedReturnPct float64   `json:"annualized_return_pct"`
	SharpeRatio         float64   `json:"sharpe_ratio"`
	MaxDrawdownPct      float64   `json:"max_drawdown_pct"`
	WinRatePct          float64   `json:"win_rate_pct"`
	NumTrades           int       `json:"num_trades"`
	AvgTradePct         float64   `json:"avg_trade_pct"`
	BestTradePct        float64   `json:"best_trade_pct"`
	WorstTradePct       float64   `json:"worst_trade_pct"`
	Trades              []BTTrade `json:"trades"`
	EquityCurve         []float64 `json:"equity_curve"`
}

type BacktestOptions struct {
	InitialCapital     float64
	FeePct             float64
	RiskFreeRateAnnual float64
	BarsPerYear        int
}

func DefaultBacktestOptions() BacktestOptions {
	return BacktestOptions{InitialCapital: 10_000, FeePct: 0.001, RiskFreeRateAnnual: 0, BarsPerYear: 252}
}

func RunBacktest(bars []OHLCVBar, signalFn SignalFn, opts BacktestOptions) (*BacktestResult, error) {
	if opts.InitialCapital == 0 {
		opts.InitialCapital = 10_000
	}
	if opts.BarsPerYear == 0 {
		opts.BarsPerYear = 252
	}

	if len(bars) < 2 {
		return nil, btErrorf("need at least 2 bars to run a backtest")
	}

	equity := opts.InitialCapital
	equityCurve := []float64{equity}
	position := SignalFlat
	entryPrice := 0.0
	entryIdx := 0
	var trades []BTTrade
	var returns []float64

	for i := 1; i < len(bars); i++ {
		history := bars[:i+1]
		newSignal := signalFn(history)
		if newSignal != SignalLong && newSignal != SignalShort && newSignal != SignalFlat {
			return nil, btErrorf("signalFn returned invalid signal '%s' at bar %d", newSignal, i)
		}

		currentClose := bars[i].Close
		prevClose := bars[i-1].Close

		barReturn := 0.0
		switch position {
		case SignalLong:
			barReturn = (currentClose - prevClose) / prevClose
		case SignalShort:
			barReturn = (prevClose - currentClose) / prevClose
		}
		equity *= 1 + barReturn
		returns = append(returns, barReturn)
		equityCurve = append(equityCurve, equity)

		if newSignal != position {
			if position != SignalFlat {
				exitPrice := currentClose
				var pnlPct float64
				if position == SignalLong {
					pnlPct = (exitPrice - entryPrice) / entryPrice * 100
				} else {
					pnlPct = (entryPrice - exitPrice) / entryPrice * 100
				}
				pnlPct -= opts.FeePct * 100
				equity *= 1 - opts.FeePct
				trades = append(trades, BTTrade{
					EntryDate: bars[entryIdx].Date, ExitDate: bars[i].Date,
					Direction: position, EntryPrice: entryPrice, ExitPrice: exitPrice,
					PnlPct: pnlPct, BarsHeld: i - entryIdx,
				})
			}
			if newSignal != SignalFlat {
				entryPrice = currentClose
				entryIdx = i
				equity *= 1 - opts.FeePct
			}
			position = newSignal
		}
	}

	if position != SignalFlat {
		exitPrice := bars[len(bars)-1].Close
		var pnlPct float64
		if position == SignalLong {
			pnlPct = (exitPrice - entryPrice) / entryPrice * 100
		} else {
			pnlPct = (entryPrice - exitPrice) / entryPrice * 100
		}
		pnlPct -= opts.FeePct * 100
		trades = append(trades, BTTrade{
			EntryDate: bars[entryIdx].Date, ExitDate: bars[len(bars)-1].Date,
			Direction: position, EntryPrice: entryPrice, ExitPrice: exitPrice,
			PnlPct: pnlPct, BarsHeld: len(bars) - 1 - entryIdx,
		})
	}

	totalReturnPct := (equityCurve[len(equityCurve)-1] - opts.InitialCapital) / opts.InitialCapital * 100
	numPeriods := len(bars) - 1
	years := float64(numPeriods) / float64(opts.BarsPerYear)
	finalEquity := equityCurve[len(equityCurve)-1]
	annualizedReturnPct := 0.0
	if years > 0 && finalEquity > 0 {
		annualizedReturnPct = (math.Pow(finalEquity/opts.InitialCapital, 1/years) - 1) * 100
	}

	sharpe := computeSharpe(returns, opts.RiskFreeRateAnnual, opts.BarsPerYear)
	maxDD := computeMaxDrawdown(equityCurve)

	var winCount int
	var sumPnl, best, worst float64
	if len(trades) > 0 {
		best = trades[0].PnlPct
		worst = trades[0].PnlPct
	}
	for _, t := range trades {
		if t.PnlPct > 0 {
			winCount++
		}
		sumPnl += t.PnlPct
		if t.PnlPct > best {
			best = t.PnlPct
		}
		if t.PnlPct < worst {
			worst = t.PnlPct
		}
	}
	winRate := 0.0
	avgTrade := 0.0
	if len(trades) > 0 {
		winRate = float64(winCount) / float64(len(trades)) * 100
		avgTrade = sumPnl / float64(len(trades))
	}

	return &BacktestResult{
		TotalReturnPct: totalReturnPct, AnnualizedReturnPct: annualizedReturnPct,
		SharpeRatio: sharpe, MaxDrawdownPct: maxDD, WinRatePct: winRate,
		NumTrades: len(trades), AvgTradePct: avgTrade, BestTradePct: best, WorstTradePct: worst,
		Trades: trades, EquityCurve: equityCurve,
	}, nil
}

func computeSharpe(returns []float64, riskFreeRateAnnual float64, barsPerYear int) float64 {
	if len(returns) < 2 {
		return 0
	}
	mean := 0.0
	for _, r := range returns {
		mean += r
	}
	mean /= float64(len(returns))

	variance := 0.0
	for _, r := range returns {
		variance += (r - mean) * (r - mean)
	}
	variance /= float64(len(returns) - 1)
	stdDev := math.Sqrt(variance)
	if stdDev == 0 {
		return 0
	}
	riskFreePerPeriod := riskFreeRateAnnual / float64(barsPerYear)
	return (mean - riskFreePerPeriod) / stdDev * math.Sqrt(float64(barsPerYear))
}

func computeMaxDrawdown(equityCurve []float64) float64 {
	if len(equityCurve) < 2 {
		return 0
	}
	peak := equityCurve[0]
	maxDD := 0.0
	for _, v := range equityCurve {
		if v > peak {
			peak = v
		}
		dd := 0.0
		if peak > 0 {
			dd = (peak - v) / peak
		}
		if dd > maxDD {
			maxDD = dd
		}
	}
	return maxDD * 100
}

// ── Built-in reference strategies ───────────────────────────────────────────────
func MakeSMACrossoverSignal(fastPeriod, slowPeriod int) SignalFn {
	if fastPeriod == 0 {
		fastPeriod = 50
	}
	if slowPeriod == 0 {
		slowPeriod = 200
	}
	return func(history []OHLCVBar) Signal {
		if len(history) < slowPeriod {
			return SignalFlat
		}
		closes := make([]float64, len(history))
		for i, b := range history {
			closes[i] = b.Close
		}
		fast := computeSMA(closes, fastPeriod)
		slow := computeSMA(closes, slowPeriod)
		f := fast[len(fast)-1]
		s := slow[len(slow)-1]
		if f == nil || s == nil {
			return SignalFlat
		}
		if *f > *s {
			return SignalLong
		}
		return SignalFlat
	}
}

func MakeRSIMeanReversionSignal(period int, oversold, overbought float64) SignalFn {
	if period == 0 {
		period = 14
	}
	if oversold == 0 {
		oversold = 30
	}
	if overbought == 0 {
		overbought = 70
	}
	return func(history []OHLCVBar) Signal {
		if len(history) < period+1 {
			return SignalFlat
		}
		closes := make([]float64, len(history))
		for i, b := range history {
			closes[i] = b.Close
		}
		rsi := computeRSI(closes, period)
		r := rsi[len(rsi)-1]
		if r == nil {
			return SignalFlat
		}
		if *r < oversold {
			return SignalLong
		}
		return SignalFlat
	}
}

func MakeBreakoutSignal(lookback int) SignalFn {
	if lookback == 0 {
		lookback = 20
	}
	return func(history []OHLCVBar) Signal {
		if len(history) < lookback+1 {
			return SignalFlat
		}
		window := history[len(history)-lookback-1 : len(history)-1]
		rangeHigh := window[0].High
		for _, b := range window {
			if b.High > rangeHigh {
				rangeHigh = b.High
			}
		}
		if history[len(history)-1].Close > rangeHigh {
			return SignalLong
		}
		return SignalFlat
	}
}
