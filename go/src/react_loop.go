// Production ReAct Loop — Go
// Reason → Act → Observe, repeat until finish() called.
// Provider-agnostic: uses ModelRouter (Claude / DeepSeek / OpenAI).
//
// export MODEL_PROVIDER=anthropic|deepseek|openai
// export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
// export TAVILY_API_KEY=tvly-...
// go run ./src/... "your task here"

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
)

// ── Trace types ────────────────────────────────────────────────────────────────
type StepType string

const (
	StepThought     StepType = "thought"
	StepAction      StepType = "action"
	StepObservation StepType = "observation"
	StepAnswer      StepType = "answer"
)

type Step struct {
	Type    StepType               `json:"type"`
	Content string                 `json:"content,omitempty"`
	Tool    string                 `json:"tool,omitempty"`
	Input   map[string]interface{} `json:"input,omitempty"`
	Error   bool                   `json:"error,omitempty"`
}

type Trace struct {
	Steps       []Step        `json:"steps"`
	TotalTokens int           `json:"total_tokens"`
	Iterations  int           `json:"iterations"`
	ElapsedMS   int64         `json:"elapsed_ms"`
}

// ── Tool registry ──────────────────────────────────────────────────────────────
type ToolFunc func(input map[string]interface{}) (string, error)

var (
	GoToolRegistry = map[string]ToolFunc{}
	GoToolSchemas  = []map[string]interface{}{}
)

func registerGoTool(name, description string, schema map[string]interface{}, fn ToolFunc) {
	GoToolRegistry[name] = fn
	GoToolSchemas = append(GoToolSchemas, map[string]interface{}{
		"name":         name,
		"description":  description,
		"input_schema": schema,
	})
}

// ── Tavily search ──────────────────────────────────────────────────────────────
type tavilyRequest struct {
	APIKey      string `json:"api_key"`
	Query       string `json:"query"`
	MaxResults  int    `json:"max_results"`
	SearchDepth string `json:"search_depth"`
	IncludeAnswer bool `json:"include_answer"`
}

type tavilyResponse struct {
	Answer  string `json:"answer"`
	Results []struct {
		Title   string `json:"title"`
		URL     string `json:"url"`
		Content string `json:"content"`
	} `json:"results"`
}

func tavilySearch(query string, maxResults int) (string, error) {
	apiKey := os.Getenv("TAVILY_API_KEY")
	if apiKey == "" {
		return "", fmt.Errorf("TAVILY_API_KEY not set")
	}
	reqBody, _ := json.Marshal(tavilyRequest{
		APIKey: apiKey, Query: query, MaxResults: maxResults,
		SearchDepth: "basic", IncludeAnswer: true,
	})
	resp, err := http.Post("https://api.tavily.com/search", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return "", fmt.Errorf("tavily request failed: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("tavily API %d: %s", resp.StatusCode, string(body))
	}
	var tr tavilyResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return "", err
	}
	var parts []string
	if tr.Answer != "" {
		parts = append(parts, "Direct answer: "+tr.Answer)
	}
	for i, r := range tr.Results {
		content := r.Content
		if len(content) > 600 {
			content = content[:600]
		}
		parts = append(parts, fmt.Sprintf("[%d] %s\nURL: %s\n%s", i+1, r.Title, r.URL, content))
	}
	if len(parts) == 0 {
		return "No results found.", nil
	}
	return strings.Join(parts, "\n\n"), nil
}

// ── Built-in tools ─────────────────────────────────────────────────────────────
func init() {
	registerGoTool("think", "Reason step by step before acting.",
		map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"reasoning": map[string]interface{}{"type": "string"}},
			"required":   []string{"reasoning"},
		},
		func(input map[string]interface{}) (string, error) { return "OK", nil },
	)

	registerGoTool("search", "Search the live web for current information via Tavily.",
		map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query":       map[string]interface{}{"type": "string"},
				"num_results": map[string]interface{}{"type": "integer", "description": "default 5"},
			},
			"required": []string{"query"},
		},
		func(input map[string]interface{}) (string, error) {
			query, _ := input["query"].(string)
			n := 5
			if nr, ok := input["num_results"].(float64); ok {
				n = int(nr)
			}
			return tavilySearch(query, n)
		},
	)

	registerGoTool("fetch_url", "Fetch and extract readable text from a URL.",
		map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"url": map[string]interface{}{"type": "string"}},
			"required":   []string{"url"},
		},
		func(input map[string]interface{}) (string, error) {
			url, _ := input["url"].(string)
			client := &http.Client{Timeout: 15 * time.Second}
			resp, err := client.Get(url)
			if err != nil {
				return "", err
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			re := regexp.MustCompile(`(?s)<script[^>]*>.*?</script>|<style[^>]*>.*?</style>|<[^>]+>`)
			clean := re.ReplaceAllString(string(raw), " ")
			clean = strings.Join(strings.Fields(clean), " ")
			if len(clean) > 8000 {
				clean = clean[:8000]
			}
			return clean, nil
		},
	)

	registerGoTool("run_bash", "Execute a bash command. Returns stdout+stderr. Timeout 15s.",
		map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"command": map[string]interface{}{"type": "string"}},
			"required":   []string{"command"},
		},
		func(input map[string]interface{}) (string, error) {
			command, _ := input["command"].(string)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			var out bytes.Buffer
			cmd := exec.CommandContext(ctx, "bash", "-c", command)
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

	registerGoTool("read_file", "Read a file from disk (UTF-8 text).",
		map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"path": map[string]interface{}{"type": "string"}},
			"required":   []string{"path"},
		},
		func(input map[string]interface{}) (string, error) {
			path, _ := input["path"].(string)
			data, err := os.ReadFile(path)
			return string(data), err
		},
	)

	registerGoTool("write_file", "Write content to a file on disk.",
		map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"path":    map[string]interface{}{"type": "string"},
				"content": map[string]interface{}{"type": "string"},
			},
			"required": []string{"path", "content"},
		},
		func(input map[string]interface{}) (string, error) {
			path, _    := input["path"].(string)
			content, _ := input["content"].(string)
			err := os.WriteFile(path, []byte(content), 0640)
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("Written %d bytes to %s", len(content), path), nil
		},
	)

	registerGoTool("finish", "Call when you have the final answer. Ends the loop.",
		map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"answer": map[string]interface{}{"type": "string"}},
			"required":   []string{"answer"},
		},
		func(input map[string]interface{}) (string, error) {
			answer, _ := input["answer"].(string)
			return answer, nil
		},
	)
}

// ── ReAct system prompt ────────────────────────────────────────────────────────
const goReactSystem = `You are an autonomous agent operating in a ReAct loop (Reason + Act + Observe).

For every task:
1. Use the think tool to reason about what to do next before acting.
2. Call the appropriate tool to act.
3. Observe the result and reason again.
4. Repeat until you have a complete, verified answer.
5. Call finish with your final answer when done.

Rules:
- Always think before acting. Never skip the think step.
- If a tool errors, reason about why and try a different approach.
- Do not guess. If unsure, use search or fetch_url.
- Be thorough. Do not call finish until the task is fully complete.`

// ── Core ReAct engine ──────────────────────────────────────────────────────────
type ReactOptions struct {
	SystemExtra   string
	MaxIterations int
	OnStep        func(Step)
}

func RunReact(ctx context.Context, task string, opts ReactOptions) (string, *Trace, error) {
	if opts.MaxIterations == 0 {
		opts.MaxIterations = 30
	}

	router, err := NewModelRouter("", "")
	if err != nil {
		return "", nil, fmt.Errorf("model router init: %w", err)
	}

	system := goReactSystem
	if opts.SystemExtra != "" {
		system += "\n\n" + opts.SystemExtra
	}

	// Build tool schemas as []map[string]interface{} for CreateOptions
	toolSchemas := make([]map[string]interface{}, len(GoToolSchemas))
	copy(toolSchemas, GoToolSchemas)

	messages := []map[string]interface{}{
		{"role": "user", "content": task},
	}

	trace := &Trace{}
	start := time.Now()
	fmt.Fprintf(os.Stderr, "[react] START provider=%s model=%s task=%s\n",
		router.Provider, router.Model, truncateStr(task, 120))

	for i := 0; i < opts.MaxIterations; i++ {
		trace.Iterations = i + 1
		fmt.Fprintf(os.Stderr, "[react] iteration %d\n", i+1)

		resp, err := router.Create(ctx, CreateOptions{
			Messages:  messages,
			Tools:     toolSchemas,
			System:    system,
			MaxTokens: 4096,
		})
		if err != nil {
			return "", trace, fmt.Errorf("API call failed: %w", err)
		}

		trace.TotalTokens += resp.Usage.InputTokens + resp.Usage.OutputTokens
		messages = append(messages, resp.ToAssistantMessage())

		if resp.StopReason == "end_turn" {
			for _, block := range resp.Content {
				if block.Type == BlockText && strings.TrimSpace(block.Text) != "" {
					answer := strings.TrimSpace(block.Text)
					trace.Steps = append(trace.Steps, Step{Type: StepAnswer, Content: answer})
					trace.ElapsedMS = time.Since(start).Milliseconds()
					return answer, trace, nil
				}
			}
		}

		if resp.StopReason == "tool_use" {
			var toolResults []interface{}

			for _, block := range resp.Content {
				if block.Type != BlockToolUse {
					continue
				}

				name  := block.Name
				id    := block.ID
				input := block.Input

				if name == "think" {
					reasoning, _ := input["reasoning"].(string)
					step := Step{Type: StepThought, Content: reasoning}
					trace.Steps = append(trace.Steps, step)
					if opts.OnStep != nil {
						opts.OnStep(step)
					}
					fmt.Fprintf(os.Stderr, "[react] 💭 %s\n", truncateStr(reasoning, 200))
					toolResults = append(toolResults, map[string]interface{}{
						"type": "tool_result", "tool_use_id": id, "content": "OK",
					})
					continue
				}

				if name == "finish" {
					answer, _ := input["answer"].(string)
					trace.Steps = append(trace.Steps, Step{Type: StepAnswer, Content: answer})
					trace.ElapsedMS = time.Since(start).Milliseconds()
					fmt.Fprintf(os.Stderr, "[react] DONE — %d iters, %d tokens, %dms\n",
						trace.Iterations, trace.TotalTokens, trace.ElapsedMS)
					return answer, trace, nil
				}

				inputMap := make(map[string]interface{})
				for k, v := range input {
					inputMap[k] = v
				}
				step := Step{Type: StepAction, Tool: name, Input: inputMap}
				trace.Steps = append(trace.Steps, step)
				if opts.OnStep != nil {
					opts.OnStep(step)
				}
				inJSON, _ := json.Marshal(input)
				fmt.Fprintf(os.Stderr, "[react] ⚡ %s(%s)\n", name, truncateStr(string(inJSON), 200))

				fn, ok := GoToolRegistry[name]
				var result string
				isError := false
				if !ok {
					result = fmt.Sprintf("Tool '%s' not registered", name)
					isError = true
				} else {
					result, err = fn(inputMap)
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
				fmt.Fprintf(os.Stderr, "[react] 👁 %s\n", truncateStr(result, 200))

				toolResults = append(toolResults, map[string]interface{}{
					"type":        "tool_result",
					"tool_use_id": id,
					"content":     result,
					"is_error":    isError,
				})
			}

			messages = append(messages, map[string]interface{}{
				"role": "user", "content": toolResults,
			})
			continue
		}

		fmt.Fprintf(os.Stderr, "[react] unexpected stop_reason: %s\n", resp.StopReason)
		break
	}

	trace.ElapsedMS = time.Since(start).Milliseconds()
	return "", trace, fmt.Errorf("ReAct loop did not finish within %d iterations (tokens: %d)",
		opts.MaxIterations, trace.TotalTokens)
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// ── CLI entry point ────────────────────────────────────────────────────────────
func ReactLoopDemo() {
	task := strings.Join(os.Args[1:], " ")
	if task == "" {
		task = "Calculate the 47th Fibonacci number using bash, then explain the result."
	}

	answer, trace, err := RunReact(context.Background(), task, ReactOptions{
		OnStep: func(step Step) {
			switch step.Type {
			case StepThought:
				fmt.Printf("\n💭 THOUGHT: %s\n", truncateStr(step.Content, 300))
			case StepAction:
				inp, _ := json.Marshal(step.Input)
				fmt.Printf("\n⚡ ACTION: %s(%s)\n", step.Tool, truncateStr(string(inp), 200))
			case StepObservation:
				marker := "👁"
				if step.Error {
					marker = "❌"
				}
				fmt.Printf("\n%s OBSERVE: %s\n", marker, truncateStr(step.Content, 300))
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
	fmt.Printf("Iterations: %d | Tokens: %d | Time: %dms\n",
		trace.Iterations, trace.TotalTokens, trace.ElapsedMS)
	out, _ := json.MarshalIndent(trace.Steps, "", "  ")
	fmt.Printf("\nFull trace:\n%s\n", string(out))
}
