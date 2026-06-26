// RBAC Token Engine + Monitor — Go
// Plugs directly into react_loop.go and run_agent.go
//
// Usage:
//   engine := NewTokenEngine(DefaultConfig, TokenEngineOptions{})
//   session, err := engine.StartSession("operator", "your task")
//   engine.RecordUsage(session.ID, 500, 300, 1)
//   engine.EndSession(session.ID, "done")
//   engine.PrintMonitor(false)

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// ── Helpers ────────────────────────────────────────────────────────────────────
func goRandID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ── Role definition ───────────────────────────────────────────────────────────

type Role struct {
	MaxTokens  int     // total token budget per session
	MaxIter    int     // max agent iterations
	AlertPct   float64 // alert threshold (0–1)
	CostPer1k  float64 // USD per 1k tokens
}

// ── RBAC config ───────────────────────────────────────────────────────────────

type RBACConfig struct {
	Roles map[string]Role
}

var DefaultConfig = RBACConfig{
	Roles: map[string]Role{
		"admin":    {MaxTokens: 200_000, MaxIter: 50, AlertPct: 0.80, CostPer1k: 0.015},
		"operator": {MaxTokens: 50_000,  MaxIter: 30, AlertPct: 0.75, CostPer1k: 0.015},
		"user":     {MaxTokens: 10_000,  MaxIter: 15, AlertPct: 0.70, CostPer1k: 0.015},
		"readonly": {MaxTokens: 2_000,   MaxIter: 5,  AlertPct: 0.60, CostPer1k: 0.015},
	},
}

func (c RBACConfig) Get(role string) (Role, error) {
	r, ok := c.Roles[role]
	if !ok {
		valid := make([]string, 0, len(c.Roles))
		for k := range c.Roles { valid = append(valid, k) }
		return Role{}, fmt.Errorf("unknown role %q — valid roles: %v", role, valid)
	}
	return r, nil
}

// ── Session ───────────────────────────────────────────────────────────────────

type Session struct {
	mu           sync.Mutex
	ID           string
	Role         string
	Task         string
	Budget       Role
	StartedAt    time.Time
	EndedAt      *time.Time
	InputTokens  int64
	OutputTokens int64
	Iterations   int
	Answer       string
	Alerts       []string
	Aborted      bool
	AbortReason  string
}

func newSession(role, task string, budget Role) *Session {
	return &Session{
		ID:        goRandID(),
		Role:      role,
		Task:      task,
		Budget:    budget,
		StartedAt: time.Now(),
	}
}

func (s *Session) TotalTokens() int64   { return s.InputTokens + s.OutputTokens }
func (s *Session) BudgetUsedPct() float64 {
	if s.Budget.MaxTokens == 0 { return 0 }
	return float64(s.TotalTokens()) / float64(s.Budget.MaxTokens)
}
func (s *Session) EstimatedCostUSD() float64 {
	return float64(s.TotalTokens()) / 1000.0 * s.Budget.CostPer1k
}
func (s *Session) ElapsedMs() int64 {
	end := time.Now()
	if s.EndedAt != nil { end = *s.EndedAt }
	return end.Sub(s.StartedAt).Milliseconds()
}
func (s *Session) ToDict() map[string]interface{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	task := s.Task
	if len(task) > 200 { task = task[:200] }
	var endedAt interface{}
	if s.EndedAt != nil { endedAt = s.EndedAt.Format(time.RFC3339) }
	return map[string]interface{}{
		"id":                s.ID,
		"role":              s.Role,
		"task":              task,
		"started_at":        s.StartedAt.Format(time.RFC3339),
		"ended_at":          endedAt,
		"elapsed_ms":        s.ElapsedMs(),
		"input_tokens":      s.InputTokens,
		"output_tokens":     s.OutputTokens,
		"total_tokens":      s.TotalTokens(),
		"budget_tokens":     s.Budget.MaxTokens,
		"budget_used_pct":   fmt.Sprintf("%.1f", s.BudgetUsedPct()*100),
		"estimated_cost_usd": fmt.Sprintf("%.6f", s.EstimatedCostUSD()),
		"iterations":        s.Iterations,
		"max_iter":          s.Budget.MaxIter,
		"alerts":            s.Alerts,
		"aborted":           s.Aborted,
		"abort_reason":      s.AbortReason,
	}
}

// ── Errors ────────────────────────────────────────────────────────────────────

type BudgetExceededError struct{ Reason string }
func (e *BudgetExceededError) Error() string { return e.Reason }

// ── Token Engine ──────────────────────────────────────────────────────────────

type TokenEngineOptions struct {
	AuditPath string
	OnAlert   func(*Session, string)
	OnAbort   func(*Session, string)
}

type TokenEngine struct {
	config    RBACConfig
	sessions  map[string]*Session
	mu        sync.RWMutex
	auditPath string
	onAlert   func(*Session, string)
	onAbort   func(*Session, string)
}

func NewTokenEngine(config RBACConfig, opts TokenEngineOptions) *TokenEngine {
	path := opts.AuditPath
	if path == "" {
		path = os.Getenv("AGENT_AUDIT_LOG")
		if path == "" { path = "/tmp/agent_audit.jsonl" }
	}
	return &TokenEngine{
		config:    config,
		sessions:  make(map[string]*Session),
		auditPath: path,
		onAlert:   opts.OnAlert,
		onAbort:   opts.OnAbort,
	}
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

func (e *TokenEngine) StartSession(role, task string) (*Session, error) {
	budget, err := e.config.Get(role)
	if err != nil { return nil, err }
	s := newSession(role, task, budget)
	e.mu.Lock()
	e.sessions[s.ID] = s
	e.mu.Unlock()
	e.audit("session_start", s, nil)
	return s, nil
}

func (e *TokenEngine) RecordUsage(sessionID string, inputTokens, outputTokens int64, iteration int) error {
	s, err := e.getSession(sessionID)
	if err != nil { return err }
	s.mu.Lock()
	s.InputTokens  += inputTokens
	s.OutputTokens += outputTokens
	s.Iterations    = iteration
	s.mu.Unlock()
	e.audit("usage", s, map[string]interface{}{
		"delta_input": inputTokens, "delta_output": outputTokens,
	})
	return e.checkBudget(s)
}

func (e *TokenEngine) EndSession(sessionID, answer string) (*Session, error) {
	s, err := e.getSession(sessionID)
	if err != nil { return nil, err }
	s.mu.Lock()
	now := time.Now()
	s.EndedAt = &now
	s.Answer  = answer
	s.mu.Unlock()
	e.audit("session_end", s, nil)
	return s, nil
}

func (e *TokenEngine) AbortSession(sessionID, reason string) error {
	s, err := e.getSession(sessionID)
	if err != nil { return err }
	s.mu.Lock()
	now := time.Now()
	s.Aborted     = true
	s.AbortReason = reason
	s.EndedAt     = &now
	s.mu.Unlock()
	e.audit("session_abort", s, map[string]interface{}{"reason": reason})
	if e.onAbort != nil { e.onAbort(s, reason) }
	return &BudgetExceededError{Reason: reason}
}

// ── Budget enforcement ────────────────────────────────────────────────────────

func (e *TokenEngine) CheckIteration(sessionID string, iteration int) error {
	s, err := e.getSession(sessionID)
	if err != nil { return err }
	if iteration > s.Budget.MaxIter {
		return e.AbortSession(sessionID, fmt.Sprintf(
			"role %q iteration limit reached: %d max, attempted #%d",
			s.Role, s.Budget.MaxIter, iteration,
		))
	}
	return nil
}

func (e *TokenEngine) checkBudget(s *Session) error {
	pct := s.BudgetUsedPct()

	s.mu.Lock()
	alerted := len(s.Alerts) > 0
	s.mu.Unlock()

	if pct >= s.Budget.AlertPct && !alerted {
		msg := fmt.Sprintf("[ALERT] Role %q session %s at %.1f%% of token budget (%d/%d)",
			s.Role, s.ID[:8], pct*100, s.TotalTokens(), s.Budget.MaxTokens)
		s.mu.Lock()
		s.Alerts = append(s.Alerts, msg)
		s.mu.Unlock()
		e.emitAlert(s, msg)
	}

	if s.TotalTokens() >= int64(s.Budget.MaxTokens) {
		return e.AbortSession(s.ID, fmt.Sprintf(
			"role %q token budget exhausted: %d/%d",
			s.Role, s.TotalTokens(), s.Budget.MaxTokens,
		))
	}
	return nil
}

func (e *TokenEngine) emitAlert(s *Session, msg string) {
	fmt.Printf("\n\033[93m⚠  TOKEN ALERT\033[0m  %s\n", msg)
	e.audit("alert", s, map[string]interface{}{"message": msg})
	if e.onAlert != nil { e.onAlert(s, msg) }
}

// ── Monitor ───────────────────────────────────────────────────────────────────

func (e *TokenEngine) PrintMonitor(activeOnly bool) {
	e.mu.RLock()
	sessions := make([]*Session, 0, len(e.sessions))
	for _, s := range e.sessions {
		if activeOnly && s.EndedAt != nil { continue }
		sessions = append(sessions, s)
	}
	e.mu.RUnlock()

	sep := strings.Repeat("─", 112)
	fmt.Printf("\n%s\n", sep)
	fmt.Printf("%-10s %-12s %-12s %-10s %-18s %-8s %-10s %-10s %s\n",
		"SESSION", "ROLE", "TOKENS", "BUDGET", "USED%", "ITER", "COST$", "ELAPSED", "STATUS")
	fmt.Printf("%s\n", sep)

	var totalTokens int64
	var totalCost   float64

	for _, s := range sessions {
		status := "RUNNING"
		color  := "\033[93m"
		if s.Aborted  { status = "ABORTED"; color = "\033[91m" } else
		if s.EndedAt != nil { status = "DONE";    color = "\033[92m" }

		pct    := s.BudgetUsedPct()
		filled := int(pct * 10)
		bar    := strings.Repeat("█", filled) + strings.Repeat("░", 10-filled)

		fmt.Printf("%-10s %-12s %-12s %-10s %s %4.1f%% %-8s $%-9.4f %-9.1fms %s%s\033[0m\n",
			s.ID[:8],
			s.Role,
			fmt.Sprintf("%d", s.TotalTokens()),
			fmt.Sprintf("%d", s.Budget.MaxTokens),
			bar, pct*100,
			fmt.Sprintf("%d/%d", s.Iterations, s.Budget.MaxIter),
			s.EstimatedCostUSD(),
			float64(s.ElapsedMs()),
			color, status,
		)
		totalTokens += s.TotalTokens()
		totalCost   += s.EstimatedCostUSD()
	}

	fmt.Printf("%s\n", sep)
	fmt.Printf("  Sessions: %d  |  Tokens: %d  |  Cost: $%.4f\n%s\n\n",
		len(sessions), totalTokens, totalCost, sep)
}

func (e *TokenEngine) GetReport() []map[string]interface{} {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]map[string]interface{}, 0, len(e.sessions))
	for _, s := range e.sessions { out = append(out, s.ToDict()) }
	return out
}

func (e *TokenEngine) WriteReport(path string) error {
	data, err := json.MarshalIndent(e.GetReport(), "", "  ")
	if err != nil { return err }
	return os.WriteFile(path, data, 0644)
}

// ── Audit log ─────────────────────────────────────────────────────────────────

func (e *TokenEngine) audit(event string, s *Session, extra map[string]interface{}) {
	record := map[string]interface{}{
		"ts":         time.Now().Format(time.RFC3339),
		"event":      event,
		"session_id": s.ID,
		"role":       s.Role,
		"tokens":     s.TotalTokens(),
		"budget":     s.Budget.MaxTokens,
		"pct":        fmt.Sprintf("%.1f", s.BudgetUsedPct()*100),
		"cost_usd":   fmt.Sprintf("%.6f", s.EstimatedCostUSD()),
	}
	for k, v := range extra { record[k] = v }
	data, _ := json.Marshal(record)
	f, err := os.OpenFile(e.auditPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil { return }
	defer f.Close()
	f.Write(append(data, '\n'))
}

func (e *TokenEngine) getSession(id string) (*Session, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	s, ok := e.sessions[id]
	if !ok { return nil, fmt.Errorf("unknown session: %s", id) }
	return s, nil
}

// ── Wired RunReact with RBAC ──────────────────────────────────────────────────

func RunReactRBAC(
	ctx     context.Context,
	task    string,
	role    string,
	engine  *TokenEngine,
	opts    ReactOptions,
) (string, *Session, error) {
	session, err := engine.StartSession(role, task)
	if err != nil { return "", nil, err }

	fmt.Printf("\n[token] Session %s | Role: %s | Budget: %d tokens\n\n",
		session.ID[:8], role, session.Budget.MaxTokens)

	iterCount := 0
	origOnStep := opts.OnStep
	opts.OnStep = func(step Step) {
		if step.Type == StepAction {
			iterCount++
			if err := engine.CheckIteration(session.ID, iterCount); err != nil {
				panic(err) // caught below
			}
		}
		if origOnStep != nil { origOnStep(step) }
	}
	opts.MaxIterations = session.Budget.MaxIter

	var answer string
	var trace  *Trace

	func() {
		defer func() {
			if r := recover(); r != nil {
				if budgetErr, ok := r.(*BudgetExceededError); ok {
					err = budgetErr
				} else {
					panic(r)
				}
			}
		}()
		answer, trace, err = RunReact(ctx, task, opts)
	}()

	if err != nil {
		_ = engine.AbortSession(session.ID, err.Error())
		return "", session, err
	}

	_ = engine.RecordUsage(session.ID, trace.TotalTokens/2, trace.TotalTokens-trace.TotalTokens/2, trace.Iterations)
	endedSession, _ := engine.EndSession(session.ID, answer)
	return answer, endedSession, nil
}
