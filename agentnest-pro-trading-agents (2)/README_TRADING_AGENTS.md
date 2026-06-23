# AgentNest Pro × STRATS — Trading Strategy Agents

## What's in this package
- `agentnest-pro/` — your AgentNest Pro server with 9 new trading agent types wired in.
- `STRATS/` — your original strategy bots, unmodified.

## The 9 new agent types
| Agent type | Operates strategy | Default mode |
|---|---|---|
| cross-exchange-arbitrageur | cross-exchange-arb | dry-run |
| triangular-arbitrageur | triangular-arb | dry-run |
| cash-and-carry-trader | cash-carry | dry-run |
| dca-strategist | dca | dry-run |
| grid-trader | grid | dry-run |
| trend-follower | trend-following | dry-run |
| momentum-scalper | momentum-scalp | dry-run |
| mean-reversion-trader | mean-reversion | dry-run |
| seasonal-trader | seasonal | dry-run |

Each agent operates the REAL script in `STRATS/` as a child process via the new
`tradingBotControl` tool — it does not reimplement the strategy logic.

## Files changed/added in agentnest-pro
- NEW `server/services/strategies/registry.ts` — metadata for all 9 bots (env params, risk guards).
- NEW `server/services/tools/tradingBotControl.ts` — start/stop/status/logs tool, dry-run by default.
- EDIT `server/services/agentSpecialties.ts` — added the 9 specialty system prompts.
- EDIT `server/services/agentDefinitions.ts` — added the 9 UI-facing agent definitions.
- EDIT `server/services/reactLoop.ts` — registered the new tool import, AND fixed a pre-existing
  gap where any agent type could invoke any registered tool by name (not just its own allowed
  tools). This was a safety-relevant fix made necessary by adding a tool that can move money.
- EDIT `server/db/index.ts` — added two settings: `STRATEGY_SCRIPTS_ROOT`, `LIVE_TRADING_ENABLED`.
- EDIT `server/routes/agents.ts` — fixed a broken import (`../../src/types/agents.js` does not
  exist anywhere in the uploaded zip); now sources agent metadata from the real, existing
  `server/services/agentDefinitions.ts` registry instead.

## Two things you need to know before running this
1. **`src/types/agents.ts` and the whole client app are missing from your upload.**
   The server-side route that created/edited agents imported from that path. I repointed it
   at the real registry rather than guessing at a duplicate file — but if you have a separate
   frontend agent-picker elsewhere in your actual project, make sure it also lists these 9 new
   `agent_type` values so they're selectable in the UI.
2. **Your STRATS scripts depend on `../../shared/base_bot.js`, `../../shared/exchange_client.js`,
   and (mean-reversion/seasonal only) `../../../infrastructure/db/database.js`.** None of those
   three files were in the STRATS zip. They must already exist in your real project tree one
   level above wherever you point `STRATEGY_SCRIPTS_ROOT`. If they don't exist yet, starting any
   bot will fail with a clear "module not found" error in the agent's logs — it won't silently
   pretend to run.

## How to turn live trading on (it's off by default everywhere)
Live trading requires ALL of:
1. Setting `LIVE_TRADING_ENABLED` = `"true"` (global kill switch): `PUT /api/settings/LIVE_TRADING_ENABLED`
2. The specific agent's `capabilities` including `"liveTrading"`: `PATCH /api/agents/:id { "capabilities": [..., "liveTrading"] }`
3. A `financial_accounts` row with `type = "exchange"` (use `address_or_id` for API key, `spend_key` for API secret).
4. The task that starts the bot being approved if `requires_approval` was set.

Any one of these missing → the bot runs in dry-run regardless of what's requested, and the tool
output says exactly which gate blocked it.

## Setup
1. Set `STRATEGY_SCRIPTS_ROOT` to the absolute path of your real `STRATS` folder (the one that
   sits next to your actual `shared/` and `infrastructure/` directories) via the Settings API.
2. `npm install` in `agentnest-pro/` (node_modules were excluded from this export).
3. Type-checks clean: `npx tsc --noEmit -p tsconfig.json` (verified before delivery).
