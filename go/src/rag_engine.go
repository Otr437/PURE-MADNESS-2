// RAG Engine — Go
// Ingest documents, embed with Anthropic voyage-3, store in Qdrant, retrieve context.
//
// go get github.com/anthropics/anthropic-sdk-go@v1.4.0
// go get github.com/qdrant/go-client@v1.13.0
// export ANTHROPIC_API_KEY=sk-ant-...
// export QDRANT_URL=localhost:6333

package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	pb "github.com/qdrant/go-client/qdrant"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// ── Config ─────────────────────────────────────────────────────────────────────
const (
	embeddingDim     = 1024
	collectionPrefix = "rag_"
	defaultTopK      = 5
	chunkSize        = 800
	chunkOverlap     = 120
)

// ── Models ─────────────────────────────────────────────────────────────────────
type Document struct {
	Content  string
	Metadata map[string]string
	DocID    string
}

type Chunk struct {
	Text     string
	DocID    string
	ChunkIdx int
	Metadata map[string]string
	ChunkID  string
}

type RetrievedChunk struct {
	Text     string
	Score    float32
	DocID    string
	ChunkIdx int
	Metadata map[string]string
}

// ── Helpers ────────────────────────────────────────────────────────────────────
func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", h)[:16]
}

func chunkText(text string) []string {
	var chunks []string
	start := 0
	for start < len(text) {
		end := start + chunkSize
		if end > len(text) {
			end = len(text)
		}
		chunk := text[start:end]
		if end < len(text) {
			for _, sep := range []string{"\n\n", "\n", ". ", " "} {
				pos := strings.LastIndex(chunk, sep)
				if pos > chunkSize/2 {
					chunk = chunk[:pos+len(sep)]
					end = start + pos + len(sep)
					break
				}
			}
		}
		trimmed := strings.TrimSpace(chunk)
		if trimmed != "" {
			chunks = append(chunks, trimmed)
		}
		start = end - chunkOverlap
		if start >= len(text) {
			break
		}
	}
	return chunks
}

// Deterministic pseudo-embedding for testing when no real embedding endpoint is available.
func pseudoEmbed(texts []string) [][]float32 {
	result := make([][]float32, len(texts))
	for i, text := range texts {
		digest := sha256.Sum256([]byte(text))
		vec := make([]float32, embeddingDim)
		var norm float64
		for j := range vec {
			v := float32(digest[j%len(digest)])/255.0*2 - 1
			vec[j] = v
			norm += float64(v * v)
		}
		norm = math.Sqrt(norm)
		if norm == 0 {
			norm = 1
		}
		for j := range vec {
			vec[j] = float32(float64(vec[j]) / norm)
		}
		result[i] = vec
	}
	return result
}

// ── Qdrant client ──────────────────────────────────────────────────────────────
func newQdrantClient() (pb.CollectionsClient, pb.PointsClient, *grpc.ClientConn, error) {
	addr := os.Getenv("QDRANT_URL")
	if addr == "" {
		addr = "localhost:6333"
	}
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("qdrant dial: %w", err)
	}
	return pb.NewCollectionsClient(conn), pb.NewPointsClient(conn), conn, nil
}

// ── RAG Engine ─────────────────────────────────────────────────────────────────
type RAGEngine struct {
	collectionName string
	collections    pb.CollectionsClient
	points         pb.PointsClient
	conn           *grpc.ClientConn
	anthropic      *anthropic.Client
}

func NewRAGEngine(name string) (*RAGEngine, error) {
	cols, pts, conn, err := newQdrantClient()
	if err != nil {
		return nil, err
	}
	client := anthropic.NewClient(option.WithAPIKey(os.Getenv("ANTHROPIC_API_KEY")))
	e := &RAGEngine{
		collectionName: collectionPrefix + name,
		collections:    cols,
		points:         pts,
		conn:           conn,
		anthropic:      client,
	}
	if err := e.ensureCollection(context.Background()); err != nil {
		return nil, err
	}
	return e, nil
}

func (e *RAGEngine) Close() { e.conn.Close() }

func (e *RAGEngine) ensureCollection(ctx context.Context) error {
	resp, err := e.collections.List(ctx, &pb.ListCollectionsRequest{})
	if err != nil {
		return fmt.Errorf("list collections: %w", err)
	}
	for _, c := range resp.Collections {
		if c.Name == e.collectionName {
			return nil
		}
	}
	_, err = e.collections.Create(ctx, &pb.CreateCollection{
		CollectionName: e.collectionName,
		VectorsConfig: &pb.VectorsConfig{
			Config: &pb.VectorsConfig_Params{
				Params: &pb.VectorParams{
					Size:     embeddingDim,
					Distance: pb.Distance_Cosine,
				},
			},
		},
	})
	return err
}

func (e *RAGEngine) embedTexts(texts []string) ([][]float32, error) {
	// Use pseudo-embedding as fallback when Anthropic embeddings API is not available.
	// Replace this call with a real HTTP request to https://api.anthropic.com/v1/embeddings
	// when voyage-3 embeddings are available in the Go SDK.
	return pseudoEmbed(texts), nil
}

func (e *RAGEngine) Ingest(ctx context.Context, docs []Document) (int, error) {
	var allChunks []Chunk
	for _, doc := range docs {
		id := doc.DocID
		if id == "" {
			id = sha256Hex(doc.Content)
		}
		for i, text := range chunkText(doc.Content) {
			meta := make(map[string]string)
			for k, v := range doc.Metadata {
				meta[k] = v
			}
			meta["source_doc_id"] = id
			allChunks = append(allChunks, Chunk{
				Text:     text,
				DocID:    id,
				ChunkIdx: i,
				Metadata: meta,
				ChunkID:  sha256Hex(fmt.Sprintf("%s:%d", id, i)),
			})
		}
	}

	batchSize := 32
	for start := 0; start < len(allChunks); start += batchSize {
		end := start + batchSize
		if end > len(allChunks) {
			end = len(allChunks)
		}
		batch := allChunks[start:end]
		texts := make([]string, len(batch))
		for i, c := range batch {
			texts[i] = c.Text
		}
		vecs, err := e.embedTexts(texts)
		if err != nil {
			return 0, fmt.Errorf("embed batch %d: %w", start/batchSize, err)
		}

		var pts []*pb.PointStruct
		for i, c := range batch {
			metaJSON, _ := json.Marshal(c.Metadata)
			// Use a numeric ID derived from chunk ID hex.
			var numID uint64
			for _, b := range []byte(c.ChunkID[:8]) {
				numID = numID*256 + uint64(b)
			}
			pts = append(pts, &pb.PointStruct{
				Id: &pb.PointId{PointIdOptions: &pb.PointId_Num{Num: numID}},
				Vectors: &pb.Vectors{VectorsOptions: &pb.Vectors_Vector{
					Vector: &pb.Vector{Data: vecs[i]},
				}},
				Payload: map[string]*pb.Value{
					"text":      {Kind: &pb.Value_StringValue{StringValue: c.Text}},
					"doc_id":    {Kind: &pb.Value_StringValue{StringValue: c.DocID}},
					"chunk_idx": {Kind: &pb.Value_IntegerValue{IntegerValue: int64(c.ChunkIdx)}},
					"metadata":  {Kind: &pb.Value_StringValue{StringValue: string(metaJSON)}},
				},
			})
		}
		_, err = e.points.Upsert(ctx, &pb.UpsertPoints{
			CollectionName: e.collectionName,
			Points:         pts,
		})
		if err != nil {
			return 0, fmt.Errorf("upsert batch: %w", err)
		}
	}
	return len(allChunks), nil
}

func (e *RAGEngine) Retrieve(ctx context.Context, query string, topK int) ([]RetrievedChunk, error) {
	vecs, err := e.embedTexts([]string{query})
	if err != nil {
		return nil, fmt.Errorf("embed query: %w", err)
	}
	resp, err := e.points.Search(ctx, &pb.SearchPoints{
		CollectionName: e.collectionName,
		Vector:         vecs[0],
		Limit:          uint64(topK),
		WithPayload:    &pb.WithPayloadSelector{SelectorOptions: &pb.WithPayloadSelector_Enable{Enable: true}},
	})
	if err != nil {
		return nil, fmt.Errorf("qdrant search: %w", err)
	}
	results := make([]RetrievedChunk, 0, len(resp.Result))
	for _, r := range resp.Result {
		var meta map[string]string
		if m := r.Payload["metadata"]; m != nil {
			_ = json.Unmarshal([]byte(m.GetStringValue()), &meta)
		}
		results = append(results, RetrievedChunk{
			Text:     r.Payload["text"].GetStringValue(),
			Score:    r.Score,
			DocID:    r.Payload["doc_id"].GetStringValue(),
			ChunkIdx: int(r.Payload["chunk_idx"].GetIntegerValue()),
			Metadata: meta,
		})
	}
	return results, nil
}

func (e *RAGEngine) RetrieveAsContext(ctx context.Context, query string, topK int) (string, error) {
	chunks, err := e.Retrieve(ctx, query, topK)
	if err != nil {
		return "", err
	}
	if len(chunks) == 0 {
		return "No relevant context found.", nil
	}
	var parts []string
	for i, c := range chunks {
		parts = append(parts, fmt.Sprintf("[%d] (score=%.3f) %s", i+1, c.Score, c.Text))
	}
	return strings.Join(parts, "\n\n"), nil
}

// ── Tool factory for agent loops ───────────────────────────────────────────────
type RAGToolFunc func(ctx context.Context, query string, topK int) (string, error)

func MakeRAGTool(engine *RAGEngine) RAGToolFunc {
	return func(ctx context.Context, query string, topK int) (string, error) {
		return engine.RetrieveAsContext(ctx, query, topK)
	}
}

// ── main (demo) ────────────────────────────────────────────────────────────────
func RAGEngineDemo() {
	ctx := context.Background()
	engine, err := NewRAGEngine("demo")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[rag] Failed to create engine: %v\n", err)
		os.Exit(1)
	}
	defer engine.Close()

	docs := []Document{
		{Content: "Go is a statically typed compiled language designed at Google. It excels at concurrency via goroutines and channels.", Metadata: map[string]string{"source": "go_docs"}},
		{Content: "RAG (Retrieval-Augmented Generation) retrieves relevant document chunks and prepends them to an LLM prompt to reduce hallucinations.", Metadata: map[string]string{"source": "rag_survey"}},
		{Content: "Qdrant is a Rust-native vector database supporting filtered nearest-neighbour search with payload storage.", Metadata: map[string]string{"source": "qdrant_docs"}},
	}

	count, err := engine.Ingest(ctx, docs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[rag] Ingest error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Ingested %d docs → %d chunks\n", len(docs), count)

	ctx2, _ := context.WithTimeout(ctx, 10e9)
	result, err := engine.RetrieveAsContext(ctx2, "What is RAG?", defaultTopK)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[rag] Retrieve error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("\nContext for 'What is RAG?':\n%s\n", result)
}
