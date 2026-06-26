// Model Router — Go
// Unified multi-provider chat-completion client for Claude, DeepSeek, and OpenAI.
//
// go get github.com/anthropics/anthropic-sdk-go@v1.4.0
// export MODEL_PROVIDER=anthropic|deepseek|openai
// export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// ── Types ──────────────────────────────────────────────────────────────────────
type ContentBlockType string

const (
	BlockText    ContentBlockType = "text"
	BlockToolUse ContentBlockType = "tool_use"
)

type TextBlock struct {
	Type ContentBlockType `json:"type"`
	Text string           `json:"text"`
}

type ToolUseBlock struct {
	Type  ContentBlockType       `json:"type"`
	ID    string                 `json:"id"`
	Name  string                 `json:"name"`
	Input map[string]interface{} `json:"input"`
}

type ContentBlock struct {
	Type  ContentBlockType       `json:"type"`
	Text  string                 `json:"text,omitempty"`
	ID    string                 `json:"id,omitempty"`
	Name  string                 `json:"name,omitempty"`
	Input map[string]interface{} `json:"input,omitempty"`
}

type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

type UnifiedResponse struct {
	Content    []ContentBlock
	StopReason string
	Usage      Usage
}

func (r *UnifiedResponse) ToAssistantMessage() map[string]interface{} {
	blocks := make([]interface{}, 0, len(r.Content))
	for _, b := range r.Content {
		if b.Type == BlockText {
			blocks = append(blocks, map[string]interface{}{"type": "text", "text": b.Text})
		} else if b.Type == BlockToolUse {
			blocks = append(blocks, map[string]interface{}{"type": "tool_use", "id": b.ID, "name": b.Name, "input": b.Input})
		}
	}
	return map[string]interface{}{"role": "assistant", "content": blocks}
}

// ── Default models ─────────────────────────────────────────────────────────────
var defaultModels = map[string]string{
	"anthropic":       "claude-opus-4-6",
	"deepseek":        "deepseek-v4-pro",
	"openai":          "gpt-5.5",
}

// ── Model Router ───────────────────────────────────────────────────────────────
type ModelRouter struct {
	Provider string
	Model    string
	baseURL  string
	apiKey   string
	client   *http.Client
}

func NewModelRouter(provider, model string) (*ModelRouter, error) {
	if provider == "" {
		provider = os.Getenv("MODEL_PROVIDER")
		if provider == "" {
			provider = "anthropic"
		}
	}
	if model == "" {
		model = os.Getenv("MODEL_NAME")
		if model == "" {
			var ok bool
			if model, ok = defaultModels[provider]; !ok {
				return nil, fmt.Errorf("unknown MODEL_PROVIDER '%s'", provider)
			}
		}
	}
	var baseURL, apiKey string
	switch provider {
	case "anthropic":
		baseURL = "https://api.anthropic.com"
		apiKey  = os.Getenv("ANTHROPIC_API_KEY")
	case "deepseek":
		baseURL = "https://api.deepseek.com/anthropic"
		apiKey  = os.Getenv("DEEPSEEK_API_KEY")
	case "openai":
		baseURL = "https://api.openai.com"
		apiKey  = os.Getenv("OPENAI_API_KEY")
	default:
		return nil, fmt.Errorf("unknown MODEL_PROVIDER '%s'", provider)
	}
	return &ModelRouter{
		Provider: provider,
		Model:    model,
		baseURL:  baseURL,
		apiKey:   apiKey,
		client:   &http.Client{Timeout: 90 * time.Second},
	}, nil
}

type CreateOptions struct {
	Messages  []map[string]interface{}
	Tools     []map[string]interface{}
	System    string
	MaxTokens int
}

func (r *ModelRouter) Create(ctx context.Context, opts CreateOptions) (*UnifiedResponse, error) {
	if opts.MaxTokens == 0 {
		opts.MaxTokens = 4096
	}
	switch r.Provider {
	case "anthropic", "deepseek":
		return r.createAnthropic(ctx, opts)
	case "openai":
		return r.createOpenAI(ctx, opts)
	}
	return nil, fmt.Errorf("unsupported provider: %s", r.Provider)
}

// ── Anthropic-format request ───────────────────────────────────────────────────
type anthropicRequest struct {
	Model     string                   `json:"model"`
	MaxTokens int                      `json:"max_tokens"`
	Messages  []map[string]interface{} `json:"messages"`
	System    string                   `json:"system,omitempty"`
	Tools     []map[string]interface{} `json:"tools,omitempty"`
}

type anthropicResponse struct {
	Content    []ContentBlock `json:"content"`
	StopReason string         `json:"stop_reason"`
	Usage      Usage          `json:"usage"`
}

func (r *ModelRouter) createAnthropic(ctx context.Context, opts CreateOptions) (*UnifiedResponse, error) {
	body := anthropicRequest{
		Model:     r.Model,
		MaxTokens: opts.MaxTokens,
		Messages:  opts.Messages,
		System:    opts.System,
		Tools:     opts.Tools,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/v1/messages", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", r.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respData, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("anthropic API %d: %s", resp.StatusCode, string(respData))
	}
	var ar anthropicResponse
	if err := json.Unmarshal(respData, &ar); err != nil {
		return nil, err
	}
	return &UnifiedResponse{Content: ar.Content, StopReason: ar.StopReason, Usage: ar.Usage}, nil
}

// ── OpenAI-format request ──────────────────────────────────────────────────────
type openAIMessage struct {
	Role      string      `json:"role"`
	Content   interface{} `json:"content"`
	ToolCalls interface{} `json:"tool_calls,omitempty"`
}

type openAIRequest struct {
	Model     string                   `json:"model"`
	MaxTokens int                      `json:"max_tokens"`
	Messages  []openAIMessage          `json:"messages"`
	Tools     []map[string]interface{} `json:"tools,omitempty"`
}

func (r *ModelRouter) createOpenAI(ctx context.Context, opts CreateOptions) (*UnifiedResponse, error) {
	var messages []openAIMessage
	if opts.System != "" {
		messages = append(messages, openAIMessage{Role: "system", Content: opts.System})
	}
	for _, m := range opts.Messages {
		messages = append(messages, openAIMessage{Role: m["role"].(string), Content: m["content"]})
	}
	var oaTools []map[string]interface{}
	for _, t := range opts.Tools {
		oaTools = append(oaTools, map[string]interface{}{
			"type": "function",
			"function": map[string]interface{}{
				"name":        t["name"],
				"description": t["description"],
				"parameters":  t["input_schema"],
			},
		})
	}
	body := openAIRequest{Model: r.Model, MaxTokens: opts.MaxTokens, Messages: messages, Tools: oaTools}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.baseURL+"/v1/chat/completions", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.apiKey)

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respData, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openai API %d: %s", resp.StatusCode, string(respData))
	}
	var result struct {
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(respData, &result); err != nil {
		return nil, err
	}
	if len(result.Choices) == 0 {
		return nil, fmt.Errorf("no choices in OpenAI response")
	}
	choice := result.Choices[0]
	var content []ContentBlock
	if choice.Message.Content != "" {
		content = append(content, ContentBlock{Type: BlockText, Text: choice.Message.Content})
	}
	stopReason := "end_turn"
	for _, tc := range choice.Message.ToolCalls {
		var input map[string]interface{}
		_ = json.Unmarshal([]byte(tc.Function.Arguments), &input)
		content = append(content, ContentBlock{Type: BlockToolUse, ID: tc.ID, Name: tc.Function.Name, Input: input})
		stopReason = "tool_use"
	}
	return &UnifiedResponse{
		Content:    content,
		StopReason: stopReason,
		Usage:      Usage{InputTokens: result.Usage.PromptTokens, OutputTokens: result.Usage.CompletionTokens},
	}, nil
}

// ── Tool result message ────────────────────────────────────────────────────────
func MakeToolResultMessage(toolUseID, content string, isError bool) map[string]interface{} {
	block := map[string]interface{}{
		"type":        "tool_result",
		"tool_use_id": toolUseID,
		"content":     content,
	}
	if isError {
		block["is_error"] = true
	}
	return map[string]interface{}{"role": "user", "content": []interface{}{block}}
}
