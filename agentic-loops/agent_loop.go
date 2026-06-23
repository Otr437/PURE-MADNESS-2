// Plug-and-play Agentic Loop — Go
// Requires: go get github.com/anthropics/anthropic-sdk-go
// Set: ANTHROPIC_API_KEY env var

package main

import (
	"context"
	"fmt"
	"os"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// ── Define your tools here ────────────────────────────────────────────────────
var tools = []anthropic.ToolParam{
	{
		Name:        "get_weather",
		Description: anthropic.String("Get the current weather for a city."),
		InputSchema: anthropic.ToolInputSchemaParam{
			Properties: anthropic.F[interface{}](map[string]interface{}{
				"city": map[string]string{
					"type":        "string",
					"description": "City name",
				},
			}),
		},
	},
}

func executeTool(name string, input map[string]interface{}) string {
	switch name {
	case "get_weather":
		city, _ := input["city"].(string)
		return fmt.Sprintf("The weather in %s is 72°F and sunny.", city) // stub
	}
	return "Unknown tool"
}

// ── The loop ──────────────────────────────────────────────────────────────────
func runAgent(userMessage string, maxIterations int) (string, error) {
	client := anthropic.NewClient(option.WithAPIKey(os.Getenv("ANTHROPIC_API_KEY")))
	ctx := context.Background()

	messages := []anthropic.MessageParam{
		anthropic.NewUserMessage(anthropic.NewTextBlock(userMessage)),
	}

	for i := 0; i < maxIterations; i++ {
		response, err := client.Messages.New(ctx, anthropic.MessageNewParams{
			Model:     anthropic.F(anthropic.ModelClaudeOpus46),
			MaxTokens: anthropic.F(int64(1024)),
			Tools:     anthropic.F(tools),
			Messages:  anthropic.F(messages),
		})
		if err != nil {
			return "", err
		}

		// Append assistant response
		messages = append(messages, response.ToParam())

		if response.StopReason == anthropic.StopReasonEndTurn {
			for _, block := range response.Content {
				if block.Type == anthropic.ContentBlockTypeText {
					return block.Text, nil
				}
			}
		}

		if response.StopReason == anthropic.StopReasonToolUse {
			var toolResults []anthropic.ContentBlockParamUnion
			for _, block := range response.Content {
				if block.Type == anthropic.ContentBlockTypeToolUse {
					input, _ := block.Input.(map[string]interface{})
					result := executeTool(block.Name, input)
					fmt.Printf("[Tool] %s → %s\n", block.Name, result)
					toolResults = append(toolResults, anthropic.NewToolResultBlock(block.ID, result, false))
				}
			}
			messages = append(messages, anthropic.NewUserMessage(toolResults...))
		}
	}

	return "Max iterations reached.", nil
}

func main() {
	result, err := runAgent("What's the weather like in Tokyo?", 10)
	if err != nil {
		panic(err)
	}
	fmt.Println(result)
}
