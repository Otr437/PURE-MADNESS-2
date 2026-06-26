// Main entry point — Go RAG AI Monorepo
// Dispatches to: agent, api, eval, react modes based on first argument.
//
// go run ./src/... agent -task "your question"
// go run ./src/... api
// go run ./src/... eval
// go run ./src/... react "your task"

package main

import (
	"context"
	"fmt"
	"os"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	mode := os.Args[1]
	os.Args = append([]string{os.Args[0]}, os.Args[2:]...)

	switch mode {
	case "agent":
		runAgentCLI()

	case "api":
		startAPIServer()

	case "eval":
		topK := 5
		runEval(context.Background(), topK)

	case "react":
		task := strings.Join(os.Args[1:], " ")
		if task == "" {
			task = "Calculate the 47th Fibonacci number using bash, then explain the result."
		}
		answer, trace, err := RunReact(context.Background(), task, ReactOptions{})
		if err != nil {
			fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("\n" + strings.Repeat("=", 60))
		fmt.Println("FINAL ANSWER:\n" + answer)
		fmt.Println(strings.Repeat("=", 60))
		fmt.Printf("Iterations: %d | Tokens: %d | Time: %dms\n",
			trace.Iterations, trace.TotalTokens, trace.ElapsedMS)

	case "harness":
		harnessMain()

	case "run-agent":
		RunAgentMain()

	case "trading":
		TradingAgentMain()

	default:
		fmt.Fprintf(os.Stderr, "Unknown mode: %s\n", mode)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`RAG AI Monorepo — Go

Usage:
  go run ./src/... <mode> [options]

Modes:
  agent   Run RAG agent CLI
            -task "your question"
            -dir  ./path/to/docs    (optional: ingest directory first)
            -max-iterations 30
            -quiet
  api     Start REST API server (PORT env var, default 8002)
  eval    Run retrieval quality evaluation (Precision@K, Recall@K, MRR, NDCG)
  react   Run bare ReAct loop without RAG
            "your task here"
  trading Run trading research agent (RAG + market data + backtesting)
            -task "your question"
            -max-iterations 20
            -skip-ingest    (skip re-ingesting strategy knowledge)

Environment:
  MODEL_PROVIDER      anthropic|deepseek|openai  (default: anthropic)
  ANTHROPIC_API_KEY   required for anthropic/deepseek providers
  DEEPSEEK_API_KEY    required for deepseek provider
  OPENAI_API_KEY      required for openai provider
  VOYAGE_API_KEY      required for embeddings + reranking
  QDRANT_URL          localhost:6333 (default)
  JWT_SECRET          required for api mode
  TAVILY_API_KEY      required for web search tool
  ALPHA_VANTAGE_API_KEY  required for stock market data tools (trading mode)
  MARKET_DATA_CACHE_TTL  seconds, default 60 (trading mode)
  IBKR_LIVE_TRADING      true|false, default false/paper (trading mode — never auto-executes)`)
}
