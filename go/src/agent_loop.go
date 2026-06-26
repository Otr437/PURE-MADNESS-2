// Plug-and-play Agentic Loop — Go
// Multi-provider via ModelRouter (Claude / DeepSeek / OpenAI).
// All tools are real implementations wired to the shared GoToolRegistry.
// No stubs. No hardcoded API clients.
//
// export MODEL_PROVIDER=anthropic|deepseek|openai
// export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
// go run ./src/... agent -task "your question"

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// AgentLoop is a minimal single-shot agentic loop built on ModelRouter + GoToolRegistry.
// For multi-step ReAct behaviour, use RunReact() in react_loop.go instead.
func AgentLoop(ctx context.Context, userMessage string, maxIterations int, systemPrompt string) (string, error) {
	router, err := NewModelRouter("", "")
	if err != nil {
		return "", fmt.Errorf("agent_loop: model router init: %w", err)
	}

	messages := []map[string]interface{}{
		{"role": "user", "content": userMessage},
	}

	for i := 0; i < maxIterations; i++ {
		resp, err := router.Create(ctx, CreateOptions{
			Messages:  messages,
			Tools:     GoToolSchemas,
			System:    systemPrompt,
			MaxTokens: 4096,
		})
		if err != nil {
			return "", fmt.Errorf("agent_loop iteration %d: %w", i+1, err)
		}

		messages = append(messages, resp.ToAssistantMessage())

		if resp.StopReason == "end_turn" {
			for _, block := range resp.Content {
				if block.Type == BlockText && strings.TrimSpace(block.Text) != "" {
					return strings.TrimSpace(block.Text), nil
				}
			}
		}

		if resp.StopReason == "tool_use" {
			var toolResults []interface{}
			for _, block := range resp.Content {
				if block.Type != BlockToolUse {
					continue
				}
				if block.Name == "finish" {
					if answer, ok := block.Input["answer"].(string); ok {
						return answer, nil
					}
				}
				fn, ok := GoToolRegistry[block.Name]
				var result string
				isError := false
				if !ok {
					result = fmt.Sprintf("Tool '%s' is not registered", block.Name)
					isError = true
				} else {
					result, err = fn(block.Input)
					if err != nil {
						result = fmt.Sprintf("Tool error (%s): %v", block.Name, err)
						isError = true
					}
				}
				inp, _ := json.Marshal(block.Input)
				fmt.Fprintf(os.Stderr, "[agent] ⚡ %s(%s) → %s\n",
					block.Name, truncateStr(string(inp), 120), truncateStr(result, 120))
				toolResults = append(toolResults, map[string]interface{}{
					"type":        "tool_result",
					"tool_use_id": block.ID,
					"content":     result,
					"is_error":    isError,
				})
			}
			messages = append(messages, map[string]interface{}{
				"role":    "user",
				"content": toolResults,
			})
			continue
		}

		fmt.Fprintf(os.Stderr, "[agent] unexpected stop_reason=%s — stopping\n", resp.StopReason)
		break
	}

	return "", fmt.Errorf("AgentLoop: did not finish within %d iterations", maxIterations)
}

// AgentLoopDemo runs a demo task using the full production AgentLoop.
func AgentLoopDemo() {
	ctx := context.Background()
	task := "Use bash to find the current date and time, then report it."
	fmt.Fprintf(os.Stderr, "[agent_loop_demo] task: %s\n", task)
	answer, err := AgentLoop(ctx, task, 10, "You are a helpful assistant. Use the provided tools to complete tasks.")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[agent_loop_demo] error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(answer)
}
