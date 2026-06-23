# Agentic Loop — Plug & Play Templates

Each file is a self-contained agentic loop using the Anthropic API.
All use the same pattern: **reason → tool call → observe → repeat**.

## Files

| File | Language | Setup |
|------|----------|-------|
| `agent_loop.py` | Python | `pip install anthropic` |
| `agent_loop.ts` | TypeScript | `npm install @anthropic-ai/sdk` |
| `agent_loop.go` | Go | `go get github.com/anthropics/anthropic-sdk-go` |
| `agent_loop.rs` | Rust | Add deps to Cargo.toml (see file header) |
| `AgentLoop.java` | Java | Add OkHttp + Jackson to pom.xml (see file header) |

## Setup (all languages)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## How to customize

1. **Add tools** — add entries to the `TOOLS` array/list
2. **Wire tool logic** — add cases to `execute_tool()`
3. **Change the prompt** — edit the `run_agent()` call at the bottom
4. **Adjust iterations** — `max_iterations` guards against infinite loops

## The core loop (pseudocode)

```
messages = [user_message]
while not done:
    response = call_llm(messages)
    if response.stop_reason == "end_turn":
        return response.text
    if response.stop_reason == "tool_use":
        for each tool_call in response:
            result = execute_tool(tool_call)
            messages.append(tool_result)
```
