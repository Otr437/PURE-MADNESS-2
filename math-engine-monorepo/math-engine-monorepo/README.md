# Math Engine Monorepo

A modular, microservice-oriented mathematical analysis platform.

## Structure

```
math-engine-monorepo/
├── packages/
│   ├── config/          # Configuration management (YAML/ENV/CLI/Runtime)
│   ├── database/        # SQLite database manager with encryption + backups
│   ├── randomization/   # Quantum + Chaotic RNG
│   ├── memory/          # Pointer math & memory space management
│   ├── symbolic/        # Symbolic math engine (evaluate, solve, differentiate, integrate)
│   ├── math-core/       # Pure math: algebra, calculus, linear algebra, stats, number theory
│   ├── crypto-math/     # Cryptographic math: SECP256k1, number theory, modular arithmetic
│   ├── analytics/       # Statistical analytics & time-series decomposition
│   ├── prediction/      # ML-based predictive analytics engine
│   ├── god-mode/        # Theorem proving & heuristic solver
│   ├── api/             # REST API server
│   └── admin/           # Admin web panel
├── apps/
│   ├── api-server/      # Deployable API service
│   ├── admin-server/    # Deployable admin panel service
│   └── cli/             # Interactive REPL CLI
├── requirements.txt     # Shared Python dependencies
├── docker-compose.yml   # Multi-service orchestration
└── Makefile             # Common dev tasks
```

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Run API server
python apps/api-server/main.py

# Run admin panel
python apps/admin-server/main.py

# Run CLI
python apps/cli/main.py

# Run everything via Docker
docker-compose up
```

## Services

| Service      | Default Port | Description              |
|-------------|-------------|--------------------------|
| API Server  | 8080        | REST API for math ops    |
| Admin Panel | 8081        | Web-based admin UI       |
| CLI         | —           | Interactive REPL         |

## Package Dependency Graph

```
config ──────────────────────────────────────────┐
database ← config                                │
randomization                                    │
memory ← randomization                          │
symbolic ← randomization                        │
math-core                                        ▼
crypto-math ← math-core                    [all packages]
analytics ← randomization                        │
prediction ← analytics                           │
god-mode ← symbolic, database                    │
api ← config, database, symbolic, analytics,    │
      prediction, god-mode, math-core           │
admin ← api                                      │
```
