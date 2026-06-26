// Trading Agent — Go
// Wires market_data, RAG strategy knowledge, and backtest_engine into the ReAct
// loop. Mirrors trading_agent.py's safety contract exactly: OrderPropose drafts
// only, OrderExecuteIBKR is NOT registered as an agent tool and requires
// explicit human confirm=true plus, separately, IBKR_LIVE_TRADING=true for live.
//
// export MODEL_PROVIDER=anthropic|deepseek|openai
// export ALPHA_VANTAGE_API_KEY=...
// export VOYAGE_API_KEY=...
// export QDRANT_URL=localhost:6333

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const TradingSystemPrompt = `You are a trading research assistant. You have access to:
- rag_search: a knowledge base of trading strategy theory (momentum, mean reversion, breakout, crypto-specific, risk management)
- get_stock_quote / get_stock_ohlcv: live and historical stock market data
- get_crypto_quote / get_crypto_ohlcv: live and historical cryptocurrency market data
- compute_indicators: SMA, RSI calculations
- run_backtest: test a named strategy preset against historical data and report performance metrics
- order_propose: draft a proposed order for human review — this NEVER executes a trade

CRITICAL SAFETY RULE: You can never execute trades. You can only use order_propose to draft
an order for a human to review and execute manually. If asked to "buy", "sell", "execute",
or "place an order", you must use order_propose, clearly state the order is a PROPOSAL
requiring human confirmation, and never claim a trade has been executed.

When researching a strategy, search the knowledge base first to ground your reasoning in
established strategy theory, then pull live or historical data to evaluate it, then
backtest if asked. Always cite which strategy concept underlies your reasoning.`

// ── Order proposal (safety boundary — drafts only, never executes) ──────────────
type OrderProposal struct {
	ProposalID string   `json:"proposal_id"`
	Symbol     string   `json:"symbol"`
	Side       string   `json:"side"`
	Quantity   float64  `json:"quantity"`
	OrderType  string   `json:"order_type"`
	LimitPrice *float64 `json:"limit_price"`
	AssetClass string   `json:"asset_class"`
	Rationale  string   `json:"rationale"`
	Status     string   `json:"status"`
}

var (
	proposalsMu sync.RWMutex
	proposals   = map[string]*OrderProposal{}
)

func goRandID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func ProposeOrder(symbol, side string, quantity float64, assetClass, orderType string, limitPrice *float64, rationale string) (*OrderProposal, error) {
	if side != "buy" && side != "sell" {
		return nil, fmt.Errorf("side must be 'buy' or 'sell', got '%s'", side)
	}
	if quantity <= 0 {
		return nil, fmt.Errorf("quantity must be positive")
	}
	if orderType == "limit" && limitPrice == nil {
		return nil, fmt.Errorf("limitPrice is required for limit orders")
	}
	if assetClass == "" {
		assetClass = "equity"
	}
	if orderType == "" {
		orderType = "market"
	}

	proposal := &OrderProposal{
		ProposalID: goRandID(),
		Symbol:     strings.ToUpper(strings.TrimSpace(symbol)),
		Side:       side, Quantity: quantity, OrderType: orderType,
		LimitPrice: limitPrice, AssetClass: assetClass, Rationale: rationale,
		Status: "PROPOSED — REQUIRES HUMAN CONFIRMATION",
	}

	proposalsMu.Lock()
	proposals[proposal.ProposalID] = proposal
	proposalsMu.Unlock()

	return proposal, nil
}

func GetProposal(proposalID string) (*OrderProposal, bool) {
	proposalsMu.RLock()
	defer proposalsMu.RUnlock()
	p, ok := proposals[proposalID]
	return p, ok
}

// ── IBKR execution (NOT registered as an agent tool — explicit opt-in only) ────
type ExecutionResult struct {
	ProposalID string         `json:"proposal_id"`
	Mode       string         `json:"mode"`
	Status     string         `json:"status"`
	Order      *OrderProposal `json:"order"`
	Note       string         `json:"note"`
}

// OrderExecuteIBKR executes a previously-drafted proposal via Interactive Brokers.
// This function is intentionally NOT registered in GoToolRegistry — the agent
// cannot call it autonomously. It must be invoked directly by human-reviewed
// calling code after a human has reviewed the proposal returned by ProposeOrder.
func OrderExecuteIBKR(proposalID string, confirm bool) (*ExecutionResult, error) {
	if !confirm {
		return nil, errors.New("execution requires confirm=true from a human-reviewed call site; this is not optional and has no default override")
	}

	proposal, ok := GetProposal(proposalID)
	if !ok {
		return nil, fmt.Errorf("no proposal found with id '%s' — it may have expired or never existed", proposalID)
	}

	liveTrading := strings.ToLower(os.Getenv("IBKR_LIVE_TRADING")) == "true"
	mode := "PAPER"
	if liveTrading {
		mode = "LIVE"
	}

	// IBKR execution happens via the IBKR MCP connector at the integration layer.
	// This function validates and logs the confirmed order; actual broker
	// submission must be invoked separately by the calling application.
	return &ExecutionResult{
		ProposalID: proposalID, Mode: mode, Status: "READY_FOR_BROKER_SUBMISSION",
		Order: proposal,
		Note: "This function validated and logged the confirmed order. Actual broker " +
			"submission happens via the IBKR MCP connector at the integration layer, " +
			"which must be invoked separately by the calling application.",
	}, nil
}

// ── RAG engine ─────────────────────────────────────────────────────────────────
var (
	tradingEngineOnce sync.Once
	tradingEngine     *RAGEngine
	tradingEngineErr  error
)

func getTradingEngine() (*RAGEngine, error) {
	tradingEngineOnce.Do(func() {
		tradingEngine, tradingEngineErr = NewRAGEngine("trading_strategies")
	})
	return tradingEngine, tradingEngineErr
}

// ── Tool registration ───────────────────────────────────────────────────────────
func RegisterTradingTools() error {
	registerMarketDataTools()

	engine, err := getTradingEngine()
	if err != nil {
		return fmt.Errorf("failed to init trading RAG engine: %w", err)
	}

	registerGoTool("rag_search", "Search the trading strategy knowledge base for theory on momentum, mean reversion, breakout, crypto, and risk management.",
		map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{"type": "string"},
				"top_k": map[string]interface{}{"type": "integer"},
			},
			"required": []string{"query"},
		},
		func(input map[string]interface{}) (string, error) {
			query, _ := input["query"].(string)
			topK := 5
			if v, ok := input["top_k"].(float64); ok {
				topK = int(v)
			}
			return engine.RetrieveAsContext(context.Background(), query, topK)
		},
	)

	registerGoTool("run_backtest", "Backtest a named strategy preset against historical OHLCV data for a symbol. Presets: sma_crossover, rsi_mean_reversion, breakout.",
		map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"symbol":                map[string]interface{}{"type": "string"},
				"asset_class":           map[string]interface{}{"type": "string"},
				"strategy":              map[string]interface{}{"type": "string"},
				"lookback_days_or_size": map[string]interface{}{"type": "string"},
			},
			"required": []string{"symbol", "strategy"},
		},
		func(input map[string]interface{}) (string, error) {
			symbol, _ := input["symbol"].(string)
			strategy, _ := input["strategy"].(string)
			assetClass, _ := input["asset_class"].(string)
			if assetClass == "" {
				assetClass = "equity"
			}
			lookback, _ := input["lookback_days_or_size"].(string)

			var bars []OHLCVBar
			var barsPerYear int
			var err error

			if assetClass == "crypto" {
				days := 90
				if n, perr := strconv.Atoi(lookback); perr == nil {
					days = n
				}
				cryptoBars, cerr := getCryptoOHLCV(symbol, "usd", days)
				if cerr != nil {
					return fmt.Sprintf("Backtest failed: %v", cerr), nil
				}
				bars = make([]OHLCVBar, len(cryptoBars))
				for i, b := range cryptoBars {
					bars[i] = OHLCVBar{Date: fmt.Sprintf("%d", b.Timestamp), Open: b.Open, High: b.High, Low: b.Low, Close: b.Close}
				}
				barsPerYear = 365
			} else {
				size := "compact"
				if lookback == "full" {
					size = "full"
				}
				bars, err = getStockOHLCV(symbol, "daily", size)
				if err != nil {
					return fmt.Sprintf("Backtest failed: %v", err), nil
				}
				barsPerYear = 252
			}

			var signalFn SignalFn
			switch strategy {
			case "sma_crossover":
				signalFn = MakeSMACrossoverSignal(0, 0)
			case "rsi_mean_reversion":
				signalFn = MakeRSIMeanReversionSignal(0, 0, 0)
			case "breakout":
				signalFn = MakeBreakoutSignal(0)
			default:
				return fmt.Sprintf("Error: unknown strategy '%s'. Available: sma_crossover, rsi_mean_reversion, breakout", strategy), nil
			}

			opts := DefaultBacktestOptions()
			opts.BarsPerYear = barsPerYear
			result, berr := RunBacktest(bars, signalFn, opts)
			if berr != nil {
				return fmt.Sprintf("Backtest failed: %v", berr), nil
			}

			return fmt.Sprintf(
				"Backtest of '%s' on %s (%d bars):\n"+
					"  Total Return: %.2f%%\n"+
					"  Annualized Return: %.2f%%\n"+
					"  Sharpe Ratio: %.2f\n"+
					"  Max Drawdown: %.2f%%\n"+
					"  Win Rate: %.1f%% (%d trades)\n"+
					"  Avg Trade: %.2f%% | Best: %.2f%% | Worst: %.2f%%",
				strategy, strings.ToUpper(symbol), len(bars),
				result.TotalReturnPct, result.AnnualizedReturnPct, result.SharpeRatio,
				result.MaxDrawdownPct, result.WinRatePct, result.NumTrades,
				result.AvgTradePct, result.BestTradePct, result.WorstTradePct,
			), nil
		},
	)

	registerGoTool("order_propose", "Draft a proposed order for human review. NEVER executes a trade — only creates a proposal that requires explicit human confirmation to execute.",
		map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"symbol":      map[string]interface{}{"type": "string"},
				"side":        map[string]interface{}{"type": "string"},
				"quantity":    map[string]interface{}{"type": "number"},
				"asset_class": map[string]interface{}{"type": "string"},
				"order_type":  map[string]interface{}{"type": "string"},
				"limit_price": map[string]interface{}{"type": "number"},
				"rationale":   map[string]interface{}{"type": "string"},
			},
			"required": []string{"symbol", "side", "quantity", "rationale"},
		},
		func(input map[string]interface{}) (string, error) {
			symbol, _ := input["symbol"].(string)
			side, _ := input["side"].(string)
			quantity, _ := input["quantity"].(float64)
			assetClass, _ := input["asset_class"].(string)
			orderType, _ := input["order_type"].(string)
			rationale, _ := input["rationale"].(string)

			var limitPrice *float64
			if v, ok := input["limit_price"].(float64); ok {
				limitPrice = &v
			}

			proposal, perr := ProposeOrder(symbol, side, quantity, assetClass, orderType, limitPrice, rationale)
			if perr != nil {
				return fmt.Sprintf("Error: invalid order parameters — %v", perr), nil
			}

			priceStr := "@ market"
			if orderType == "limit" && limitPrice != nil {
				priceStr = fmt.Sprintf("@ limit $%.2f", *limitPrice)
			}

			return fmt.Sprintf(
				"ORDER PROPOSAL (id=%s) — %s\n  %s %.4g %s (%s) %s\n  Rationale: %s\n"+
					"  This is a draft only. No order has been placed. A human must explicitly "+
					"confirm and execute this proposal via the trading platform.",
				proposal.ProposalID, proposal.Status,
				strings.ToUpper(side), quantity, strings.ToUpper(symbol), orderType, priceStr, rationale,
			), nil
		},
	)

	return nil
}

func IngestStrategyKnowledge(knowledgeDir string) (int, error) {
	if knowledgeDir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return 0, err
		}
		// languages/go/src -> repo root -> knowledge/trading_strategies
		knowledgeDir = filepath.Join(wd, "..", "..", "..", "knowledge", "trading_strategies")
	}

	info, err := os.Stat(knowledgeDir)
	if err != nil || !info.IsDir() {
		return 0, nil
	}

	docs, err := LoadDirectory(knowledgeDir, true)
	if err != nil {
		return 0, fmt.Errorf("failed to load strategy knowledge: %w", err)
	}
	if len(docs) == 0 {
		return 0, nil
	}

	engine, err := getTradingEngine()
	if err != nil {
		return 0, err
	}

	docVals := make([]Document, len(docs))
	for i, d := range docs {
		docVals[i] = *d
	}
	count, err := engine.Ingest(context.Background(), docVals)
	if err != nil {
		return 0, fmt.Errorf("ingest failed: %w", err)
	}
	return count, nil
}

// ── CLI entry point (called from main.go dispatcher as "trading" mode) ─────────
func TradingAgentMain() {
	fset := flag.NewFlagSet("trading", flag.ExitOnError)
	task := fset.String("task", "Search the knowledge base for momentum strategies, then explain how a 50/200 SMA crossover works and what its main risk is.", "Task for the agent")
	maxIter := fset.Int("max-iterations", 20, "Max ReAct iterations")
	skipIngest := fset.Bool("skip-ingest", false, "Skip re-ingesting strategy knowledge")
	_ = fset.Parse(os.Args[2:])

	if !*skipIngest {
		count, err := IngestStrategyKnowledge("")
		if err != nil {
			fmt.Fprintf(os.Stderr, "[trading_agent] ingest warning: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "[trading_agent] ingested %d chunks\n", count)
		}
	}

	if err := RegisterTradingTools(); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}

	answer, trace, err := RunReact(context.Background(), *task, ReactOptions{
		SystemExtra:   TradingSystemPrompt,
		MaxIterations: *maxIter,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("\n" + strings.Repeat("=", 64))
	fmt.Println("TRADING AGENT — FINAL ANSWER")
	fmt.Println(strings.Repeat("=", 64))
	fmt.Println(answer)
	fmt.Println(strings.Repeat("=", 64))
	fmt.Printf("Iterations: %d | Tokens: %d | Time: %dms\n", trace.Iterations, trace.TotalTokens, trace.ElapsedMS)

	proposalsMu.RLock()
	if len(proposals) > 0 {
		fmt.Printf("\n%d order proposal(s) drafted this session (none executed):\n", len(proposals))
		for _, p := range proposals {
			fmt.Printf("  - %+v\n", p)
		}
	}
	proposalsMu.RUnlock()
}
