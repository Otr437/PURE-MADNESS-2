# RAG AI — Rust

## Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export QDRANT_URL=http://localhost:6333
```

## Modules

- `src/agent_loop.rs` — minimal agentic loop
- `src/react_loop.rs` — production ReAct loop
- `src/token_engine.rs` — RBAC token budgets + monitor
- `src/run_agent.rs` — CLI harness
- `src/harness_react.rs` — test battery
- `src/rag_engine.rs` — chunk → embed → Qdrant ingest/retrieve

## Run

```bash
cargo run --bin rag_engine
cargo run --bin run_agent -- "Explain how RAG works"
```

## Test

```bash
cargo test
```
