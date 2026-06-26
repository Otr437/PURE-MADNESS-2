# RAG AI — Java

## Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export QDRANT_URL=http://localhost:6333
mvn -B package
```

## Modules

- `src/AgentLoop.java` — minimal agentic loop
- `src/ReactLoop.java` — production ReAct loop
- `src/TokenEngine.java` — RBAC token budgets + monitor
- `src/RunAgent.java` — CLI harness
- `src/HarnessReact.java` — test battery
- `src/RagEngine.java` — chunk → embed → Qdrant (REST) ingest/retrieve

## Run

```bash
java -cp target/rag-ai-java-1.0.0.jar RagEngine
java -cp target/rag-ai-java-1.0.0.jar RunAgent "Explain how RAG works"
```

## Test

```bash
mvn -B test
```
