# Rust Load Balancer & Sharding Monorepo

Production-grade reverse proxy and sharding system written in Rust. Zero unsafe code. Zero stubs. Fully deployable.

---

## Architecture

```
                         ┌─────────────────────────┐
   Internet Traffic ───► │     load-balancer        │ :8080 (proxy)
                         │   Admin API              │ :9090 (admin/metrics)
                         └────────────┬────────────┘
                                      │ algorithm selection
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                   ▼
              Backend :8001     Backend :8002       Backend :8003

   Sharding (optional) ────► shard-manager :7070
   Health polling       ────► health-checker :6060
```

---

## Services

| Service | Port | Responsibility |
|---|---|---|
| `load-balancer` | 8080 / 9090 | Reverse proxy, algorithm selection, metrics |
| `shard-manager` | 7070 | Shard topology registry, key-to-shard lookup |
| `health-checker` | 6060 | Standalone backend health polling daemon |

## Shared Packages

| Package | Purpose |
|---|---|
| `lb-core` | Traits, types, algorithms, shard logic, circuit breaker |
| `metrics-core` | Prometheus metrics registry and helpers |
| `lb-tracing` | Structured JSON logging init, correlation ID utilities |

---

## Load Balancing Algorithms

All algorithms skip unhealthy backends and respect circuit breaker state.

| Algorithm | Config key | Description |
|---|---|---|
| Round Robin | `round_robin` | Even sequential distribution |
| Weighted Round Robin | `weighted_round_robin` | Proportional by `weight` field |
| Least Connections | `least_connections` | Route to backend with fewest active connections |
| Weighted Least Connections | `weighted_least_connections` | `connections / weight` — lower score wins |
| Random | `random` | Uniform random selection |
| IP Hash | `ip_hash` | SHA-256(client_ip) — same client always hits same backend |
| URL Hash | `url_hash` | SHA-256(request_path) — same path hits same backend (cache affinity) |
| Least Response Time | `least_response_time` | Routes to backend with lowest EMA latency |
| Consistent Hash Ring | `consistent_hash` | Minimal reshuffling when backends added/removed |

Switch algorithm at runtime by updating config and restarting (hot-reload support planned via SIGHUP).

---

## Sharding

Three strategies:

- **Consistent Hash** (`consistent_hash`) — virtual node ring, minimal key remapping on topology changes
- **Modulo** (`modulo`) — `hash(key) % shard_count` — simple, use when shard count is stable
- **Range** (`range`) — lexicographic key ranges mapped to shard IDs

The shard key is read from a configurable HTTP header (`x-shard-key` by default). If absent, falls back to client IP.

---

## Quick Start

### Local (without Docker)

```bash
# Run load balancer
cd services/load-balancer
cargo run --release -- --config config/lb.toml

# Run shard manager
cd services/shard-manager
cargo run --release

# Run health checker
cd services/health-checker
cargo run --release
```

### Docker Compose

```bash
cd infra/docker
docker compose up --build
```

Services:
- Load balancer proxy: http://localhost:8080
- Load balancer admin: http://localhost:9090
- Shard manager:       http://localhost:7070
- Health checker:      http://localhost:6060
- Prometheus:          http://localhost:9091

---

## Configuration

All config values can be overridden with environment variables using `LB__` prefix and `__` as separator:

```bash
LB__SERVER__PORT=9000
LB__ALGORITHM__KIND=least_connections
LB__OBSERVABILITY__LOG_LEVEL=debug
```

See `services/load-balancer/config/lb.toml` for the full reference with all options documented.

---

## Admin API

All admin endpoints are on port `9090`:

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Liveness probe — always 200 if process is up |
| `/ready` | GET | Readiness probe — 503 if no healthy backends |
| `/metrics` | GET | Prometheus text metrics |
| `/admin/backends` | GET | Per-backend status, connections, latency, circuit breaker state |
| `/admin/stats` | GET | Aggregate: backend counts, shard count, active algorithm |

---

## Shard Manager API

All on port `7070`:

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Liveness |
| `/shards` | GET | List shard count |
| `/shards` | POST | Register a shard `{"id": 0, "backend_ids": [...], "replica_count": 1}` |
| `/shards/{id}` | GET | Get backends for shard |
| `/shards/{id}` | DELETE | Remove shard |
| `/lookup` | POST | Map key to shard `{"key": "user:123"}` |
| `/topology` | GET | Full topology summary |

---

## Metrics

Key Prometheus metrics exposed at `:9090/metrics`:

| Metric | Type | Description |
|---|---|---|
| `lb_requests_total` | Counter | Total requests by method, path, status, algorithm |
| `lb_requests_in_flight` | Gauge | Current in-flight request count |
| `lb_request_duration_seconds` | Histogram | End-to-end request latency |
| `lb_backend_connections_active` | Gauge | Active connections per backend |
| `lb_backend_requests_total` | Counter | Requests forwarded per backend |
| `lb_backend_errors_total` | Counter | Errors per backend by kind |
| `lb_backend_health_status` | Gauge | 1=healthy, 0=unhealthy per backend |
| `lb_circuit_breaker_state` | Gauge | 0=closed, 1=open, 2=half_open |
| `lb_upstream_latency_seconds` | Histogram | Upstream-only latency per backend |
| `lb_shard_requests_total` | Counter | Requests per shard |
| `lb_rate_limit_hits_total` | Counter | Rate-limited requests by key |

---

## Circuit Breaker

Each backend has an independent circuit breaker with three states:

- **Closed** (normal) — all requests pass through
- **Open** (tripped) — all requests rejected immediately; backend bypassed
- **Half-Open** (recovery probe) — limited requests allowed to test backend recovery

Thresholds (configurable in code, env-configurable in a future release):
- Opens after **5 consecutive failures**
- Recovers after **2 consecutive successes** in half-open
- Half-open probe window: **30 seconds** after open

---

## Health Checks

The load balancer runs an internal health check loop. The standalone `health-checker` service provides an external view. Both use configurable:

- `interval_secs` — poll frequency
- `timeout_secs` — per-check timeout
- `healthy_threshold` — consecutive successes before marking healthy
- `unhealthy_threshold` — consecutive failures before marking unhealthy
- HTTP or TCP check kind

---

## Security

- All proxied responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
- Hop-by-hop headers (`Connection`, `Transfer-Encoding`, etc.) are stripped before forwarding
- No secrets in code or config files — all secrets injected at runtime via env/secrets manager
- Admin API is on a separate port — bind it to an internal interface in production
- Docker images run as non-root user (uid 10001)
- Kubernetes manifests enforce `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, drop ALL capabilities, non-root seccomp

---

## Production Checklist

- [ ] Replace `allow_origin(Any)` in `router.rs` with your specific allowed origins
- [ ] Set `LB__SERVER__ADMIN__BIND_ADDR` to an internal-only address (not 0.0.0.0)
- [ ] Configure TLS termination at your ingress or enable the TLS config block
- [ ] Wire secrets (if any) through AWS Secrets Manager / Vault — no `.env` in production
- [ ] Set Kubernetes resource limits appropriate for your traffic volume
- [ ] Configure Prometheus alerting rules for: error rate > threshold, p99 latency > SLA, no healthy backends
- [ ] Test graceful shutdown: `kubectl drain` a node and verify zero dropped connections
- [ ] Tag Docker images with commit SHA — never deploy `latest` to production

---

## Development

```bash
# Run all tests
cargo test --all

# Run with pretty logging
LB__OBSERVABILITY__LOG_FORMAT=pretty cargo run --release

# Benchmark (requires wrk or hey)
hey -n 100000 -c 100 http://localhost:8080/

# Check for vulnerabilities
cargo audit
```
