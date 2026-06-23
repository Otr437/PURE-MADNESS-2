# AI Blockchain Ops — Local Production Platform

An AI-powered local blockchain operations platform. Claude orchestrates all operations. Full meme token launch, contract compilation/deployment, gas management, wallet ops, Stellar payments, Soroban smart contracts, asset issuance — all from a local web UI.

## Architecture

| Module | Port | Role |
|--------|------|------|
| module1-relevance-gate | 3001 | DeepSeek — gates all content before AI sees it |
| module2-auditor | 3002 | Gemini — audits all AI output + Solidity/WASM security |
| module3-orchestrator | 3003 | Claude — AI team lead, executes all instructions |
| module4-gateway | 3004 | Public entry point, auth enforcement, rate limiting |
| module5-mcp | 3005 | Tools: web_fetch, cast_call, eth_rpc, forge_build, etc. |
| module6-database | 3006 | PostgreSQL persistence for everything |
| module7-auth | 3007 | OAuth2 — login, tokens, scopes |
| module8-secrets | 3008 | AES-256-GCM encrypted secrets manager |
| module9-events | 3009 | SSE + webhook event bus |
| module10-admin | 3010 | Full system control dashboard |
| module11-blockchain | 3011 | **EVM blockchain engine** — compile, deploy, transact |
| module12-frontend | 3012 | **Local web UI** — dashboard, meme launcher, IDE |
| module13-nova | 3013 | Amazon Nova fallback AI |
| module14-voice | 3014 | ElevenLabs voice alerts |
| module15-stellar | 3015 | **Stellar engine** — payments, assets, Soroban contracts |

## Stellar Features (Module 15)

Module 15 adds full Stellar Network support:

- **Payments** — XLM and custom asset payments with sequence management and replay protection
- **Account ops** — create accounts, fund testnet via Friendbot, multi-signature configuration
- **Asset issuance** — issue custom assets with clawback, authorization flags, home domain
- **Clawback** — reclaim assets from holder accounts (requires clawback flag on issuer)
- **DEX** — manage sell offers, cancel offers, query order books
- **Path payments** — cross-asset swaps via Stellar's built-in DEX, automatic path finding
- **Soroban contracts** — deploy WASM smart contracts, invoke methods, read contract state
- **Federation** — resolve `name*domain.com` federation addresses
- **Security** — sequence number cache (replay prevention), internal token auth, audit gate before deploy, rate limiting, input validation via Zod

### Stellar API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Module health + SDK/CLI availability |
| GET | `/networks` | List configured Stellar networks |
| GET | `/account?network=&accountId=` | Account info and balances |
| GET | `/account/transactions` | Account transaction history |
| GET | `/account/payments` | Account payment history |
| GET | `/account/offers` | Account open DEX offers |
| POST | `/account/fund-testnet` | Friendbot fund (testnet only) |
| POST | `/account/create` | CreateAccount operation |
| POST | `/keypair/generate` | Generate a new Stellar keypair |
| POST | `/payment` | Send XLM or custom asset |
| POST | `/payment/path` | Path payment (cross-asset swap) |
| GET | `/payment/paths` | Find available payment paths |
| POST | `/asset/issue` | Issue a new Stellar asset |
| POST | `/asset/clawback` | Clawback asset from holder |
| GET | `/asset/info` | Asset metadata via Horizon |
| POST | `/multisig/configure` | Set account signers and thresholds |
| POST | `/dex/offer` | Create or modify sell offer |
| DELETE | `/dex/offer` | Cancel a sell offer |
| GET | `/dex/orderbook` | Query DEX order book |
| POST | `/contract/deploy` | Deploy Soroban WASM contract |
| POST | `/contract/invoke` | Invoke Soroban contract method |
| GET | `/contract/state` | Read Soroban contract state |
| GET | `/contracts` | List deployed Soroban contracts |
| GET | `/transactions` | Stellar transaction history |
| GET | `/federation?address=` | Resolve federation address |
| GET | `/fee-stats` | Current network fee statistics |
| GET | `/ledger` | Latest ledger info |
| GET | `/sequence` | View sequence lock state |
| DELETE | `/sequence/:network/:accountId` | Clear sequence lock |

## Prerequisites

- **Node.js 22+** — `node --version`
- **PostgreSQL 16+** — local or Docker
- **Foundry** (recommended for EVM) — `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- **Stellar CLI** (optional, for Soroban contract deploy) — `cargo install --locked stellar-cli`
- API keys: Anthropic, DeepSeek, Gemini

## Stellar Setup

```bash
# Install Stellar SDK (included in npm install)
npm install

# Testnet — get a free keypair and fund it via Friendbot
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"

# Add to .env:
# STELLAR_SECRET_KEY_TESTNET=S...   (your testnet secret key)
# STELLAR_SECRET_KEY=S...            (mainnet — only when ready)

# Optional: install Stellar CLI for Soroban contract deployment
cargo install --locked stellar-cli --features opt
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set INTERNAL_SERVICE_TOKEN, SECRETS_MASTER_KEY, DATABASE_URL, API keys

# 3. Create database
psql -U postgres -c "CREATE DATABASE aiblockchain;"

# 4. Start all modules
npm run start:all

# 5. Open browser
open http://localhost:3012
```

## Quick Start with Docker PostgreSQL

```bash
docker run -d --name postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=aiblockchain \
  -p 5432:5432 postgres:16
```

## Starting Individual Modules

```bash
# Must start in this order (dependencies first):
npm run start:module6   # Database first
npm run start:module9   # Events
npm run start:module7   # Auth
npm run start:module8   # Secrets (seeding after 3s)
npm run start:module1   # Relevance Gate
npm run start:module2   # Auditor
npm run start:module5   # MCP
npm run start:module3   # Orchestrator (Claude)
npm run start:module4   # Gateway
npm run start:module10  # Admin
npm run start:module11  # Blockchain Engine
npm run start:module12  # Frontend (localhost:3012)
```

## API Examples

### Login
```bash
curl -X POST http://localhost:3004/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}'
```

### Launch a Meme Token
```bash
curl -X POST http://localhost:3011/meme-token \
  -H 'Content-Type: application/json' \
  -H 'x-aiops-service-token: YOUR_INTERNAL_TOKEN' \
  -d '{
    "chainId": 31337,
    "from": "0xYourAddress",
    "config": {
      "name": "Pepe Rocket",
      "symbol": "PRKT",
      "totalSupply": "1000000000",
      "decimals": 18,
      "mintable": false,
      "burnable": true,
      "taxBuyPercent": 3,
      "taxSellPercent": 5,
      "maxWalletPercent": 2,
      "maxTxPercent": 1
    },
    "deployOnly": true
  }'
```

### Compile Solidity
```bash
curl -X POST http://localhost:3011/compile \
  -H 'Content-Type: application/json' \
  -H 'x-aiops-service-token: YOUR_INTERNAL_TOKEN' \
  -d '{
    "contractName": "MyToken",
    "source": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\ncontract MyToken {}"
  }'
```

### Ask Claude (AI Assistant)
```bash
curl -X POST http://localhost:3004/run \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"Write a production ERC20 token with 1% buy tax and 2% sell tax","requiresAudit":true}'
```

### Get Gas Prices
```bash
curl "http://localhost:3011/gas?chainId=1" \
  -H 'x-aiops-service-token: YOUR_INTERNAL_TOKEN'
```

### Raw RPC Call
```bash
curl -X POST http://localhost:3011/rpc \
  -H 'Content-Type: application/json' \
  -H 'x-aiops-service-token: YOUR_INTERNAL_TOKEN' \
  -d '{"chainId": 1, "method": "eth_blockNumber", "params": []}'
```

## Security Notes

- `WALLET_PRIVATE_KEY` never leaves the server — all signing is done in module11
- All module-to-module calls require `INTERNAL_SERVICE_TOKEN`
- All secrets encrypted at rest with AES-256-GCM in module8
- All Solidity goes through gate (DeepSeek) + audit (Gemini) before compilation
- Transactions are simulated via `eth_call` before broadcasting
- Rate limiting: 60 req/min on gateway, 30 req/min on blockchain engine

## Supported Chains

| Chain | chainId |
|-------|---------|
| Ethereum | 1 |
| Base | 8453 |
| Arbitrum | 42161 |
| Optimism | 10 |
| Polygon | 137 |
| BSC | 56 |
| Sepolia (testnet) | 11155111 |
| Base Sepolia (testnet) | 84532 |
| Localhost (anvil) | 31337 |

## MCP Tools Available to Claude

| Tool | Description |
|------|-------------|
| `web_fetch` | Fetch any HTTPS URL |
| `package_lookup` | Check npm package versions |
| `run_typescript` | Execute TS snippets |
| `read_file` | Read files from /workspace |
| `cast_call` | Call read-only contract functions via Foundry cast |
| `eth_rpc` | Raw JSON-RPC calls to any EVM node |
| `forge_build` | Compile Solidity via Foundry |
| `abi_decode` | Decode ABI-encoded data |
| `gas_estimate` | Get live gas prices for any chain |
