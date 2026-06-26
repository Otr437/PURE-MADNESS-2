# RAG AI — Python

## Setup

```bash
pip install -r requirements.txt --break-system-packages
export ANTHROPIC_API_KEY=sk-ant-...
export QDRANT_URL=http://localhost:6333   # or omit for in-memory
```

## Modules

- `src/agent_loop.py` — minimal agentic loop, plug in your tools
- `src/react_loop.py` — production ReAct loop (think/act/observe)
- `src/token_engine.py` — RBAC token budgets + audit log + monitor
- `src/run_agent.py` — CLI harness: `python src/run_agent.py "task"`
- `src/harness_react.py` — automated test battery for the ReAct loop
- `src/rag_engine.py` — chunk → embed → Qdrant ingest/retrieve
- `src/rag_agent.py` — full RAG agent (`rag_engine` + `react_loop`)

## Run

```bash
python src/rag_agent.py "Explain how RAG works"
```

## Test

```bash
pytest tests/ -v
```
