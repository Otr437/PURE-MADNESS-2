# lb-sharding-monorepo

Production-grade TypeScript **Load Balancer** and **Sharding System** — zero runtime dependencies, built as a workspace monorepo.

---

## Architecture

```
lb-sharding-monorepo/
├── packages/
│   ├── core/            # Types, utils, consistent-hash ring, logger
│   ├── load-balancer/   # All LB algorithms + circuit breaker
│   ├── health-checker/  # HTTP / TCP / gRPC health probes
│   ├── shard-manager/   # Sharding strategies + rebalancer
│   ├── metrics/         # Prometheus-compatible metrics registry
│   └── cli/             # lbctl command-line tool
└── apps/
    └── gateway/         # Production HTTP reverse-proxy server
```

---

## Load Balancing Algorithms

| Algorithm | Class | Description |
|---|---|---|
| `round-robin` | `RoundRobinSelector` | Equal distribution, stateless counter |
| `weighted-round-robin` | `WeightedRoundRobinSelector` | Smooth WRR — zero jitter, dynamic weights |
| `least-connections` | `LeastConnectionsSelector` | Routes to node with fewest active conns (weighted) |
| `least-response-time` | `LeastResponseTimeSelector` | Score = EMA(latency) × (connections+1) |
| `ip-hash` | `IpHashSelector` | Murmur3 of client IP — sticky per client |
| `consistent-hash` | `ConsistentHashSelector` | Virtual-node ring — minimal reshuffling on change |
| `random` | `RandomSelector` | Uniform random — fast, good baseline |
| `resource-based` | `ResourceBasedSelector` | Power-of-two-choices with CPU/memory scoring |
| `sticky-session` | `StickySessionSelector` | Cookie/header-based session affinity |

---

## Sharding Strategies

| Strategy | Description |
|---|---|
| `consistent-hash` | Virtual-node ring, minimal key movement on topology change |
| `range` | Hash-range partitioning, deterministic boundaries |
| `modulo` | `hash(key) % shardCount` — simple, fast |
| `directory` | Explicit prefix→shard mapping, full control |
| `geographic` | Alias for consistent-hash (extend for geo-awareness) |

---

## Quick Start

### With Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Ports:
- `:8080` — proxy (forwards to backends)
- `:9000` — admin API
- `:9090` — Prometheus metrics

### Build from source

```bash
npm ci
npm run build --workspace=packages/core
npm run build --workspace=packages/load-balancer
npm run build --workspace=packages/health-checker
npm run build --workspace=packages/shard-manager
npm run build --workspace=packages/metrics
npm run build --workspace=apps/gateway
```

### Run gateway

```bash
BACKEND_NODES=localhost:3001,localhost:3002 \
LB_ALGORITHM=least-connections \
node apps/gateway/dist/server.js
```

---

## Admin API

All endpoints on `ADMIN_PORT` (default `9000`).

| Method | Path | Description |
|---|---|---|
| GET | `/admin/status` | Pool stats, circuit breakers, shard stats |
| GET | `/admin/config` | Active configuration |
| GET | `/admin/nodes` | List all nodes |
| POST | `/admin/nodes` | Add a node `{host, port, weight?, protocol?, tags?}` |
| DELETE | `/admin/nodes/:id` | Remove a node |
| POST | `/admin/nodes/:id/drain` | Gracefully drain a node |
| GET | `/admin/nodes/:id/metrics` | Per-node metrics snapshot |
| GET | `/admin/shards` | List shards (requires `SHARDING_ENABLED=true`) |
| POST | `/admin/shards/rebalance` | Force rebalance |
| GET | `/admin/shards/resolve/:key` | Resolve a shard key |
| GET | `/admin/metrics` | JSON metrics snapshot |
| GET | `/health` | Liveness probe |

---

## CLI — lbctl

```bash
# Build CLI
npm run build --workspace=packages/cli
node packages/cli/dist/cli.js --help

# List nodes
node packages/cli/dist/cli.js nodes list --api-url http://localhost:9000

# Add a node
node packages/cli/dist/cli.js nodes add

# Drain a node
node packages/cli/dist/cli.js nodes drain node_abc123

# Force shard rebalance
node packages/cli/dist/cli.js shards rebalance

# Prometheus metrics
node packages/cli/dist/cli.js metrics

# One-shot health check
node packages/cli/dist/cli.js health localhost:3001
```

---

## Metrics (Prometheus)

Scrape endpoint: `http://gateway:9090/metrics`

| Metric | Type | Description |
|---|---|---|
| `lb_requests_total` | counter | Total requests routed |
| `lb_errors_total` | counter | Total routing errors |
| `lb_active_connections` | gauge | Current active connections |
| `lb_healthy_nodes` | gauge | Currently healthy node count |
| `lb_node_rps{node}` | gauge | Requests/sec per node |
| `lb_node_error_rate{node}` | gauge | Error rate 0–1 per node |
| `lb_node_p50_ms{node}` | gauge | P50 latency per node |
| `lb_node_p95_ms{node}` | gauge | P95 latency per node |
| `lb_node_p99_ms{node}` | gauge | P99 latency per node |
| `lb_node_connections{node}` | gauge | Active connections per node |

---

## Production Checklist

- [x] Circuit breaker per node (closed / open / half-open)
- [x] Exponential moving average latency tracking
- [x] Graceful shutdown (SIGTERM / SIGINT)
- [x] Hop-by-hop header stripping
- [x] `X-Forwarded-For` / `X-Real-IP` propagation
- [x] Request ID tracing (`X-Request-Id`)
- [x] Keep-alive connection pooling
- [x] Health check with configurable thresholds
- [x] Prometheus metrics exposition
- [x] Multi-stage Docker build (non-root user)
- [x] Environment-driven configuration
- [x] Structured JSON logging (production) / pretty (dev)

---

## Environment Variables

See `.env.example` for the full list.

---

## License

MIT
