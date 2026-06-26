# PEAQ FORGE v1

peaq Network Dev Console — production-grade local web UI for building, deploying, and interacting with contracts on peaq Mainnet, Agung Testnet, Krest Network, and local dev chains.

## Modules

| Module | Description |
|---|---|
| **peaq EVM / Hardhat** | Compile, test, deploy, verify Solidity via Hardhat · cast call/send · Anvil local node |
| **Foundry** | `forge build/test/create/script` · `cast` · `anvil` against peaq EVM |
| **ink!** | `cargo contract new/build/check/test/instantiate/call` for Wasm contracts |
| **Substrate** | Local node, cargo build/check, JSON-RPC calls via WebSocket |
| **peaq DID** | Create, read, update, remove machine DIDs via `@peaq-network/sdk` |
| **peaq Storage** | Add, get, update, remove on-chain machine data |
| **peaq RBAC** | Add roles, assign roles to users, add permissions |
| **Machine NFT** | ownerOf, tokenURI, getDID, bindDID via `cast` |

## Requirements

- **Node.js ≥ 24** (Active LTS as of 2026)
- **npm ≥ 10**
- **Foundry** (`forge`, `cast`, `anvil`) — for EVM/Foundry modules
- **Rust + cargo-contract** — for ink! module
- **Substrate node binary** — for Substrate module (optional)

## Quick Start

```bash
# 1. Install npm dependencies
npm install

# 2. Copy and configure environment
cp .env.example .env
# Edit .env — set PEAQ_FORGE_TOKEN to persist auth token across restarts

# 3. Check that tools are available
npm run check

# 4. Start in production mode
npm start

# 5. Open browser
open http://127.0.0.1:3048
# Paste the auth token printed in the console
```

## Install Dev Tools

```bash
# Installs Foundry + cargo-contract
npm run install:tools
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3048` | HTTP port to listen on |
| `HOST` | `127.0.0.1` | Bind address (localhost only by default) |
| `PEAQ_FORGE_TOKEN` | *(auto-generated)* | Auth token — set to persist across restarts |
| `LOG_LEVEL` | `info` | winston log level (`debug`, `info`, `warn`, `error`) |
| `ALLOWED_ORIGINS` | *(localhost)* | Comma-separated allowed CORS origins for hosted installs |
| `SSL_KEY_PATH` | — | Path to TLS private key for HTTPS mode |
| `SSL_CERT_PATH` | — | Path to TLS certificate for HTTPS mode |
| `PEAQ_MAINNET_RPC` | `https://peaq.api.onfinality.io/public` | peaq Mainnet RPC |
| `PEAQ_AGUNG_RPC` | `https://rpcpc1-qa.agung.peaq.network` | Agung Testnet RPC |
| `PEAQ_KREST_RPC` | `https://erpc.krest.peaq.network` | Krest Network RPC |
| `PEAQ_MAINNET_WS` | `wss://wss.peaq.network` | peaq Mainnet WebSocket |
| `PEAQ_AGUNG_WS` | `wss://wss.agung.peaq.network` | Agung WebSocket |
| `PEAQ_KREST_WS` | `wss://krest.peaq.network` | Krest WebSocket |

## Security

- All API routes require `X-Forge-Token` header authentication
- Brute-force lockout: 10 failed attempts → 15-minute lockout per IP
- WebSocket auth required before any command is accepted
- Rate limiting: 120 req/min on API, 120 msg/min per WebSocket
- All shell commands run with `shell: false` — no shell injection possible
- Private keys redacted in all logs and terminal output
- Helmet + strict CSP headers on all responses
- Path traversal blocked on all file-serving routes
- Deploy log stored with `0o600` permissions (owner-only)

## Networks

| Network | Chain ID | RPC |
|---|---|---|
| peaq Mainnet | 3338 | `https://peaq.api.onfinality.io/public` |
| Agung Testnet | 9990 | `https://rpcpc1-qa.agung.peaq.network` |
| Krest Network | 2241 | `https://erpc.krest.peaq.network` |
| Local Dev | 4242 | `http://127.0.0.1:8545` (Anvil) |

## npm Scripts

| Script | Description |
|---|---|
| `npm start` | Start in production mode |
| `npm run dev` | Start with nodemon (auto-restart on changes) |
| `npm run stop` | Stop the running server |
| `npm run restart` | Stop and restart |
| `npm run check` | Check all required tools are installed |
| `npm run install:tools` | Install Foundry + cargo-contract |
| `npm test` | Run unit + integration tests |
| `npm run audit` | Run npm security audit |

## Architecture

```
server.js              → HTTP/HTTPS server + graceful shutdown
src/
  app.js               → Express app, middleware, routes
  config/index.js      → Centralised config from env
  middleware/
    auth.js            → Token auth + brute-force protection
    rateLimiter.js     → express-rate-limit (API + strict)
    errorHandler.js    → Global error + 404 handlers
  routes/
    api.js             → Route aggregator
    tools.js           → GET /api/tools — tool version check
    contracts.js       → GET /api/contracts, /api/abi
    config.js          → GET /api/config
    deployments.js     → GET/DELETE /api/deployments
    admin.js           → GET /api/admin/status, DELETE /api/admin/kill-all
  modules/
    evm/hardhat.service.js    → Hardhat compile/test/deploy/verify
    foundry/foundry.service.js → forge/cast/anvil wrappers
    ink/ink.service.js        → cargo-contract wrappers
    substrate/substrate.service.js → Substrate node + RPC
    did/did.service.js        → peaq DID via SDK
    storage/storage.service.js → peaq Storage via SDK
    rbac/rbac.service.js      → peaq RBAC via SDK
    mnft/mnft.service.js      → Machine NFT via cast
  utils/
    runner.js          → Secure child_process spawn wrapper
    logger.js          → Winston logger with secret redaction
    sanitize.js        → Input sanitisation + validation
    deployLog.js       → Persistent deploy history (~/.peaq_forge_deployments.json)
  websocket/handler.js → Authenticated WS command dispatcher
public/index.html      → Single-file frontend (no build step)
logs/                  → Rotating log files (error, combined, exceptions, rejections)
```

## Logs

Logs are written to `./logs/`:
- `combined.log` — all levels, 10MB max, 5 files rotating
- `error.log` — errors only, 5MB max, 3 files rotating
- `exceptions.log` / `rejections.log` — uncaught exceptions and rejections
