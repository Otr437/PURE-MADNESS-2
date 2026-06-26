# Multi-Agent Harness

TypeScript parallel task harness across Claude, OpenAI, Groq, and DeepSeek using the Vercel AI SDK.

## Stack

- **Runtime**: Node.js 26 (Current) + `tsx` (no build step required)
- **AI SDK**: `ai` + `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/groq`, `@ai-sdk/deepseek`
- **Models (May 2026)**:
  | Provider | Model | Notes |
  |----------|-------|-------|
  | Anthropic | `claude-opus-4-7` | Latest Claude, xhigh reasoning |
  | OpenAI | `gpt-5.5-2026-04-23` | Flagship GPT-5.5 |
  | Groq | `openai/gpt-oss-120b` | GPT-OSS on Groq LPU |
  | DeepSeek | `deepseek-v4-pro` | 1M ctx, OpenAI-compatible |

---

## Setup

```bash
# 1. Clone / copy this folder
cd multi-agent-harness

# 2. Install dependencies
npm install

# 3. Set your API keys
cp .env.example .env
# Edit .env and fill in all four keys

# 4. Run
npm start
```

---

## Modes

Set `mode` in `src/index.ts`:

### `fan-out` (default)
Every agent runs every task simultaneously. Use this to compare all four providers on the same prompt side-by-side.

```
tasks:  [T1, T2]
agents: [Claude, GPT, Groq, DeepSeek]

Runs: Claude×T1, Claude×T2, GPT×T1, GPT×T2, Groq×T1, Groq×T2, DeepSeek×T1, DeepSeek×T2
All 8 run in parallel via Promise.all()
```

### `parallel-tasks`
Each agent gets a different task. All run simultaneously. Good for splitting a workload.

```
tasks:  [T1, T2, T3, T4]
agents: [Claude, GPT, Groq, DeepSeek]

Runs: Claude→T1, GPT→T2, Groq→T3, DeepSeek→T4  (all parallel)
```

### `pipeline`
Agents run sequentially. Each agent's output becomes the next agent's input. Only `tasks[0].prompt` is used as the seed. Good for staged refinement.

```
seed: tasks[0].prompt
→ Claude output → GPT input → GPT output → Groq input → Groq output → DeepSeek input → final output
```

---

## Customizing

### Change models
Edit the `agents` array in `src/index.ts`:

```ts
{
  id: "claude-fast",
  provider: "claude",
  model: "claude-sonnet-4-6",  // swap model here
  temperature: 0.5,
  maxTokens: 1024,
}
```

### Change tasks
Edit the `tasks` array in `src/index.ts`:

```ts
{
  id: "my-task",
  systemPrompt: "You are an expert in distributed systems.",
  prompt: "Design a fault-tolerant task queue in under 300 words.",
}
```

### Add a provider
1. Install the provider package: `npm install @ai-sdk/xai`
2. Import it in `src/agent.ts`
3. Add a case in the `getModel()` switch
4. Add your agent to the `agents` array in `src/index.ts`
5. Add `XAI_API_KEY` to `.env`

---

## Output

Results print to stdout with color-coded provider labels, duration, token usage, and a summary table:

```
════════════════════════════════════════════════════════════════════════════════
  MULTI-AGENT HARNESS RESULTS  [mode: FAN-OUT]
════════════════════════════════════════════════════════════════════════════════

[CLAUDE / claude-opus-4-7] Task: task-1 (1.84s)
────────────────────────────────────────────────────────────────────────────────
Fan-out parallelism disperses a single task across N agents simultaneously...

[OPENAI / gpt-5.5-2026-04-23] Task: task-1 (2.01s)
────────────────────────────────────────────────────────────────────────────────
The core tradeoff comes down to latency vs. correctness dependency...

...

════════════════════════════════════════════════════════════════════════════════
  SUMMARY
════════════════════════════════════════════════════════════════════════════════

Total wall time : 2.31s
Tasks           : 8 total | 8 succeeded | 0 failed

By provider:
  claude    tasks: 2  avg: 1.84s  no errors
  openai    tasks: 2  avg: 2.01s  no errors
  groq      tasks: 2  avg: 0.61s  no errors
  deepseek  tasks: 2  avg: 1.22s  no errors
```

---

## File Structure

```
multi-agent-harness/
├── src/
│   ├── index.ts              ← entry point, config (agents, tasks, mode)
│   ├── harness.ts            ← orchestrator (fan-out, pipeline, parallel-tasks)
│   ├── agent.ts              ← single agent runner, provider routing
│   ├── agent-stream.ts       ← streaming agent runner (live token output)
│   ├── agent-tools.ts        ← tool-calling agent (calculator, fetch_json, web_search)
│   ├── agent-production.ts   ← production wrapper (rate limit + circuit breaker + retry + cost)
│   ├── sub-agent.ts          ← orchestrator → worker decomposition + synthesis
│   ├── browser-tools.ts      ← Playwright browser tools (navigate, click, type, etc.)
│   ├── auth.ts               ← PIN-gated HMAC session tokens with lockout
│   ├── crypto-vault.ts       ← AES-256-GCM vault, PBKDF2 key derivation
│   ├── wallet-manager.ts     ← EVM / BTC / Zcash HD wallet, approval-gated TX
│   ├── security-middleware.ts← auth + input validation gate on every tool call
│   ├── input-validator.ts    ← centralized input validation for all methods
│   ├── prompt-guard.ts       ← prompt injection detection + sanitization
│   ├── session-manager.ts    ← session rotation, fingerprinting, replay defense
│   ├── secrets-manager.ts    ← centralized secret access (no scattered process.env)
│   ├── config-validator.ts   ← startup env validation, fails fast
│   ├── context-manager.ts    ← sliding-window / priority-prune context management
│   ├── concurrency.ts        ← semaphore-based concurrency limiter
│   ├── resilience.ts         ← retry with backoff + per-provider circuit breaker
│   ├── rate-limiter.ts       ← token-bucket rate limiter per provider
│   ├── cost-tracker.ts       ← token usage + USD cost tracking with ceiling
│   ├── observability.ts      ← structured tracing, JSONL span log
│   ├── merkle-log.ts         ← off-chain Merkle audit log for all actions
│   ├── scheduler.ts          ← autonomous task scheduler, auth-gated
│   ├── task-queue.ts         ← priority task queue with retry and drain
│   ├── fallback-chain.ts     ← ordered provider fallback on failure
│   ├── evaluator.ts          ← LLM-as-judge scoring + leaderboard
│   ├── printer.ts            ← color-coded terminal output
│   ├── writer.ts             ← save results to JSON + Markdown
│   ├── types.ts              ← all TypeScript interfaces
│   ├── run-stream.ts         ← entry: streaming harness
│   ├── run-tools.ts          ← entry: tool-calling harness
│   ├── run-production.ts     ← entry: full production harness
│   ├── run-orchestrate.ts    ← entry: sub-agent orchestration
│   └── run-browser.ts        ← entry: secure browser bot REPL
├── .env.example              ← copy to .env, fill in keys
├── package.json
└── tsconfig.json
```

---

## API Keys

| Provider | Get key at |
|----------|-----------|
| Anthropic | https://console.anthropic.com |
| OpenAI | https://platform.openai.com/api-keys |
| Groq | https://console.groq.com/keys |
| DeepSeek | https://platform.deepseek.com |
