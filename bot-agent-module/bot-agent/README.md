# 🤖 Bot Agent Module
**May 30, 2026 · Autonomous · Self-Healing · Multi-Model · Multi-Agent**

Production-grade autonomous agent system implementing the 2026 standard:
**Perceive → Reason → Plan → Act → Observe** — continuous ReAct loop with
self-healing, token budget enforcement, hard iteration caps, hierarchical
multi-agent coordination, persistent memory, and live browser control.

---

## Features

| Feature | Detail |
|---------|--------|
| **ReAct Engine** | Perceive→Reason→Plan→Act→Observe loop, loop detection, self-healing |
| **Browser Bot** | CDP-native, Chrome/Edge/Brave/Arc, DOM + vision act, multi-tab |
| **Multi-Agent** | Supervisor→Worker hierarchy, dependency scheduling, parallel execution |
| **Token Budget** | Gateway-level hard stops, daily/monthly caps, model-tier routing |
| **Memory** | Short-term (TTL), long-term (disk), vector search (optional) |
| **Tools** | 16 built-in: search, fetch, Python exec, shell, file I/O, HTTP, math |
| **Multi-Model** | Claude, OpenAI GPT-4o, Google Gemini, auto-downgrade on budget |
| **Health** | Liveness/readiness probes, metrics, session registry, graceful shutdown |
| **Config** | .env loader, env vars, JSON override files, validated at startup |

---

## Install

```bash
pip install -r requirements.txt
playwright install chromium        # for browser mode
```

Copy `.env.example` to `.env` and fill in your keys:
```bash
cp .env.example .env
```

---

## Quick Start

```python
import asyncio
from main import BotAgent

agent = BotAgent(model="claude")

# Pure ReAct (no browser needed)
result = asyncio.run(agent.react("Calculate compound interest on $10k at 7% for 10 years"))

# Browser agent — headless
result = asyncio.run(agent.browse(
    "https://news.ycombinator.com",
    "Get the top 5 stories with title and score"
))

# Attach to YOUR live Chrome/Edge/Brave
agent = BotAgent(browser_mode="live_chrome", headless=False)
result = asyncio.run(agent.browse("", "Click the login button and fill in my credentials"))

# Research agent (web search + summarize)
result = asyncio.run(agent.research("What happened at Google I/O 2026?"))

# Coder agent (writes + runs Python)
result = asyncio.run(agent.code("Generate a Fibonacci sequence up to 1000 and plot it"))

# Multi-agent supervisor
result = asyncio.run(agent.multi(
    "Research and compare the top 3 AI browser automation frameworks in 2026",
    roles=["researcher", "extractor", "analyst", "verifier"]
))

# Structured extraction
result = asyncio.run(agent.extract(
    "https://example.com/products",
    {"name": "product name", "price": "price in USD", "rating": "star rating"}
))
```

---

## Architecture

```
bot-agent/
├── main.py                        ← BotAgent facade (single entry point)
├── requirements.txt
├── .env.example
│
├── core/
│   ├── agent_engine.py            ← ReAct loop, ToolRegistry, LLMProvider, BudgetState
│   ├── memory.py                  ← ShortTermMemory, LongTermMemory, vector search
│   ├── health.py                  ← Metrics, SessionRegistry, GracefulShutdown, logging
│   └── config.py                  ← .env loader, AppConfig, validation
│
├── browser/
│   └── browser_bot.py             ← CDP browser session + BrowserBotAgent
│
├── agents/
│   └── multi_agent.py             ← SupervisorAgent, WorkerAgent, TaskQueue
│
├── budget/
│   └── budget_manager.py          ← BudgetGateway, hard stops, analytics, alerts
│
└── tools/
    └── builtin_tools.py           ← 16 built-in tools, register_all()
```

---

## Module Details

### core/agent_engine.py
The heart of the system. Implements the ReAct loop:
- `ReActEngine` — main loop with hard stops, loop detection, budget tracking
- `ToolRegistry` — register/call tools with retry + timeout
- `LLMProvider` — unified Claude/OpenAI/Gemini interface with streaming
- `BudgetState` — per-session token + cost tracking with circuit breakers
- `AgentSession` — full history, export to JSON, save to disk

### core/memory.py
Two-layer memory:
- `ShortTermMemory` — in-session TTL key/value store
- `LongTermMemory` — persistent JSONL on disk, semantic search (vector if sentence-transformers installed, keyword fallback)
- `AgentMemory` — unified interface, auto-injects relevant past sessions into prompts

### core/health.py
Observability:
- `MetricsCollector` — counters, gauges, histograms (p50/p95/p99)
- `SessionRegistry` — tracks all active + recent sessions
- `HealthServer` — HTTP endpoints: `/health`, `/ready`, `/metrics`, `/sessions`
- `GracefulShutdown` — SIGTERM/SIGINT handler, waits for sessions to complete
- `setup_logging()` — structured JSON or plain logging, file output

### browser/browser_bot.py
CDP-native browser control via Playwright:
- Attach to live **Chrome, Edge, Brave, Arc** (`--remote-debugging-port=9222`)
- Or launch headless Chromium
- Or connect to Browserbase / Steel cloud
- `BrowserSession` — 25+ browser methods: navigate, act, extract, scroll, type, hover, drag, multi-tab, file download/upload, JS eval, iframe, cookies, network intercept
- `act()` — DOM-first with LLM selector resolution + vision fallback (Claude screenshot)
- Self-healing: stale selectors auto-removed and re-resolved

### agents/multi_agent.py
Hierarchical coordination:
- `SupervisorAgent` — decomposes goals with LLM, dependency-aware topological scheduling
- `WorkerAgent` — 8 roles: browser, researcher, extractor, coder, analyst, writer, verifier, planner
- `TaskQueue` — parallel or sequential batch execution with worker pool
- Max 4 workers (2026 coordination research: overhead dominates beyond 4)
- Each role gets specialized tools registered automatically

### budget/budget_manager.py
Gateway-level enforcement:
- Hard stops BEFORE API calls are made
- Per-session tokens + USD, daily USD, monthly USD
- Soft warnings at 80% + 95% of limits
- Auto-downgrade to cheaper model when budget tight
- Usage analytics, session history, export to JSON
- Optional JSONL persistence log

### tools/builtin_tools.py
16 production-ready tools:
`calculate`, `get_datetime`, `read_file`, `write_file`, `list_files`, `delete_file`, `web_search`, `fetch_url`, `http_request`, `run_python`, `run_shell`, `parse_json`, `extract_emails`, `extract_urls`, `text_summarize`, `sleep`

---

## Browser — Live Session

Launch Chrome/Edge/Brave with remote debugging, then attach:

```bash
# Chrome (macOS)
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --no-first-run

# Chrome (Windows)
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# Edge (Windows)
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222

# Brave (macOS)
/Applications/Brave\ Browser.app/Contents/MacOS/Brave\ Browser --remote-debugging-port=9222
```

Then:
```python
agent = BotAgent(browser_mode="live_chrome", cdp_url="http://localhost:9222")
await agent.browse("", "Summarize the current page")
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Claude API key | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `GOOGLE_API_KEY` | Gemini API key | — |
| `SERPER_API_KEY` | Google search via Serper | — |
| `BRAVE_SEARCH_API_KEY` | Brave Search API | — |
| `BROWSERBASE_API_KEY` | Browserbase cloud browser | — |
| `STEEL_API_KEY` | Steel cloud browser | — |
| `AGENT_MODEL` | Default model alias | `claude` |
| `AGENT_TOKEN_LIMIT` | Session token ceiling | `200000` |
| `AGENT_ITER_LIMIT` | Max ReAct iterations | `25` |
| `AGENT_SESSION_USD` | Per-session cost cap | `2.0` |
| `AGENT_DAILY_USD` | Daily cost cap | `20.0` |
| `AGENT_MONTHLY_USD` | Monthly cost cap | `100.0` |
| `BROWSER_MODE` | headless/live_chrome/browserbase | `headless` |
| `BROWSER_HEADLESS` | Run headless | `true` |
| `BROWSER_CDP_URL` | CDP attach URL | `http://localhost:9222` |
| `BROWSER_STEALTH` | Anti-detection | `true` |
| `SAVE_SESSIONS` | Persist session JSON | `false` |
| `LOG_LEVEL` | Logging verbosity | `INFO` |
| `LOG_FILE` | Log to file | — |
| `HEALTH_PORT` | Health server port | `8765` |

---

## Token Budget

```python
agent = BotAgent(
    token_limit    = 200_000,   # hard stop per session
    iteration_limit= 25,        # max ReAct loop iterations
    daily_usd_cap  = 20.0,      # gateway blocks calls over this
    monthly_usd_cap= 100.0,
)

print(agent.budget_status())
# {
#   "monthly_cost_usd": 1.23,  "monthly_pct": 1.2,
#   "daily_cost_usd":   0.45,  "daily_pct": 2.3,
#   "active_sessions":  1,     "total_tokens": 41200
# }
```

Budget is enforced at the **gateway level** — the agent literally cannot
make an API call that exceeds any limit.

---

## Health Endpoints

```bash
# Start health server (auto-started when health_enabled=True in config)
curl http://localhost:8765/health    # liveness
curl http://localhost:8765/ready     # readiness
curl http://localhost:8765/metrics   # full metrics snapshot
curl http://localhost:8765/sessions  # active + recent sessions
```

---

## Adding Custom Tools

```python
async def my_tool(query: str, limit: int = 10) -> dict:
    # your logic here
    return {"results": [...], "count": limit}

my_schema = {
    "name": "my_tool",
    "description": "Does something useful",
    "parameters": {"type": "object", "required": ["query"], "properties": {
        "query": {"type": "string"},
        "limit": {"type": "integer"},
    }},
}

result = await agent.react(
    "Use my_tool to find something",
    tools={"my_tool": (my_tool, my_schema)},
)
```

---

## Requirements

```
Python 3.11+
anthropic>=0.40.0           # Claude (required)
openai>=1.50.0              # GPT-4o (optional)
google-generativeai>=0.8.0  # Gemini (optional)
playwright>=1.48.0          # Browser (optional)
aiohttp>=3.10.0             # Web search + HTTP tools
python-dotenv>=1.0.0        # .env loading
sentence-transformers>=3.0  # Vector memory search (optional)
```
