# Production ReAct Loop — All Languages

ReAct = **Re**ason + **Act** — the agent thinks before every action,
observes the result, and loops until it calls `finish`.

## Files

| File | Language | Run |
|------|----------|-----|
| `react_loop.py`  | Python     | `python react_loop.py "your task"` |
| `react_loop.ts`  | TypeScript | `npx ts-node react_loop.ts "your task"` |
| `react_loop.go`  | Go         | `go run react_loop.go "your task"` |
| `react_loop.rs`  | Rust       | `cargo run -- "your task"` |
| `ReactLoop.java` | Java       | `java -cp .:deps ReactLoop "your task"` |

## Setup

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## What every file includes

- Full ReAct loop: Thought → Action → Observation → repeat → finish
- `think` tool — model reasons before every action (never skips)
- `finish` tool — clean loop termination with final answer
- `search` — stub, wire your real search API (Brave/Tavily/SerpAPI)
- `fetch_url` — real HTTP fetch + HTML strip
- `run_bash` / `run_python` / `run_node` — real code execution with timeout
- `read_file` / `write_file` — real disk I/O
- Full step trace (Thought/Action/Observation/Answer) with JSON dump
- Token usage tracking per iteration
- Elapsed time tracking
- Retry logic on rate limits / 5xx (exponential backoff)
- Structured logging to stderr, clean output to stdout
- Hard iteration cap with informative error

## Adding your own tools

1. Define the function
2. Register it with name, description, JSON schema
3. Done — the model will discover and use it automatically

## The ReAct loop (pseudocode)

```
messages = [task]
loop:
    response = llm(messages, tools)
    if stop_reason == end_turn:   return text
    for each tool_use in response:
        if tool == "think":   log thought, continue
        if tool == "finish":  return answer
        result = execute(tool, input)
        append tool_result to messages
