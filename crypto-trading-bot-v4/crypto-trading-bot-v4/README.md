# crypto-trading-bot v4

Each strategy is **its own process**. They share nothing in memory.
They communicate only through PostgreSQL (trade state) and Redis (pub/sub control signals).

## Structure

```
src/
  shared/
    base_bot.js          ← BaseBot extended by every strategy
    exchange_client.js   ← Generic REST exchange client
    indicators.js        ← Pure math — SMA, EMA, RSI, MACD, BB, ATR, Z-score, etc.
  strategies/
    cross-exchange-arb/index.js   ← Own process
    triangular-arb/index.js       ← Own process
    cash-carry/index.js           ← Own process
    dca/index.js                  ← Own process
    grid/index.js                 ← Own process
    trend-following/index.js      ← Own process
    momentum-scalp/index.js       ← Own process
    mean-reversion/index.js       ← Own process
    seasonal/
      index.js                    ← Seasonal buy-low/sell-high bot
      engine.js                   ← Pattern computation engine
      ingestion/index.js          ← 3yr OHLCV data pipeline
infrastructure/
  db/database.js         ← PostgreSQL + Redis
  db/schema.sql          ← Full schema
  auth/auth.js           ← Auth0 M2M + token bucket
  rpc/rpc.js             ← EVM + Solana RPC
  logger/logger.js       ← Structured logs + Telegram
api/
  server.js              ← REST API (Express)
  routes/bots.js
  routes/admin.js
scripts/
  migrate.js             ← Apply schema
  seed.js                ← Insert default bots
  reset.js               ← Dev only, requires --confirm
```

## Setup

```bash
npm install
cp .env.example .env   # fill in all values
npm run db:migrate
npm run db:seed
```

## Run

Each strategy is its own process — start only what you need:

```bash
DRY_RUN=true npm run bot:dca           # DCA bot
DRY_RUN=true npm run bot:grid          # Grid bot
DRY_RUN=true npm run bot:trend         # Trend following
DRY_RUN=true npm run bot:scalp         # Momentum scalp
DRY_RUN=true npm run bot:cross-arb     # Cross-exchange arbitrage
DRY_RUN=true npm run bot:tri-arb       # Triangular arbitrage
DRY_RUN=true npm run bot:cash-carry    # Cash & carry
DRY_RUN=true npm run bot:mean-reversion# Mean reversion (Z-score + BB)
DRY_RUN=true npm run bot:seasonal      # Seasonal buy-low/sell-high

npm run data:ingest    # Fetch 3yr OHLCV history (run before seasonal bot)
npm run data:patterns  # Compute seasonal patterns from stored data
npm run api            # REST API server
```

## Why separate processes

- One bot crashes → others keep running
- Deploy a fix to grid bot → restart only grid bot
- Scale scalp bot to more compute → only scalp bot, not everything
- Test any strategy in isolation with no side effects
- No shared in-process state — all state lives in Postgres + Redis
