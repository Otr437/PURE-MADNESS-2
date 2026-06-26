// RAG Agent — Go
// Wires RAGEngine (hybrid search, reranking, citations) + document loaders
// into the multi-provider ReAct loop.
//
// export MODEL_PROVIDER=anthropic|deepseek|openai
// export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
// export VOYAGE_API_KEY=...
// export QDRANT_URL=localhost:6333
//
// go run ./src/... -task "your question"
// go run ./src/... -dir ./mydocs -task "your question"

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	pb "github.com/qdrant/go-client/qdrant"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const ragAgentSystemPrompt = `You have access to a 'rag_search' tool that searches a knowledge base of ingested documents using hybrid retrieval with reranking. Results include citation markers.
Use rag_search to find relevant context before answering factual questions.
Always search first, reason second, then answer. Cite retrieved passages using the citation markers provided.`

func ingestAndRunAgent(ctx context.Context, docs []*Document, task string, systemExtra string, maxIterations int, verbose bool) (string, *Trace, error) {
	// Wire RAG tool into tool registry
	qdrantURL := os.Getenv("QDRANT_URL")
	if qdrantURL == "" {
		qdrantURL = "localhost:6333"
	}
	conn, err := grpc.NewClient(qdrantURL, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return "", nil, fmt.Errorf("qdrant connect: %w", err)
	}
	defer conn.Close()

	engine, err := NewRAGEngine("default")
	if err != nil {
		return "", nil, fmt.Errorf("rag engine init: %w", err)
	}

	if len(docs) > 0 {
		count, err := engine.Ingest(ctx, docs)
		if err != nil {
			return "", nil, fmt.Errorf("ingest: %w", err)
		}
		fmt.Fprintf(os.Stderr, "[rag-agent] Ingested %d docs → %d chunks\n", len(docs), count)
	}

	// Register rag_search tool
	GoToolSchemas = append(GoToolSchemas, map[string]interface{}{
		"name":        "rag_search",
		"description": "Search the knowledge base for context relevant to a query. Returns the top matching passages.",
		"input_schema": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"query": map[string]interface{}{"type": "string"},
				"top_k": map[string]interface{}{"type": "integer"},
			},
			"required": []string{"query"},
		},
	})
	GoToolRegistry["rag_search"] = func(input map[string]interface{}) (string, error) {
		query, _ := input["query"].(string)
		topK := 5
		if v, ok := input["top_k"].(float64); ok {
			topK = int(v)
		}
		return engine.RetrieveAsContext(ctx, query, topK)
	}

	combined := ragAgentSystemPrompt
	if systemExtra != "" {
		combined += "\n\n" + systemExtra
	}

	var onStep func(Step)
	if verbose {
		onStep = func(step Step) {
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
		}
	}

	return RunReact(ctx, task, ReactOptions{
		SystemExtra:   combined,
		MaxIterations: maxIterations,
		OnStep:        onStep,
	})
}

// ── CLI ────────────────────────────────────────────────────────────────────────
func runAgentCLI() {
	args := os.Args[1:]
	task := ""
	dir := ""
	maxIter := 30
	verbose := true

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-task", "--task":
			if i+1 < len(args) {
				task = args[i+1]; i++
			}
		case "-dir", "--dir":
			if i+1 < len(args) {
				dir = args[i+1]; i++
			}
		case "-max-iterations", "--max-iterations":
			if i+1 < len(args) {
				fmt.Sscanf(args[i+1], "%d", &maxIter); i++
			}
		case "-quiet", "--quiet":
			verbose = false
		}
	}

	if task == "" {
		task = "Explain how the ReAct pattern works and how it relates to RAG."
	}

	var docs []*Document
	if dir != "" {
		var err error
		docs, err = LoadDirectory(dir, true)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[rag-agent] load directory error: %v\n", err)
			os.Exit(1)
		}
	} else {
		// Built-in demo docs
		docs = []*Document{
			{Content: "Claude is an AI assistant made by Anthropic, designed to be helpful, harmless, and honest.", Metadata: map[string]string{"source": "anthropic_docs"}},
			{Content: "RAG (Retrieval-Augmented Generation) combines retrieval with generation to ground LLM answers in real documents.", Metadata: map[string]string{"source": "rag_survey"}},
			{Content: "Qdrant is a high-performance vector database written in Rust, supporting cosine, dot product, and Euclidean distance.", Metadata: map[string]string{"source": "qdrant_docs"}},
		}
	}

	ctx := context.Background()
	answer, trace, err := ingestAndRunAgent(ctx, docs, task, "", maxIter, verbose)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("\n" + strings.Repeat("=", 64))
	fmt.Println("FINAL ANSWER")
	fmt.Println(strings.Repeat("=", 64))
	fmt.Println(answer)
	fmt.Println(strings.Repeat("=", 64))
	fmt.Printf("Iterations: %d | Tokens: %d | Time: %dms\n",
		trace.Iterations, trace.TotalTokens, trace.ElapsedMS)
}
