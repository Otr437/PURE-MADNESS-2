// Production ReAct Loop — Go
// Reason → Act → Observe, repeat until finish() called.
//
// go get github.com/anthropics/anthropic-sdk-go
// export ANTHROPIC_API_KEY=sk-ant-...
// go run react_loop.go "your task here"

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	anthropic "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// ── Trace types ───────────────────────────────────────────────────────────────

type StepType string

const (
	StepThought     StepType = "thought"
	StepAction      StepType = "action"
	StepObservation StepType = "observation"
	StepAnswer      StepType = "answer"
)

type Step struct {
	Type    StepType       `json:"type"`
	Content string         `json:"content,omitempty"`
	Tool    string         `json:"tool,omitempty"`
	Input   map[string]any `json:"input,omitempty"`
	Error   bool           `json:"error,omitempty"`
}

type Trace struct {
	Steps       []Step        `json:"steps"`
	TotalTokens int64         `json:"total_tokens"`
	Iterations  int           `json:"iterations"`
	Elapsed     time.Duration `json:"elapsed_ms"`
}

// ── Tool registry ─────────────────────────────────────────────────────────────

type ToolFunc func(input map[string]any) (string, error)

var (
	toolRegistry = map[string]ToolFunc{}
	toolSchemas  []anthropic.ToolParam
)

func registerTool(name, description string, schema map[string]any, fn ToolFunc) {
	toolRegistry[name] = fn
	toolSchemas = append(toolSchemas, anthropic.ToolParam{
		Name:        name,
		Description: anthropic.String(description),
		InputSchema: anthropic.ToolInputSchemaParam{
			Properties: anthropic.F[any](schema["properties"]),
		},
	})
}

// ── Built-in tools ────────────────────────────────────────────────────────────

func init() {
	registerTool("think", "Reason step by step before acting.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"reasoning": map[string]any{"type": "string"},
			},
			"required": []string{"reasoning"},
		},
		func(input map[string]any) (string, error) {
			return "OK", nil
		},
	)

	registerTool("search", "Search the web for current information.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string"},
			},
			"required": []string{"query"},
		},
		func(input map[string]any) (string, error) {
			// Replace with Brave, Tavily, SerpAPI, etc.
			return "", fmt.Errorf("search not wired up. query: %v", input["query"])
		},
	)

	registerTool("fetch_url", "Fetch the text content of a URL.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url": map[string]any{"type": "string"},
			},
			"required": []string{"url"},
		},
		func(input map[string]any) (string, error) {
			url, _ := input["url"].(string)
			resp, err := http.Get(url)
			if err != nil {
				return "", err
			}
			defer resp.Body.Close()
			raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			if err != nil {
				return "", err
			}
			// Strip HTML
			re := regexp.MustCompile(`<[^>]+>`)
			clean := re.ReplaceAllString(string(raw), " ")
			clean = strings.Join(strings.Fields(clean), " ")
			if len(clean) > 8000 {
				clean = clean[:8000]
			}
			return clean, nil
		},
	)

	registerTool("run_bash", "Execute a bash command. Returns stdout/stderr. Timeout 15s.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{"type": "string"},
			},
			"required": []string{"command"},
		},
		func(input map[string]any) (string, error) {
			command, _ := input["command"].(string)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "bash", "-c", command)
			var out bytes.Buffer
			cmd.Stdout = &out
			cmd.Stderr = &out
			_ = cmd.Run()
			result := strings.TrimSpace(out.String())
			if result == "" {
				return "(no output)", nil
			}
			if len(result) > 8000 {
				result = result[:8000]
			}
			return result, nil
		},
	)

	registerTool("read_file", "Read a file from disk.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string"},
			},
			"required": []string{"path"},
		},
		func(input map[string]any) (string, error) {
			path, _ := input["path"].(string)
			data, err := os.ReadFile(path)
			return string(data), err
		},
	)

	registerTool("write_file", "Write content to a file on disk.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":    map[string]any{"type": "string"},
				"content": map[string]any{"type": "string"},
			},
			"required": []string{"path", "content"},
		},
		func(input map[string]any) (string, error) {
			path, _ := input["path"].(string)
			content, _ := input["content"].(string)
			err := os.WriteFile(path, []byte(content), 0644)
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("Written %d bytes to %s", len(content), path), nil
		},
	)

	registerTool("finish", "Call when you have the final answer. Ends the loop.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"answer": map[string]any{"type": "string"},
			},
			"required": []string{"answer"},
		},
		func(input map[string]any) (string, error) {
			answer, _ := input["answer"].(string)
			return answer, nil
		},
	)
}

// ── ReAct system prompt ───────────────────────────────────────────────────────

const reactSystem = `You are an autonomous agent operating in a ReAct loop (Reason + Act + Observe).

For every task:
1. Use the think tool to reason about what to do next before acting.
2. Call the appropriate tool to act.
3. Observe the result and reason again.
4. Repeat until you have a complete, verified answer.
5. Call finish with your final answer when done.

Rules:
- Always think before acting. Never skip the think step.
- If a tool errors, reason about why and try a different approach.
- Do not guess. If unsure, search or fetch.
- Be thorough. Do not call finish until the task is fully complete.`

// ── Core ReAct engine ─────────────────────────────────────────────────────────

type ReactOptions struct {
	SystemExtra   string
	MaxIterations int
	OnStep        func(Step)
}

func RunReact(ctx context.Context, task string, opts ReactOptions) (string, *Trace, error) {
	if opts.MaxIterations == 0 {
		opts.MaxIterations = 30
	}

	client := anthropic.NewClient(option.WithAPIKey(os.Getenv("ANTHROPIC_API_KEY")))
	system := reactSystem
	if opts.SystemExtra != "" {
		system += "\n\n" + opts.SystemExtra
	}

	messages := []anthropic.MessageParam{
		anthropic.NewUserMessage(anthropic.NewTextBlock(task)),
	}

	trace := &Trace{}
	start := time.Now()
	fmt.Fprintf(os.Stderr, "[react] START: %s\n", truncate(task, 120))

	for i := 0; i < opts.MaxIterations; i++ {
		trace.Iterations = i + 1
		fmt.Fprintf(os.Stderr, "[react] iteration %d\n", i+1)

		response, err := client.Messages.New(ctx, anthropic.MessageNewParams{
			Model:     anthropic.F(anthropic.ModelClaudeOpus46),
			MaxTokens: anthropic.F(int64(4096)),
			System:    anthropic.F([]anthropic.TextBlockParam{{Type: "text", Text: system}}),
			Tools:     anthropic.F(toolSchemas),
			Messages:  anthropic.F(messages),
		})
		if err != nil {
			return "", trace, fmt.Errorf("API error: %w", err)
		}

		trace.TotalTokens += response.Usage.InputTokens + response.Usage.OutputTokens
		messages = append(messages, response.ToParam())

		if response.StopReason == anthropic.StopReasonEndTurn {
			for _, block := range response.Content {
				if block.Type == anthropic.ContentBlockTypeText && strings.TrimSpace(block.Text) != "" {
					answer := strings.TrimSpace(block.Text)
					trace.Steps = append(trace.Steps, Step{Type: StepAnswer, Content: answer})
					trace.Elapsed = time.Since(start)
					return answer, trace, nil
				}
			}
		}

		if response.StopReason == anthropic.StopReasonToolUse {
			var toolResults []anthropic.ContentBlockParamUnion

			for _, block := range response.Content {
				if block.Type != anthropic.ContentBlockTypeToolUse {
					continue
				}

				name := block.Name
				var input map[string]any
				_ = json.Unmarshal([]byte(block.Input.(string)), &input)
				if input == nil {
					if raw, ok := block.Input.(map[string]any); ok {
						input = raw
					}
				}

				// Think
				if name == "think" {
					reasoning, _ := input["reasoning"].(string)
					step := Step{Type: StepThought, Content: reasoning}
					trace.Steps = append(trace.Steps, step)
					if opts.OnStep != nil {
						opts.OnStep(step)
					}
					fmt.Fprintf(os.Stderr, "[react] 💭 %s\n", truncate(reasoning, 200))
					toolResults = append(toolResults, anthropic.NewToolResultBlock(block.ID, "OK", false))
					continue
				}

				// Finish
				if name == "finish" {
					answer, _ := input["answer"].(string)
					trace.Steps = append(trace.Steps, Step{Type: StepAnswer, Content: answer})
					trace.Elapsed = time.Since(start)
					fmt.Fprintf(os.Stderr, "[react] DONE — %d iters, %d tokens, %v\n",
						trace.Iterations, trace.TotalTokens, trace.Elapsed.Round(time.Millisecond))
					return answer, trace, nil
				}

				// Regular action
				step := Step{Type: StepAction, Tool: name, Input: input}
				trace.Steps = append(trace.Steps, step)
				if opts.OnStep != nil {
					opts.OnStep(step)
				}
				inJSON, _ := json.Marshal(input)
				fmt.Fprintf(os.Stderr, "[react] ⚡ %s(%s)\n", name, truncate(string(inJSON), 200))

				fn, ok := toolRegistry[name]
				var result string
				isError := false
				if !ok {
					result = fmt.Sprintf("Tool '%s' not registered", name)
					isError = true
				} else {
					result, err = fn(input)
					if err != nil {
						result = fmt.Sprintf("Tool error: %v", err)
						isError = true
						fmt.Fprintf(os.Stderr, "[react] ❌ %s: %s\n", name, result)
					}
				}

				obs := Step{Type: StepObservation, Content: result, Error: isError}
				trace.Steps = append(trace.Steps, obs)
				if opts.OnStep != nil {
					opts.OnStep(obs)
				}
				fmt.Fprintf(os.Stderr, "[react] 👁 %s\n", truncate(result, 200))
				toolResults = append(toolResults, anthropic.NewToolResultBlock(block.ID, result, isError))
			}

			messages = append(messages, anthropic.NewUserMessage(toolResults...))
			continue
		}

		fmt.Fprintf(os.Stderr, "[react] unexpected stop_reason: %s\n", response.StopReason)
		break
	}

	trace.Elapsed = time.Since(start)
	return "", trace, fmt.Errorf("ReAct loop did not finish within %d iterations (tokens: %d)",
		opts.MaxIterations, trace.TotalTokens)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// ── CLI entry point ───────────────────────────────────────────────────────────

func main() {
	task := strings.Join(os.Args[1:], " ")
	if task == "" {
		task = "Calculate the 47th Fibonacci number using bash, then explain the result."
	}

	answer, trace, err := RunReact(context.Background(), task, ReactOptions{
		OnStep: func(step Step) {
			switch step.Type {
			case StepThought:
				fmt.Printf("\n💭 THOUGHT: %s\n", truncate(step.Content, 300))
			case StepAction:
				inp, _ := json.Marshal(step.Input)
				fmt.Printf("\n⚡ ACTION: %s(%s)\n", step.Tool, truncate(string(inp), 200))
			case StepObservation:
				marker := "👁"
				if step.Error {
					marker = "❌"
				}
				fmt.Printf("\n%s OBSERVE: %s\n", marker, truncate(step.Content, 300))
			}
		},
	})

	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("\n" + strings.Repeat("=", 60))
	fmt.Println("FINAL ANSWER:")
	fmt.Println(answer)
	fmt.Println(strings.Repeat("=", 60))
	fmt.Printf("Iterations: %d | Tokens: %d | Time: %v\n",
		trace.Iterations, trace.TotalTokens, trace.Elapsed.Round(time.Millisecond))

	out, _ := json.MarshalIndent(trace.Steps, "", "  ")
	fmt.Println("\nFull trace:")
	fmt.Println(string(out))
}
