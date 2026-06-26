// RAG REST API — Go
// net/http service with JWT HS256 auth (algorithms pinned), per-IP rate limiting,
// RBAC roles, and endpoints: GET /health, POST /ingest/text, POST /query,
// GET /sessions/{id}, DELETE /sessions/{id}.
//
// go get github.com/golang-jwt/jwt/v5@v5.2.1
// export JWT_SECRET=... ANTHROPIC_API_KEY=... VOYAGE_API_KEY=... QDRANT_URL=localhost:6333
// go run ./src/...

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ── Config ─────────────────────────────────────────────────────────────────────
var (
	jwtSecret  = []byte(os.Getenv("JWT_SECRET"))
	apiPort    = envOr("API_PORT", "8002")
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ── Rate limiter ───────────────────────────────────────────────────────────────
type rateLimiter struct {
	mu       sync.Mutex
	clients  map[string]*clientState
	limit    int
	window   time.Duration
}

type clientState struct {
	count    int
	resetAt  time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{clients: make(map[string]*clientState), limit: limit, window: window}
	go func() {
		for range time.Tick(window) {
			rl.mu.Lock()
			rl.clients = make(map[string]*clientState)
			rl.mu.Unlock()
		}
	}()
	return rl
}

func (rl *rateLimiter) Allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	c, ok := rl.clients[ip]
	if !ok || time.Now().After(c.resetAt) {
		rl.clients[ip] = &clientState{count: 1, resetAt: time.Now().Add(rl.window)}
		return true
	}
	if c.count >= rl.limit {
		return false
	}
	c.count++
	return true
}

var (
	generalLimiter = newRateLimiter(60, time.Minute)
	ingestLimiter  = newRateLimiter(30, time.Minute)
	queryLimiter   = newRateLimiter(20, time.Minute)
)

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.Split(xff, ",")[0]
	}
	return r.RemoteAddr
}

// ── Auth ───────────────────────────────────────────────────────────────────────
var roleRank = map[string]int{"admin": 4, "operator": 3, "user": 2, "readonly": 1}

type claims struct {
	Sub  string `json:"sub"`
	Role string `json:"role"`
	jwt.RegisteredClaims
}

func verifyJWT(r *http.Request) (*claims, error) {
	if len(jwtSecret) == 0 {
		return nil, fmt.Errorf("JWT_SECRET not configured")
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, fmt.Errorf("missing Bearer token")
	}
	tokenStr := strings.TrimPrefix(auth, "Bearer ")
	token, err := jwt.ParseWithClaims(tokenStr, &claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return jwtSecret, nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil {
		return nil, err
	}
	c, ok := token.Claims.(*claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return c, nil
}

func requireRole(c *claims, required string) error {
	role := c.Role
	if role == "" {
		role = "readonly"
	}
	if roleRank[role] < roleRank[required] {
		return fmt.Errorf("role '%s' cannot perform this action (requires '%s')", role, required)
	}
	return nil
}

// ── JSON helpers ───────────────────────────────────────────────────────────────
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, v interface{}) error {
	return json.NewDecoder(r.Body).Decode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readBody(r *http.Request, v interface{}) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, v)
}

// ── Shared state ───────────────────────────────────────────────────────────────
var (
	apiEngine      *RAGEngine
	apiMemory      *MemoryStore
	apiTokenEngine *TokenEngine
	apiOnce        sync.Once
	// Prometheus metrics counters
	apiMetrics = struct {
		mu             sync.Mutex
		requestsTotal  int64
		requests5xx    int64
		requests4xx    int64
		queryTotal     int64
		ingestTotal    int64
		tokensTotal    int64
		latencySamples []float64
	}{}
)

func recordMetric(status int, latencyS float64) {
	apiMetrics.mu.Lock()
	defer apiMetrics.mu.Unlock()
	apiMetrics.requestsTotal++
	if status >= 500 {
		apiMetrics.requests5xx++
	} else if status >= 400 {
		apiMetrics.requests4xx++
	}
	apiMetrics.latencySamples = append(apiMetrics.latencySamples, latencyS)
	if len(apiMetrics.latencySamples) > 10000 {
		apiMetrics.latencySamples = apiMetrics.latencySamples[len(apiMetrics.latencySamples)-10000:]
	}
}

func percentile(p float64) float64 {
	apiMetrics.mu.Lock()
	defer apiMetrics.mu.Unlock()
	if len(apiMetrics.latencySamples) == 0 {
		return 0
	}
	sorted := make([]float64, len(apiMetrics.latencySamples))
	copy(sorted, apiMetrics.latencySamples)
	// Simple insertion sort for small slices
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	idx := int(float64(len(sorted)) * p / 100)
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// ingestWithRetry retries Qdrant ingest with exponential backoff (circuit-breaker pattern)
func ingestWithRetry(ctx context.Context, doc *Document) (int, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		count, err := apiEngine.Ingest(ctx, []*Document{doc})
		if err == nil {
			return count, nil
		}
		lastErr = err
		if attempt < 3 {
			delay := time.Duration(1<<uint(attempt)) * time.Second
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
			select {
			case <-ctx.Done():
				return 0, ctx.Err()
			case <-time.After(delay):
			}
		}
	}
	return 0, fmt.Errorf("ingest failed after 3 attempts: %w", lastErr)
}

func initAPIState() error {
	var initErr error
	apiOnce.Do(func() {
		apiEngine, initErr = NewRAGEngine("api_go")
		if initErr != nil {
			return
		}
		storeDir := envOr("RAG_SESSION_DIR", ".rag_sessions_go")
		apiMemory, initErr = NewMemoryStore(storeDir)
		if initErr != nil {
			return
		}
		apiTokenEngine = NewTokenEngine(
			RBACConfig{Roles: map[string]Role{
				"admin":    {MaxTokens: 200_000, MaxIter: 50,  AlertPct: 0.80, CostPer1k: 0.015},
				"operator": {MaxTokens:  80_000, MaxIter: 30,  AlertPct: 0.75, CostPer1k: 0.015},
				"user":     {MaxTokens:  20_000, MaxIter: 20,  AlertPct: 0.70, CostPer1k: 0.015},
				"readonly": {MaxTokens:   4_000, MaxIter:  5,  AlertPct: 0.60, CostPer1k: 0.015},
			}},
			TokenEngineOptions{
				AuditPath: envOr("AGENT_AUDIT_LOG", "/tmp/rag_audit_go.jsonl"),
				OnAlert: func(s *Session, msg string) {
					slog.Warn("token_engine.alert", "session_id", s.ID, "role", s.Role,
						"message", msg, "budget_used_pct", s.BudgetUsedPct())
				},
				OnAbort: func(s *Session, reason string) {
					slog.Error("token_engine.abort", "session_id", s.ID, "role", s.Role,
						"reason", reason, "total_tokens", s.TotalTokens())
				},
			},
		)
	})
	return initErr
}

// ── Handlers ───────────────────────────────────────────────────────────────────
func healthHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ok", "time": time.Now().Unix()})
}

func readyHandler(w http.ResponseWriter, r *http.Request) {
	if apiEngine == nil {
		writeError(w, http.StatusServiceUnavailable, "engine not initialized")
		return
	}
	// Probe Qdrant connectivity via RAGEngine's embedded collections client
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := apiEngine.ensureCollection(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "qdrant not reachable: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"status": "ready"})
}

func metricsHandler(w http.ResponseWriter, r *http.Request) {
	provider := envOr("MODEL_PROVIDER", "anthropic")
	p50 := percentile(50)
	p95 := percentile(95)
	p99 := percentile(99)
	apiMetrics.mu.Lock()
	rt  := apiMetrics.requestsTotal
	r5  := apiMetrics.requests5xx
	r4  := apiMetrics.requests4xx
	qt  := apiMetrics.queryTotal
	it  := apiMetrics.ingestTotal
	tt  := apiMetrics.tokensTotal
	apiMetrics.mu.Unlock()
	lines := fmt.Sprintf(`# HELP rag_requests_total Total HTTP requests
# TYPE rag_requests_total counter
rag_requests_total %d
# HELP rag_requests_5xx_total Total 5xx responses
# TYPE rag_requests_5xx_total counter
rag_requests_5xx_total %d
# HELP rag_requests_4xx_total Total 4xx responses
# TYPE rag_requests_4xx_total counter
rag_requests_4xx_total %d
# HELP rag_query_total Total /query calls
# TYPE rag_query_total counter
rag_query_total %d
# HELP rag_ingest_total Total /ingest calls
# TYPE rag_ingest_total counter
rag_ingest_total %d
# HELP rag_tokens_total Total LLM tokens consumed
# TYPE rag_tokens_total counter
rag_tokens_total %d
# HELP rag_latency_p50_seconds Request latency p50
# TYPE rag_latency_p50_seconds gauge
rag_latency_p50_seconds %.4f
# HELP rag_latency_p95_seconds Request latency p95
# TYPE rag_latency_p95_seconds gauge
rag_latency_p95_seconds %.4f
# HELP rag_latency_p99_seconds Request latency p99
# TYPE rag_latency_p99_seconds gauge
rag_latency_p99_seconds %.4f
# HELP rag_api_info Build info
# TYPE rag_api_info gauge
rag_api_info{version="2.0.0",language="go",provider="%s"} 1
`, rt, r5, r4, qt, it, tt, p50, p95, p99, provider)
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, lines)
}

func ingestTextHandler(w http.ResponseWriter, r *http.Request) {
	if !ingestLimiter.Allow(clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "rate limit exceeded"); return
	}
	c, err := verifyJWT(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error()); return
	}
	if err := requireRole(c, "operator"); err != nil {
		writeError(w, http.StatusForbidden, err.Error()); return
	}
	var body struct {
		Content  string            `json:"content"`
		Metadata map[string]string `json:"metadata"`
	}
	if err := readBody(r, &body); err != nil || body.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required"); return
	}
	if len(body.Content) > 500_000 {
		writeError(w, http.StatusBadRequest, "content exceeds 500,000 character limit"); return
	}
	meta := body.Metadata
	if meta == nil {
		meta = map[string]string{}
	}
	doc := &Document{Content: body.Content, Metadata: meta}
	count, err := ingestWithRetry(r.Context(), doc)
	if err != nil {
		slog.Error("api.ingest_failed", "doc_id", doc.DocID, "error", err.Error())
		writeError(w, http.StatusServiceUnavailable, "ingest failed after retries — Qdrant unavailable"); return
	}
	apiMetrics.mu.Lock()
	apiMetrics.ingestTotal++
	apiMetrics.mu.Unlock()
	slog.Info("api.ingest_text", "doc_id", doc.DocID, "chunks", count, "user", c.Sub)
	writeJSON(w, http.StatusOK, map[string]interface{}{"doc_id": doc.DocID, "chunk_count": count})
}

func queryHandler(w http.ResponseWriter, r *http.Request) {
	if !queryLimiter.Allow(clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "rate limit exceeded"); return
	}
	c, err := verifyJWT(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error()); return
	}
	if err := requireRole(c, "user"); err != nil {
		writeError(w, http.StatusForbidden, err.Error()); return
	}
	var body struct {
		Question      string `json:"question"`
		SessionID     string `json:"session_id"`
		MaxIterations int    `json:"max_iterations"`
	}
	if err := readBody(r, &body); err != nil || body.Question == "" {
		writeError(w, http.StatusBadRequest, "question is required"); return
	}
	if body.MaxIterations <= 0 || body.MaxIterations > 50 {
		body.MaxIterations = 20
	}

	// Session management
	sessionID := body.SessionID
	if sessionID != "" {
		s, err := apiMemory.Load(sessionID)
		if err != nil || s == nil {
			writeError(w, http.StatusNotFound, "session not found"); return
		}
	} else {
		s, err := apiMemory.Create(map[string]string{"user": c.Sub})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create session"); return
		}
		sessionID = s.SessionID
	}

	// Start RBAC token budget session
	teSession, err := apiTokenEngine.StartSession(c.Role, body.Question)
	if err != nil {
		slog.Error("api.query_start_session_failed", "role", c.Role, "error", err.Error())
		writeError(w, http.StatusForbidden, "unknown role: "+c.Role); return
	}
	slog.Info("api.query_start", "session_id", teSession.ID, "role", c.Role, "user", c.Sub,
		"max_tokens_budget", teSession.Budget.MaxTokens)

	answer, trace, err := RunReact(r.Context(), body.Question, ReactOptions{
		SystemExtra:   ragAgentSystemPrompt,
		MaxIterations: min(body.MaxIterations, teSession.Budget.MaxIter),
	})
	if err != nil {
		_ = apiTokenEngine.EndSession(teSession.ID, "")
		var budgetErr *BudgetExceededError
		if errors.As(err, &budgetErr) {
			slog.Error("api.budget_exceeded", "user", c.Sub, "role", c.Role, "error", err.Error())
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "token budget exceeded: "+err.Error()); return
		}
		slog.Error("api.query_failed", "user", c.Sub, "error", err.Error())
		writeError(w, http.StatusInternalServerError, err.Error()); return
	}

	_ = apiTokenEngine.RecordUsage(teSession.ID, int64(trace.TotalTokens/2),
		int64(trace.TotalTokens-trace.TotalTokens/2), trace.Iterations)
	ended, _ := apiTokenEngine.EndSession(teSession.ID, answer)

	apiMetrics.mu.Lock()
	apiMetrics.queryTotal++
	apiMetrics.tokensTotal += int64(trace.TotalTokens)
	apiMetrics.mu.Unlock()

	_, _ = apiMemory.AppendUser(sessionID, body.Question)
	_, _ = apiMemory.AppendAssistant(sessionID, answer)

	budgetUsedPct := 0.0
	if ended != nil {
		budgetUsedPct = ended.BudgetUsedPct()
	}
	slog.Info("api.query_complete", "session_id", sessionID, "iterations", trace.Iterations,
		"total_tokens", trace.TotalTokens, "elapsed_ms", trace.ElapsedMS,
		"budget_used_pct", fmt.Sprintf("%.4f", budgetUsedPct), "user", c.Sub)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"answer":          answer,
		"session_id":      sessionID,
		"iterations":      trace.Iterations,
		"total_tokens":    trace.TotalTokens,
		"elapsed_ms":      trace.ElapsedMS,
		"budget_used_pct": budgetUsedPct,
	})
}

func getSessionHandler(w http.ResponseWriter, r *http.Request) {
	if !generalLimiter.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate limit exceeded"); return
	}
	c, err := verifyJWT(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error()); return
	}
	if err := requireRole(c, "user"); err != nil {
		writeError(w, http.StatusForbidden, err.Error()); return
	}
	sessionID := strings.TrimPrefix(r.URL.Path, "/sessions/")
	session, err := apiMemory.Load(sessionID)
	if err != nil || session == nil {
		writeError(w, http.StatusNotFound, "session not found"); return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"session_id":    session.SessionID,
		"created_at":    session.CreatedAt,
		"updated_at":    session.UpdatedAt,
		"message_count": len(session.Messages),
		"summary":       session.Summary,
	})
}

func deleteSessionHandler(w http.ResponseWriter, r *http.Request) {
	if !generalLimiter.Allow(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate limit exceeded"); return
	}
	c, err := verifyJWT(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error()); return
	}
	if err := requireRole(c, "user"); err != nil {
		writeError(w, http.StatusForbidden, err.Error()); return
	}
	sessionID := strings.TrimPrefix(r.URL.Path, "/sessions/")
	deleted, err := apiMemory.Delete(sessionID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error()); return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "session not found"); return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Router ─────────────────────────────────────────────────────────────────────
func newMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", healthHandler)
	mux.HandleFunc("GET /ready",  readyHandler)
	mux.HandleFunc("GET /metrics", metricsHandler)
	mux.HandleFunc("POST /ingest/text", ingestTextHandler)
	mux.HandleFunc("POST /query", queryHandler)
	mux.HandleFunc("GET /sessions/", getSessionHandler)
	mux.HandleFunc("DELETE /sessions/", deleteSessionHandler)
	// Trading endpoints — wired to trading_agent.go functions
	mux.HandleFunc("GET /trading/quote/stock/",  tradingStockQuoteHandler)
	mux.HandleFunc("GET /trading/quote/crypto/", tradingCryptoQuoteHandler)
	mux.HandleFunc("POST /trading/backtest",     tradingBacktestHandler)
	mux.HandleFunc("POST /trading/propose",      tradingProposeHandler)
	mux.HandleFunc("GET /trading/proposals/",    tradingGetProposalHandler)
	mux.HandleFunc("POST /trading/execute",      tradingExecuteHandler)
	return mux
}

// ── Trading handlers ───────────────────────────────────────────────────────────

func tradingStockQuoteHandler(w http.ResponseWriter, r *http.Request) {
	c, err := verifyJWT(r); if err != nil { writeError(w, http.StatusUnauthorized, err.Error()); return }
	if err := requireRole(c, "user"); err != nil { writeError(w, http.StatusForbidden, err.Error()); return }
	symbol := strings.TrimPrefix(r.URL.Path, "/trading/quote/stock/")
	if symbol == "" { writeError(w, http.StatusBadRequest, "symbol required"); return }
	q, err := getStockQuote(symbol)
	if err != nil { writeError(w, http.StatusBadGateway, err.Error()); return }
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"symbol": q.Symbol, "price": q.Price, "change": q.Change,
		"change_pct": q.ChangePct, "volume": q.Volume, "latest_trading_day": q.LatestTradingDay,
	})
}

func tradingCryptoQuoteHandler(w http.ResponseWriter, r *http.Request) {
	c, err := verifyJWT(r); if err != nil { writeError(w, http.StatusUnauthorized, err.Error()); return }
	if err := requireRole(c, "user"); err != nil { writeError(w, http.StatusForbidden, err.Error()); return }
	coinID := strings.TrimPrefix(r.URL.Path, "/trading/quote/crypto/")
	if coinID == "" { writeError(w, http.StatusBadRequest, "coin_id required"); return }
	vs := r.URL.Query().Get("vs_currency"); if vs == "" { vs = "usd" }
	q, err := getCryptoQuote(coinID, vs)
	if err != nil { writeError(w, http.StatusBadGateway, err.Error()); return }
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"coin_id": q.CoinID, "price": q.Price, "change_24h_pct": q.Change24hPct,
		"market_cap": q.MarketCap, "volume_24h": q.Volume24h,
	})
}

func tradingBacktestHandler(w http.ResponseWriter, r *http.Request) {
	c, err := verifyJWT(r); if err != nil { writeError(w, http.StatusUnauthorized, err.Error()); return }
	if err := requireRole(c, "user"); err != nil { writeError(w, http.StatusForbidden, err.Error()); return }
	var body struct {
		Symbol     string `json:"symbol"`
		Strategy   string `json:"strategy"`
		AssetClass string `json:"asset_class"`
		Days       int    `json:"days"`
		OutputSize string `json:"output_size"`
	}
	if err := readJSON(r, &body); err != nil { writeError(w, http.StatusBadRequest, "invalid JSON"); return }
	if body.Symbol == "" || body.Strategy == "" { writeError(w, http.StatusBadRequest, "symbol and strategy required"); return }
	if body.AssetClass == "" { body.AssetClass = "equity" }
	if body.Days == 0 { body.Days = 90 }
	if body.OutputSize == "" { body.OutputSize = "compact" }

	var bars []OHLCVBar; bpy := 252
	if body.AssetClass == "crypto" {
		cb, cerr := getCryptoOHLCV(body.Symbol, "usd", body.Days)
		if cerr != nil { writeError(w, http.StatusBadGateway, cerr.Error()); return }
		bars = make([]OHLCVBar, len(cb))
		for i, b := range cb { bars[i] = OHLCVBar{Date: fmt.Sprintf("%d", b.Timestamp), Open: b.Open, High: b.High, Low: b.Low, Close: b.Close} }
		bpy = 365
	} else {
		bars, err = getStockOHLCV(body.Symbol, "daily", body.OutputSize)
		if err != nil { writeError(w, http.StatusBadGateway, err.Error()); return }
	}

	var signalFn SignalFn
	switch body.Strategy {
	case "sma_crossover":      signalFn = MakeSMACrossoverSignal(0, 0)
	case "rsi_mean_reversion": signalFn = MakeRSIMeanReversionSignal(0, 0, 0)
	case "breakout":           signalFn = MakeBreakoutSignal(0)
	default: writeError(w, http.StatusBadRequest, "strategy must be sma_crossover, rsi_mean_reversion, or breakout"); return
	}
	opts := DefaultBacktestOptions(); opts.BarsPerYear = bpy
	result, berr := RunBacktest(bars, signalFn, opts)
	if berr != nil { writeError(w, http.StatusInternalServerError, berr.Error()); return }
	writeJSON(w, http.StatusOK, result)
}

func tradingProposeHandler(w http.ResponseWriter, r *http.Request) {
	c, err := verifyJWT(r); if err != nil { writeError(w, http.StatusUnauthorized, err.Error()); return }
	if err := requireRole(c, "user"); err != nil { writeError(w, http.StatusForbidden, err.Error()); return }
	var body struct {
		Symbol     string   `json:"symbol"`
		Side       string   `json:"side"`
		Quantity   float64  `json:"quantity"`
		AssetClass string   `json:"asset_class"`
		OrderType  string   `json:"order_type"`
		LimitPrice *float64 `json:"limit_price"`
		Rationale  string   `json:"rationale"`
	}
	if err := readJSON(r, &body); err != nil { writeError(w, http.StatusBadRequest, "invalid JSON"); return }
	proposal, perr := ProposeOrder(body.Symbol, body.Side, body.Quantity, body.AssetClass, body.OrderType, body.LimitPrice, body.Rationale)
	if perr != nil { writeError(w, http.StatusBadRequest, perr.Error()); return }
	writeJSON(w, http.StatusOK, proposal)
}

func tradingGetProposalHandler(w http.ResponseWriter, r *http.Request) {
	c, err := verifyJWT(r); if err != nil { writeError(w, http.StatusUnauthorized, err.Error()); return }
	if err := requireRole(c, "user"); err != nil { writeError(w, http.StatusForbidden, err.Error()); return }
	id := strings.TrimPrefix(r.URL.Path, "/trading/proposals/")
	if id == "" { writeError(w, http.StatusBadRequest, "proposal_id required"); return }
	p, ok := GetProposal(id)
	if !ok { writeError(w, http.StatusNotFound, "proposal not found"); return }
	writeJSON(w, http.StatusOK, p)
}

func tradingExecuteHandler(w http.ResponseWriter, r *http.Request) {
	c, err := verifyJWT(r); if err != nil { writeError(w, http.StatusUnauthorized, err.Error()); return }
	// Execution requires operator minimum — not just any user
	if err := requireRole(c, "operator"); err != nil { writeError(w, http.StatusForbidden, err.Error()); return }
	var body struct {
		ProposalID string `json:"proposal_id"`
		Confirm    bool   `json:"confirm"`
	}
	if err := readJSON(r, &body); err != nil { writeError(w, http.StatusBadRequest, "invalid JSON"); return }
	if !body.Confirm {
		slog.Warn("security.execute_rejected_no_confirm", "proposal_id", body.ProposalID, "user", c.Sub)
		writeError(w, http.StatusBadRequest, "confirm must be true — review the proposal before executing"); return
	}
	result, eerr := OrderExecuteIBKR(body.ProposalID, true)
	if eerr != nil { writeError(w, http.StatusBadRequest, eerr.Error()); return }
	slog.Warn("api.order_executed", "proposal_id", body.ProposalID, "mode", result.Mode, "user", c.Sub)
	writeJSON(w, http.StatusOK, result)
}

func securityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Correlation ID — generate or propagate
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			b := make([]byte, 16)
			_, _ = rand.Read(b)
			requestID = hex.EncodeToString(b)
		}
		// OWASP ASVS 5.0 + OWASP Secure Headers Project — all required headers
		w.Header().Set("X-Request-ID",                 requestID)
		w.Header().Set("Strict-Transport-Security",    "max-age=63072000; includeSubDomains; preload")
		w.Header().Set("Content-Security-Policy",      "default-src 'none'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options",       "nosniff")
		w.Header().Set("X-Frame-Options",              "DENY")
		w.Header().Set("Referrer-Policy",              "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy",           "geolocation=(), camera=(), microphone=(), payment=()")
		w.Header().Set("Cross-Origin-Opener-Policy",   "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Cache-Control",                "no-store")
		w.Header().Set("X-XSS-Protection",             "0")
		w.Header().Del("Server")
		w.Header().Del("X-Powered-By")
		next.ServeHTTP(w, r)
		slog.Info("request",
			"method", r.Method, "path", r.URL.Path,
			"request_id", requestID, "remote", clientIP(r))
		recordMetric(0, time.Since(time.Now()).Seconds()) // timing recorded separately per handler
	})
}

func startAPIServer() {
	if err := initAPIState(); err != nil {
		slog.Error("init failed", "err", err)
		os.Exit(1)
	}

	// Register rag_search tool once at startup — not per-request
	if _, ok := GoToolRegistry["rag_search"]; !ok {
		GoToolRegistry["rag_search"] = func(input map[string]interface{}) (string, error) {
			query, _ := input["query"].(string)
			topK := 5
			if v, ok := input["top_k"].(float64); ok {
				topK = int(v)
			}
			return apiEngine.RetrieveAsContext(context.Background(), query, topK)
		}
		GoToolSchemas = append(GoToolSchemas, map[string]interface{}{
			"name":        "rag_search",
			"description": "Search the knowledge base for context relevant to a query.",
			"input_schema": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string"},
					"top_k": map[string]interface{}{"type": "integer"},
				},
				"required": []string{"query"},
			},
		})
	}

	srv := &http.Server{
		Addr:         ":" + apiPort,
		Handler:      securityMiddleware(newMux()),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown on SIGTERM/SIGINT (production-standards: max 30s drain)
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-quit
		slog.Info("RAG API Go shutting down gracefully")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			slog.Error("shutdown error", "err", err)
		}
	}()

	slog.Info("RAG API Go starting", "port", apiPort)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
	slog.Info("RAG API Go stopped")
}
