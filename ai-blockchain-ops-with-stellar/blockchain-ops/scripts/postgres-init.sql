-- PostgreSQL initialization script
-- Runs once when the container is first created

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Set timezone
SET timezone = 'UTC';

-- Performance settings (adjust based on your server RAM)
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET effective_cache_size = '512MB';
ALTER SYSTEM SET maintenance_work_mem = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET wal_buffers = '16MB';
ALTER SYSTEM SET default_statistics_target = '100';
ALTER SYSTEM SET random_page_cost = '1.1';
ALTER SYSTEM SET effective_io_concurrency = '200';
ALTER SYSTEM SET work_mem = '4MB';
ALTER SYSTEM SET min_wal_size = '1GB';
ALTER SYSTEM SET max_wal_size = '4GB';

SELECT pg_reload_conf();

-- ── Stellar tables ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stellar_contracts (
  contract_id     TEXT         PRIMARY KEY,
  name            TEXT         NOT NULL,
  network         TEXT         NOT NULL CHECK (network IN ('mainnet', 'testnet', 'futurenet')),
  wasm_hash       TEXT,
  deployed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  task_id         TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stellar_contracts_network ON stellar_contracts(network);
CREATE INDEX IF NOT EXISTS idx_stellar_contracts_task_id ON stellar_contracts(task_id);

CREATE TABLE IF NOT EXISTS stellar_transactions (
  id              BIGSERIAL    PRIMARY KEY,
  task_id         TEXT         NOT NULL,
  network         TEXT         NOT NULL CHECK (network IN ('mainnet', 'testnet', 'futurenet')),
  tx_hash         TEXT,
  status          TEXT         NOT NULL CHECK (status IN ('simulated','submitted','confirmed','failed')),
  ledger          INTEGER,
  fee_charged     TEXT,
  result_xdr      TEXT,
  explorer_url    TEXT,
  description     TEXT,
  error           TEXT,
  submitted_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stellar_tx_task_id  ON stellar_transactions(task_id);
CREATE INDEX IF NOT EXISTS idx_stellar_tx_network  ON stellar_transactions(network);
CREATE INDEX IF NOT EXISTS idx_stellar_tx_hash     ON stellar_transactions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_stellar_tx_status   ON stellar_transactions(status);
