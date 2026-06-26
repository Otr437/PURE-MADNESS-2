# Autonomous Agent RTOS v4.0 — Monorepo

## Structure

```
autonomous-agent-rtos/
├── packages/
│   ├── shared-crypto/       # AES-256-GCM EncryptionService
│   ├── shared-types/        # All shared TypeScript interfaces
│   └── shared-logger/       # Structured execution logger
├── services/
│   ├── cve-monitor/         # 24/7 NVD + CISA KEV monitor
│   ├── oauth/               # OAuth 2.1 + PKCE service
│   ├── agent-runtime/       # Agent registry, templates, lifecycle
│   └── api-gateway/         # MCP server entry point (all tools)
├── infra/                   # Docker / deployment configs
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

## Prerequisites

- Node.js >= 20
- pnpm >= 9

## Install & Build

```bash
pnpm install
pnpm build
```

## Run

```bash
cd services/api-gateway
AGENT_MASTER_KEY=<hex> NVD_API_KEY=<key> node dist/index.js
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AGENT_MASTER_KEY` | No | 32-byte hex master key (auto-generated if omitted) |
| `NVD_API_KEY` | No | NVD API key for higher rate limits |
