# RAG AI — Go

## Setup

```bash
go mod tidy
export ANTHROPIC_API_KEY=sk-ant-...
export QDRANT_URL=localhost:6333   # gRPC port
```

## Modules

- `src/agent_loop.go` — minimal agentic loop
- `src/react_loop.go` — production ReAct loop
- `src/token_engine.go` — RBAC token budgets + monitor
- `src/run_agent.go` — CLI harness
- `src/harness_react.go` — test battery
- `src/rag_engine.go` — chunk → embed → Qdrant (gRPC) ingest/retrieve

## Run

```bash
go run src/rag_engine.go
```

## Test

```bash
go test ./...
```
