# RAG AI — TypeScript

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
export QDRANT_URL=http://localhost:6333
```

## Modules

- `src/agent_loop.ts` — minimal agentic loop
- `src/react_loop.ts` — production ReAct loop
- `src/token_engine.ts` — RBAC token budgets + monitor
- `src/run_agent.ts` — CLI harness
- `src/harness_react.ts` — test battery
- `src/rag_engine.ts` — chunk → embed → Qdrant ingest/retrieve
- `src/rag_agent.ts` — full RAG agent

## Run

```bash
npm run rag-agent -- "Explain how RAG works"
```

## Build / Test

```bash
npm run build
npm test
```
