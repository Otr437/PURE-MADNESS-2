// Test suite — Go RAG AI Monorepo
// Tests: memory, loaders, eval_harness, rag_engine, model_router
//
// go test ./... -v

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── Memory tests ───────────────────────────────────────────────────────────────
func TestMemoryCreateAndLoad(t *testing.T) {
	dir := t.TempDir()
	store, err := NewMemoryStore(dir)
	if err != nil {
		t.Fatalf("NewMemoryStore: %v", err)
	}
	session, err := store.Create(map[string]string{"user": "test"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	loaded, err := store.Load(session.SessionID)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded == nil {
		t.Fatal("expected session, got nil")
	}
	if loaded.SessionID != session.SessionID {
		t.Errorf("session ID mismatch: %s != %s", loaded.SessionID, session.SessionID)
	}
	if loaded.Metadata["user"] != "test" {
		t.Errorf("metadata mismatch: %v", loaded.Metadata)
	}
}

func TestMemoryAppendMessages(t *testing.T) {
	dir := t.TempDir()
	store, _ := NewMemoryStore(dir)
	session, _ := store.Create(nil)

	store.AppendUser(session.SessionID, "Hello")
	store.AppendAssistant(session.SessionID, "Hi there!")

	loaded, _ := store.Load(session.SessionID)
	if len(loaded.Messages) != 2 {
		t.Errorf("expected 2 messages, got %d", len(loaded.Messages))
	}
	if loaded.Messages[0]["role"] != "user" {
		t.Errorf("expected user message, got %v", loaded.Messages[0]["role"])
	}
	if loaded.Messages[1]["role"] != "assistant" {
		t.Errorf("expected assistant message, got %v", loaded.Messages[1]["role"])
	}
}

func TestMemoryDelete(t *testing.T) {
	dir := t.TempDir()
	store, _ := NewMemoryStore(dir)
	session, _ := store.Create(nil)

	deleted, err := store.Delete(session.SessionID)
	if err != nil || !deleted {
		t.Fatalf("Delete failed: err=%v deleted=%v", err, deleted)
	}
	loaded, _ := store.Load(session.SessionID)
	if loaded != nil {
		t.Error("expected nil after delete")
	}
}

func TestMemoryPathTraversalRejected(t *testing.T) {
	dir := t.TempDir()
	store, _ := NewMemoryStore(dir)
	_, err := store.Load("../../etc/passwd")
	if err == nil {
		t.Error("expected error for path traversal, got nil")
	}
}

func TestBuildContextMessages(t *testing.T) {
	session := &Session{
		Messages: []map[string]interface{}{
			{"role": "user", "content": "First question"},
			{"role": "assistant", "content": "First answer"},
		},
	}
	msgs := BuildContextMessages(session, "New question")
	last := msgs[len(msgs)-1]
	if last["content"] != "New question" {
		t.Errorf("expected new question as last message, got %v", last["content"])
	}
	if last["role"] != "user" {
		t.Errorf("expected user role, got %v", last["role"])
	}
}

// ── Loader tests ───────────────────────────────────────────────────────────────
func TestLoadTxt(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test.txt")
	os.WriteFile(p, []byte("Hello world"), 0644)
	doc, err := loadTxtGo(p)
	if err != nil {
		t.Fatalf("loadTxtGo: %v", err)
	}
	if doc.Content != "Hello world" {
		t.Errorf("expected 'Hello world', got %q", doc.Content)
	}
	if doc.Metadata["type"] != "txt" {
		t.Errorf("expected type=txt, got %q", doc.Metadata["type"])
	}
}

func TestLoadHTML(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test.html")
	os.WriteFile(p, []byte("<html><head><title>Test</title></head><body><p>Hello HTML</p></body></html>"), 0644)
	doc, err := loadHTMLGo(p)
	if err != nil {
		t.Fatalf("loadHTMLGo: %v", err)
	}
	if !strings.Contains(doc.Content, "Hello HTML") {
		t.Errorf("expected 'Hello HTML' in content, got: %q", doc.Content[:100])
	}
	if doc.Metadata["type"] != "html" {
		t.Errorf("expected type=html")
	}
}

func TestLoadMarkdown(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test.md")
	os.WriteFile(p, []byte("# Title\n\nParagraph with **bold** text."), 0644)
	doc, err := loadMarkdownGo(p)
	if err != nil {
		t.Fatalf("loadMarkdownGo: %v", err)
	}
	if doc.Metadata["type"] != "markdown" {
		t.Errorf("expected type=markdown")
	}
	if !strings.Contains(doc.Content, "Title") && !strings.Contains(doc.Content, "bold") {
		t.Errorf("expected stripped markdown content, got: %q", doc.Content)
	}
}

func TestFileSizeGuard(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "big.txt")
	// Create a file just over the limit
	data := make([]byte, goMaxFileBytes+1)
	os.WriteFile(p, data, 0644)
	_, err := loadTxtGo(p)
	if err == nil {
		t.Error("expected size error, got nil")
	}
}

func TestUnsupportedExtension(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "bad.xyz")
	os.WriteFile(p, []byte("nope"), 0644)
	_, err := LoadDocument(p)
	if err == nil {
		t.Error("expected error for unsupported extension")
	}
}

func TestLoadDirectory(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("Content A"), 0644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("Content B"), 0644)
	os.WriteFile(filepath.Join(dir, "skip.xyz"), []byte("skip"), 0644)
	docs, err := LoadDirectory(dir, false)
	if err != nil {
		t.Fatalf("LoadDirectory: %v", err)
	}
	if len(docs) != 2 {
		t.Errorf("expected 2 docs, got %d", len(docs))
	}
}

// ── Eval harness tests ─────────────────────────────────────────────────────────
func TestPrecisionAtK(t *testing.T) {
	retrieved := []string{"a", "b", "c", "d", "e"}
	relevant  := map[string]bool{"a": true, "c": true}
	p := precisionAtK(retrieved, relevant, 5)
	if p < 0.39 || p > 0.41 {
		t.Errorf("expected precision ~0.4, got %.4f", p)
	}
	p1 := precisionAtK(retrieved, relevant, 1)
	if p1 != 1.0 {
		t.Errorf("expected precision@1=1.0, got %.4f", p1)
	}
}

func TestRecallAtK(t *testing.T) {
	retrieved := []string{"a", "b", "c"}
	relevant  := map[string]bool{"a": true, "c": true, "d": true}
	r := recallAtK(retrieved, relevant, 3)
	expected := 2.0 / 3.0
	if r < expected-0.001 || r > expected+0.001 {
		t.Errorf("expected recall ~%.4f, got %.4f", expected, r)
	}
}

func TestReciprocalRank(t *testing.T) {
	retrieved := []string{"x", "a", "b"}
	relevant  := map[string]bool{"a": true}
	rr := reciprocalRank(retrieved, relevant)
	if rr < 0.49 || rr > 0.51 {
		t.Errorf("expected MRR=0.5, got %.4f", rr)
	}
}

func TestReciprocalRankMiss(t *testing.T) {
	retrieved := []string{"x", "y"}
	relevant  := map[string]bool{"a": true}
	rr := reciprocalRank(retrieved, relevant)
	if rr != 0 {
		t.Errorf("expected MRR=0, got %.4f", rr)
	}
}

// ── chunk_text tests ───────────────────────────────────────────────────────────
func TestChunkTextShort(t *testing.T) {
	chunks := chunkText("Hello world", 200, 20)
	if len(chunks) != 1 {
		t.Errorf("expected 1 chunk, got %d", len(chunks))
	}
	if chunks[0] != "Hello world" {
		t.Errorf("expected 'Hello world', got %q", chunks[0])
	}
}

func TestChunkTextLong(t *testing.T) {
	text := strings.Repeat("word ", 500)
	chunks := chunkText(text, 100, 20)
	if len(chunks) <= 1 {
		t.Errorf("expected multiple chunks, got %d", len(chunks))
	}
}

func TestModelRouterInvalidProvider(t *testing.T) {
	_, err := NewModelRouter("invalid_provider", "")
	if err == nil {
		t.Error("expected error for invalid provider, got nil")
	}
}

func TestModelRouterValidProviders(t *testing.T) {
	for _, provider := range []string{"anthropic", "deepseek", "openai"} {
		os.Setenv("ANTHROPIC_API_KEY", "test")
		os.Setenv("DEEPSEEK_API_KEY", "test")
		os.Setenv("OPENAI_API_KEY", "test")
		router, err := NewModelRouter(provider, "")
		if err != nil {
			t.Errorf("provider %s: unexpected error: %v", provider, err)
		}
		if router != nil && router.Provider != provider {
			t.Errorf("provider mismatch: %s != %s", router.Provider, provider)
		}
	}
}

func TestMakeToolResultMessage(t *testing.T) {
	msg := MakeToolResultMessage("id123", "result", false)
	content, ok := msg["content"].([]interface{})
	if !ok || len(content) == 0 {
		t.Fatal("expected content array")
	}
	block := content[0].(map[string]interface{})
	if block["tool_use_id"] != "id123" {
		t.Errorf("expected tool_use_id=id123, got %v", block["tool_use_id"])
	}
	if block["content"] != "result" {
		t.Errorf("expected content=result, got %v", block["content"])
	}
}

// ── Eval integration test (no Qdrant required — pseudo-embed) ──────────────────
func TestEvalMetricsIntegration(t *testing.T) {
	ctx := context.Background()

	// Test metric functions in isolation without requiring Qdrant
	retrieved := []string{"doc1", "doc2", "doc3"}
	relevant  := map[string]bool{"doc1": true}

	p := precisionAtK(retrieved, relevant, 3)
	if p < 0.32 || p > 0.34 {
		t.Errorf("precision@3: expected ~0.333, got %.4f", p)
	}
	r := recallAtK(retrieved, relevant, 3)
	if r != 1.0 {
		t.Errorf("recall@3: expected 1.0, got %.4f", r)
	}
	mrr := reciprocalRank(retrieved, relevant)
	if mrr != 1.0 {
		t.Errorf("mrr: expected 1.0, got %.4f", mrr)
	}
	n := ndcgAtK(retrieved, relevant, 3)
	if n < 0.99 || n > 1.01 {
		t.Errorf("ndcg@3: expected ~1.0, got %.4f", n)
	}
	_ = ctx
}
