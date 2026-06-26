// Eval Harness — Go
// Measures retrieval quality: Precision@K, Recall@K, MRR, NDCG@K.
//
// go run ./src/... -eval

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
)

// ── Types ──────────────────────────────────────────────────────────────────────
type EvalCase struct {
	Query       string
	RelevantIDs map[string]bool
	Description string
}

type EvalResult struct {
	Query          string
	PrecisionAtK   float64
	RecallAtK      float64
	ReciprocalRank float64
	NDCGAtK        float64
	RetrievedIDs   []string
}

type EvalReport struct {
	TopK          int
	NumCases      int
	MeanPrecision float64
	MeanRecall    float64
	MeanMRR       float64
	MeanNDCG      float64
	PerCase       []EvalResult
}

// ── Metrics ────────────────────────────────────────────────────────────────────
func precisionAtK(retrieved []string, relevant map[string]bool, k int) float64 {
	if k == 0 {
		return 0
	}
	hits := 0
	for _, id := range retrieved[:min(k, len(retrieved))] {
		if relevant[id] {
			hits++
		}
	}
	return float64(hits) / float64(k)
}

func recallAtK(retrieved []string, relevant map[string]bool, k int) float64 {
	if len(relevant) == 0 {
		return 0
	}
	hits := 0
	for _, id := range retrieved[:min(k, len(retrieved))] {
		if relevant[id] {
			hits++
		}
	}
	return float64(hits) / float64(len(relevant))
}

func reciprocalRank(retrieved []string, relevant map[string]bool) float64 {
	for i, id := range retrieved {
		if relevant[id] {
			return 1.0 / float64(i+1)
		}
	}
	return 0
}

func ndcgAtK(retrieved []string, relevant map[string]bool, k int) float64 {
	dcg := func(ids []string) float64 {
		score := 0.0
		for i, id := range ids[:min(k, len(ids))] {
			if relevant[id] {
				score += 1.0 / math.Log2(float64(i+2))
			}
		}
		return score
	}
	actual := dcg(retrieved)
	// Build ideal: relevant docs first
	ideal := make([]string, 0, k)
	for id := range relevant {
		ideal = append(ideal, id)
		if len(ideal) >= k {
			break
		}
	}
	idealDCG := dcg(ideal)
	if idealDCG == 0 {
		return 0
	}
	return actual / idealDCG
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ── Evaluator ──────────────────────────────────────────────────────────────────
type RAGEvaluator struct {
	engine *RAGEngine
	topK   int
}

func NewRAGEvaluator(engine *RAGEngine, topK int) *RAGEvaluator {
	return &RAGEvaluator{engine: engine, topK: topK}
}

func (e *RAGEvaluator) EvaluateCase(ctx context.Context, c EvalCase) EvalResult {
	chunks, _ := e.engine.Retrieve(ctx, c.Query, e.topK)
	ids := make([]string, len(chunks))
	for i, ch := range chunks {
		ids[i] = ch.DocID
	}
	return EvalResult{
		Query:          c.Query,
		PrecisionAtK:   precisionAtK(ids, c.RelevantIDs, e.topK),
		RecallAtK:      recallAtK(ids, c.RelevantIDs, e.topK),
		ReciprocalRank: reciprocalRank(ids, c.RelevantIDs),
		NDCGAtK:        ndcgAtK(ids, c.RelevantIDs, e.topK),
		RetrievedIDs:   ids,
	}
}

func (e *RAGEvaluator) Evaluate(ctx context.Context, cases []EvalCase) EvalReport {
	results := make([]EvalResult, len(cases))
	for i, c := range cases {
		results[i] = e.EvaluateCase(ctx, c)
	}
	n := float64(len(results))
	if n == 0 {
		return EvalReport{TopK: e.topK}
	}
	var sumP, sumR, sumMRR, sumNDCG float64
	for _, r := range results {
		sumP   += r.PrecisionAtK
		sumR   += r.RecallAtK
		sumMRR += r.ReciprocalRank
		sumNDCG += r.NDCGAtK
	}
	return EvalReport{
		TopK:          e.topK,
		NumCases:      len(results),
		MeanPrecision: sumP / n,
		MeanRecall:    sumR / n,
		MeanMRR:       sumMRR / n,
		MeanNDCG:      sumNDCG / n,
		PerCase:       results,
	}
}

func (r *EvalReport) Print() {
	fmt.Println("\n" + "="+string(rune('=')) + "===========================================")
	fmt.Printf("RAG Eval Report (Go)  top_k=%d  n=%d\n", r.TopK, r.NumCases)
	fmt.Println("==============================================")
	fmt.Printf("  Mean Precision@%d: %.4f\n", r.TopK, r.MeanPrecision)
	fmt.Printf("  Mean Recall@%d:    %.4f\n", r.TopK, r.MeanRecall)
	fmt.Printf("  Mean MRR:          %.4f\n", r.MeanMRR)
	fmt.Printf("  Mean NDCG@%d:      %.4f\n", r.TopK, r.MeanNDCG)
	fmt.Println()
	for _, res := range r.PerCase {
		status := "✅"
		if res.PrecisionAtK == 0 {
			status = "❌"
		}
		fmt.Printf("  %s [P=%.2f R=%.2f MRR=%.2f]  %s\n",
			status, res.PrecisionAtK, res.RecallAtK, res.ReciprocalRank, truncateStr(res.Query, 60))
	}
	fmt.Println()
}

// ── Demo data ──────────────────────────────────────────────────────────────────
var evalDemoDocs = []*Document{
	{Content: "Claude is an AI assistant made by Anthropic.", Metadata: map[string]string{"source": "anthropic"}},
	{Content: "RAG combines retrieval with generation to ground LLM answers in real documents.", Metadata: map[string]string{"source": "rag_paper"}},
	{Content: "Qdrant is a high-performance vector database written in Rust.", Metadata: map[string]string{"source": "qdrant"}},
	{Content: "Voyage AI provides state-of-the-art embedding and reranking models.", Metadata: map[string]string{"source": "voyage"}},
	{Content: "Go is a statically typed compiled language designed at Google for simplicity and concurrency.", Metadata: map[string]string{"source": "go_docs"}},
}

func runEval(ctx context.Context, topK int) {
	engine, err := NewRAGEngine("eval_go")
	if err != nil {
		fmt.Fprintf(os.Stderr, "eval: engine init failed: %v\n", err)
		os.Exit(1)
	}

	_, err = engine.Ingest(ctx, evalDemoDocs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "eval: ingest failed: %v\n", err)
		os.Exit(1)
	}

	cases := make([]EvalCase, len(evalDemoDocs))
	for i, doc := range evalDemoDocs {
		cases[i] = EvalCase{
			Query:       "Tell me about " + doc.Metadata["source"],
			RelevantIDs: map[string]bool{doc.DocID: true},
			Description: doc.Metadata["source"],
		}
	}

	evaluator := NewRAGEvaluator(engine, topK)
	report := evaluator.Evaluate(ctx, cases)
	report.Print()

	out, _ := json.MarshalIndent(report, "", "  ")
	fmt.Println(string(out))
}
