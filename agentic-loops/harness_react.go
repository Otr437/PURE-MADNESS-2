// Test Harness — Go ReAct Loop
// Runs a battery of tasks, captures full traces, reports pass/fail/tokens/time.
//
// go get github.com/anthropics/anthropic-sdk-go
// export ANTHROPIC_API_KEY=sk-ant-...
// go run harness_react.go react_loop.go

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// ── Types ─────────────────────────────────────────────────────────────────────

type Validator func(answer string, trace *Trace) (bool, string)

type TestCase struct {
	Name          string
	Task          string
	Validate      Validator
	MaxIterations int
	SystemExtra   string
}

type TestResult struct {
	Name         string  `json:"name"`
	Passed       bool    `json:"passed"`
	Reason       string  `json:"reason"`
	Answer       string  `json:"answer"`
	Iterations   int     `json:"iterations"`
	TotalTokens  int64   `json:"total_tokens"`
	ElapsedMs    int64   `json:"elapsed_ms"`
	Error        string  `json:"error,omitempty"`
}

// ── Validators ────────────────────────────────────────────────────────────────

func contains(keywords ...string) Validator {
	return func(answer string, _ *Trace) (bool, string) {
		lower := strings.ToLower(answer)
		for _, k := range keywords {
			if !strings.Contains(lower, strings.ToLower(k)) {
				return false, fmt.Sprintf("missing keyword: %q", k)
			}
		}
		return true, "OK"
	}
}

func answerNotEmpty() Validator {
	return func(answer string, _ *Trace) (bool, string) {
		if strings.TrimSpace(answer) == "" {
			return false, "answer is empty"
		}
		return true, "OK"
	}
}

func usedTool(toolNames ...string) Validator {
	return func(_ string, trace *Trace) (bool, string) {
		used := map[string]bool{}
		for _, s := range trace.Steps {
			if s.Type == StepAction {
				used[s.Tool] = true
			}
		}
		for _, t := range toolNames {
			if !used[t] {
				return false, fmt.Sprintf("tool %q was never called", t)
			}
		}
		return true, "OK"
	}
}

func thoughtBeforeAction() Validator {
	return func(_ string, trace *Trace) (bool, string) {
		lastWasThought := false
		for _, s := range trace.Steps {
			switch s.Type {
			case StepThought:
				lastWasThought = true
			case StepAction:
				if s.Tool != "think" && s.Tool != "finish" {
					if !lastWasThought {
						return false, fmt.Sprintf("action %q not preceded by thought", s.Tool)
					}
					lastWasThought = false
				}
			}
		}
		return true, "OK"
	}
}

func minIterations(n int) Validator {
	return func(_ string, trace *Trace) (bool, string) {
		if trace.Iterations < n {
			return false, fmt.Sprintf("expected >= %d iterations, got %d", n, trace.Iterations)
		}
		return true, "OK"
	}
}

func all(validators ...Validator) Validator {
	return func(answer string, trace *Trace) (bool, string) {
		for _, v := range validators {
			ok, reason := v(answer, trace)
			if !ok {
				return false, reason
			}
		}
		return true, "OK"
	}
}

// ── Test suite ────────────────────────────────────────────────────────────────

var testSuite = []TestCase{
	{
		Name:     "basic_answer",
		Task:     "What is 2 + 2? Use the think tool to reason, then finish.",
		Validate: all(contains("4"), thoughtBeforeAction()),
	},
	{
		Name:     "code_execution",
		Task:     "Write and run a bash command to compute the sum of squares from 1 to 10. Report the result.",
		Validate: all(contains("385"), usedTool("run_bash"), thoughtBeforeAction()),
	},
	{
		Name:     "file_write_and_read",
		Task:     "Write 'ReAct harness test' to /tmp/harness_test_go.txt, then read it back and confirm the content.",
		Validate: all(contains("ReAct harness test"), usedTool("write_file", "read_file"), thoughtBeforeAction()),
	},
	{
		Name: "multi_step_reasoning",
		Task: "Calculate the 10th Fibonacci number using bash. Then the 20th. Report the ratio of 20th to 10th.",
		Validate: all(
			contains("55"),
			contains("6765"),
			usedTool("run_bash"),
			minIterations(3),
			thoughtBeforeAction(),
		),
	},
	{
		Name:     "error_recovery",
		Task:     "Try to read /tmp/no_such_file_go_99.txt. If it fails, create it with 'created by agent', then read it back.",
		Validate: all(contains("created by agent"), usedTool("read_file", "write_file"), thoughtBeforeAction()),
	},
	{
		Name:        "system_prompt_respected",
		Task:        "Tell me your name.",
		SystemExtra: "Your name is ARIA. Always introduce yourself as ARIA.",
		Validate:    contains("ARIA"),
	},
	{
		Name:     "finish_called",
		Task:     "Say hello and finish.",
		Validate: all(answerNotEmpty(), thoughtBeforeAction()),
	},
}

// ── Runner ────────────────────────────────────────────────────────────────────

func runHarness(suite []TestCase) []TestResult {
	results := make([]TestResult, 0, len(suite))

	fmt.Printf("\n%s\n", strings.Repeat("=", 64))
	fmt.Printf("  ReAct Harness — Go — %d tests\n", len(suite))
	fmt.Printf("%s\n\n", strings.Repeat("=", 64))

	for _, tc := range suite {
		fmt.Printf("▶  %-40s ... ", tc.name())
		start := time.Now()

		result := TestResult{Name: tc.Name}
		maxIter := tc.MaxIterations
		if maxIter == 0 {
			maxIter = 30
		}

		answer, trace, err := RunReact(context.Background(), tc.Task, ReactOptions{
			SystemExtra:   tc.SystemExtra,
			MaxIterations: maxIter,
		})

		result.ElapsedMs = time.Since(start).Milliseconds()

		if err != nil {
			result.Passed = false
			result.Reason = "Exception"
			result.Error  = err.Error()
		} else {
			result.Answer      = answer
			result.Iterations  = trace.Iterations
			result.TotalTokens = trace.TotalTokens
			result.ElapsedMs   = trace.Elapsed.Milliseconds()

			ok, reason := tc.Validate(answer, trace)
			result.Passed = ok
			result.Reason = reason
		}

		status := "✅ PASS"
		if !result.Passed {
			status = "❌ FAIL"
		}
		fmt.Printf("%s  (%dms, %d tok, %d iter)\n",
			status, result.ElapsedMs, result.TotalTokens, result.Iterations)

		if !result.Passed {
			fmt.Printf("   Reason : %s\n", result.Reason)
			if result.Error != "" {
				fmt.Printf("   Error  : %s\n", truncate(result.Error, 300))
			}
			if result.Answer != "" {
				fmt.Printf("   Answer : %s\n", truncate(result.Answer, 200))
			}
		}

		results = append(results, result)
	}

	// Summary
	passed := 0
	var totalTokens int64
	var totalMs int64
	for _, r := range results {
		if r.Passed {
			passed++
		}
		totalTokens += r.TotalTokens
		totalMs += r.ElapsedMs
	}

	fmt.Printf("\n%s\n", strings.Repeat("=", 64))
	fmt.Printf("  Results : %d/%d passed\n", passed, len(results))
	fmt.Printf("  Tokens  : %d\n", totalTokens)
	fmt.Printf("  Time    : %.2fs\n", float64(totalMs)/1000)
	fmt.Printf("%s\n\n", strings.Repeat("=", 64))

	// Write JSON report
	reportPath := "/tmp/react_harness_report_go.json"
	data, _ := json.MarshalIndent(results, "", "  ")
	_ = os.WriteFile(reportPath, data, 0644)
	fmt.Printf("  Report  → %s\n", reportPath)

	return results
}

func (tc TestCase) name() string { return tc.Name }

func harnessMain() {
	results := runHarness(testSuite)
	for _, r := range results {
		if !r.Passed {
			os.Exit(1)
		}
	}
	os.Exit(0)
}
