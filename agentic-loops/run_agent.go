// Production Runtime Harness — Go
// Wires react_loop.go into a fully runnable CLI agent.
//
// Usage:
//   go run run_agent.go react_loop.go "your task here"
//   go run run_agent.go react_loop.go --system "You are a DevOps expert." "audit /tmp"
//   go run run_agent.go react_loop.go --max-iter 50 --json-out /tmp/result.json "task"
//   echo "task" | go run run_agent.go react_loop.go -
//
// Environment:
//   ANTHROPIC_API_KEY   required
//   AGENT_MAX_ITER      default 30
//   AGENT_SYSTEM        system prompt override
//   AGENT_LOG_LEVEL     debug | info (default info)

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ── Validate environment ──────────────────────────────────────────────────────
func validateEnvHarness() {
	key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if key == "" {
		fmt.Fprintln(os.Stderr, "[harness] ERROR: ANTHROPIC_API_KEY is not set")
		os.Exit(1)
	}
	if !strings.HasPrefix(key, "sk-ant-") {
		fmt.Fprintln(os.Stderr, "[harness] WARN: ANTHROPIC_API_KEY does not look like a valid Anthropic key")
	}
}

// ── Step printer ──────────────────────────────────────────────────────────────
func makeGoStepPrinter(verbose bool, interrupted *bool) func(Step) {
	if !verbose {
		return func(Step) {}
	}
	return func(step Step) {
		if *interrupted {
			panic("agent interrupted by user")
		}
		switch step.Type {
		case StepThought:
			fmt.Printf("\n\033[94m💭 THOUGHT\033[0m\n%s\n", step.Content)
		case StepAction:
			inp, _ := json.MarshalIndent(step.Input, "", "  ")
			fmt.Printf("\n\033[93m⚡ ACTION\033[0m  %s\n%s\n", step.Tool, string(inp))
		case StepObservation:
			color, label := "\033[92m", "👁 OBSERVE"
			if step.Error {
				color, label = "\033[91m", "❌ ERROR"
			}
			preview := step.Content
			if len(preview) > 600 {
				preview = preview[:600] + "..."
			}
			fmt.Printf("\n%s%s\033[0m\n%s\n", color, label, preview)
		}
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────
func runAgentMain() {
	// Flags
	systemFlag  := flag.String("system",   os.Getenv("AGENT_SYSTEM"), "System prompt addition")
	maxIterFlag := flag.Int("max-iter",    30,                         "Max iterations")
	jsonOutFlag := flag.String("json-out", "",                         "Write result JSON to path")
	quietFlag   := flag.Bool("quiet",      false,                      "Suppress step output")
	flag.Parse()

	// Override max-iter from env
	if v := os.Getenv("AGENT_MAX_ITER"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			*maxIterFlag = n
		}
	}

	validateEnvHarness()

	// Read task
	var task string
	if flag.NArg() == 0 || flag.Arg(0) == "-" {
		raw, err := io.ReadAll(bufio.NewReader(os.Stdin))
		if err != nil {
			fmt.Fprintln(os.Stderr, "[harness] ERROR: reading stdin:", err)
			os.Exit(1)
		}
		task = strings.TrimSpace(string(raw))
	} else {
		task = strings.Join(flag.Args(), " ")
	}

	if task == "" {
		fmt.Fprintln(os.Stderr, "[harness] ERROR: no task provided")
		os.Exit(1)
	}

	log.SetOutput(os.Stderr)
	log.SetFlags(log.Ldate | log.Ltime)
	log.Printf("[harness] Task: %s", truncate(task, 200))
	log.Printf("[harness] Max iterations: %d", *maxIterFlag)

	// Signal handling
	interrupted := false
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		if interrupted {
			fmt.Fprintln(os.Stderr, "[harness] Force quit")
			os.Exit(130)
		}
		interrupted = true
		fmt.Fprintf(os.Stderr, "[harness] Signal %s — finishing current iteration...\n", sig)
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	start := time.Now()

	answer, trace, err := RunReact(ctx, task, ReactOptions{
		SystemExtra:   *systemFlag,
		MaxIterations: *maxIterFlag,
		OnStep:        makeGoStepPrinter(!*quietFlag, &interrupted),
	})

	elapsed := time.Since(start)

	if err != nil {
		if interrupted {
			fmt.Fprintln(os.Stderr, "\n[harness] Agent stopped by user")
			os.Exit(130)
		}
		fmt.Fprintf(os.Stderr, "[harness] ERROR: %v\n", err)
		os.Exit(1)
	}

	sep := strings.Repeat("=", 64)
	fmt.Printf("\n%s\nFINAL ANSWER\n%s\n%s\n%s\n", sep, sep, answer, sep)
	fmt.Printf("Iterations: %d | Tokens: %d | Time: %v\n",
		trace.Iterations, trace.TotalTokens, elapsed.Round(time.Millisecond))

	if *jsonOutFlag != "" {
		type outDoc struct {
			Task        string        `json:"task"`
			Answer      string        `json:"answer"`
			Iterations  int           `json:"iterations"`
			TotalTokens int64         `json:"total_tokens"`
			ElapsedMs   int64         `json:"elapsed_ms"`
			Steps       []Step        `json:"steps"`
		}
		doc := outDoc{
			Task:        task,
			Answer:      answer,
			Iterations:  trace.Iterations,
			TotalTokens: trace.TotalTokens,
			ElapsedMs:   elapsed.Milliseconds(),
			Steps:       trace.Steps,
		}
		data, _ := json.MarshalIndent(doc, "", "  ")
		if err := os.WriteFile(*jsonOutFlag, data, 0644); err != nil {
			fmt.Fprintf(os.Stderr, "[harness] ERROR writing json: %v\n", err)
			os.Exit(1)
		}
		log.Printf("[harness] Result written to %s", *jsonOutFlag)
	}
}

func init() {
	// Replace react_loop.go's main() with harness main
	// In production: put each in its own package and import react_loop as a lib.
	// For single-file compilation: rename react_loop's main() and call from here.
}

func main() {
	runAgentMain()
}
