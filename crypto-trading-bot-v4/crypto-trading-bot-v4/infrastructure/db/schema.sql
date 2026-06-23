-- ═══════════════════════════════════════════════════════════════
-- CRYPTO TRADING BOT — POSTGRESQL SCHEMA v2.0
-- Idempotent: safe to re-run
-- Apply: psql $DATABASE_URL -f infrastructure/db/schema.sql
-- ═══════════════════════════════════════════════════════════════

-- ── EXTENSIONS ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- ── ENUMS (idempotent) ────────────────────────────────────────
DO $$ BEGIN CREATE TYPE trade_side      AS ENUM ('BUY','SELL');                                                                    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE trade_status    AS ENUM ('PENDING','OPEN','FILLED','PARTIAL','CANCELLED','FAILED','EXPIRED');              EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE order_type      AS ENUM ('MARKET','LIMIT','STOP_MARKET','STOP_LIMIT','OCO','TRAILING_STOP');               EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE position_side   AS ENUM ('LONG','SHORT','NEUTRAL');                                                        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE position_status AS ENUM ('OPEN','CLOSED','LIQUIDATED','CANCELLED');                                        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE bot_type        AS ENUM ('cross_exchange_arb','triangular_arb','cash_carry','dca','grid','trend_following','momentum_scalp'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE bot_status      AS ENUM ('idle','running','stopping','error','paused');                                    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE log_level       AS ENUM ('DEBUG','INFO','WARN','ERROR','FATAL');                                           EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE alert_type      AS ENUM ('trade_open','trade_close','stop_loss','take_profit','error','pnl_threshold','funding','heartbeat_miss','drawdown_breach','daily_loss_breach'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── SHARED updated_at TRIGGER FUNCTION ───────────────────────
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

-- ── BOTS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bots (
  id                    UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  VARCHAR(100)  NOT NULL
                                        CHECK (char_length(TRIM(name)) >= 2),
  bot_type              bot_type      NOT NULL,
  status                bot_status    NOT NULL DEFAULT 'idle',
  config                JSONB         NOT NULL DEFAULT '{}',
  is_active             BOOLEAN       NOT NULL DEFAULT false,
  dry_run               BOOLEAN       NOT NULL DEFAULT true,

  -- Capital & risk
  initial_capital_usdt  NUMERIC(20,8) NOT NULL DEFAULT 0
                                        CHECK (initial_capital_usdt >= 0),
  current_capital_usdt  NUMERIC(20,8) NOT NULL DEFAULT 0,
  peak_capital_usdt     NUMERIC(20,8) NOT NULL DEFAULT 0,
  max_drawdown_pct      NUMERIC(8,4)  NOT NULL DEFAULT 0
                                        CHECK (max_drawdown_pct >= 0),
  max_position_usdt     NUMERIC(20,8)   CHECK (max_position_usdt > 0),
  daily_loss_limit_usdt NUMERIC(20,8)   CHECK (daily_loss_limit_usdt > 0),
  global_stop_loss_pct  NUMERIC(8,4)    CHECK (global_stop_loss_pct BETWEEN 0 AND 100),

  -- Aggregate counters (denormalised for fast reads)
  total_trades          INTEGER       NOT NULL DEFAULT 0 CHECK (total_trades >= 0),
  total_wins            INTEGER       NOT NULL DEFAULT 0 CHECK (total_wins >= 0),
  total_losses          INTEGER       NOT NULL DEFAULT 0 CHECK (total_losses >= 0),
  total_pnl_usdt        NUMERIC(20,8) NOT NULL DEFAULT 0,
  total_fees_usdt       NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (total_fees_usdt >= 0),

  -- Lifecycle
  started_at            TIMESTAMPTZ,
  stopped_at            TIMESTAMPTZ,
  last_heartbeat        TIMESTAMPTZ,
  error_message         TEXT,
  consecutive_errors    INTEGER       NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  version               INTEGER       NOT NULL DEFAULT 1,

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT bots_wins_lte_trades CHECK (total_wins <= total_trades),
  CONSTRAINT bots_losses_lte_trades CHECK (total_losses <= total_trades)
);

CREATE INDEX IF NOT EXISTS idx_bots_type     ON bots(bot_type);
CREATE INDEX IF NOT EXISTS idx_bots_active   ON bots(is_active);
CREATE INDEX IF NOT EXISTS idx_bots_status   ON bots(status);
CREATE INDEX IF NOT EXISTS idx_bots_heartbeat ON bots(last_heartbeat DESC);

DROP TRIGGER IF EXISTS bots_updated_at ON bots;
CREATE TRIGGER bots_updated_at
  BEFORE UPDATE ON bots
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Prevent reducing initial_capital_usdt after first set
CREATE OR REPLACE FUNCTION fn_protect_initial_capital()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.initial_capital_usdt > 0 AND NEW.initial_capital_usdt <> OLD.initial_capital_usdt THEN
    RAISE EXCEPTION 'initial_capital_usdt cannot be changed after it is set';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bots_protect_capital ON bots;
CREATE TRIGGER bots_protect_capital
  BEFORE UPDATE ON bots
  FOR EACH ROW EXECUTE FUNCTION fn_protect_initial_capital();

-- ── ORDERS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id            UUID          REFERENCES bots(id) ON DELETE SET NULL,
  exchange          VARCHAR(50)   NOT NULL CHECK (char_length(TRIM(exchange)) > 0),
  external_order_id VARCHAR(128),
  pair              VARCHAR(20)   NOT NULL CHECK (pair ~ '^[A-Z0-9/_-]{2,20}$'),
  side              trade_side    NOT NULL,
  type              order_type    NOT NULL DEFAULT 'MARKET',
  quantity          NUMERIC(20,8) NOT NULL CHECK (quantity > 0),
  price             NUMERIC(20,8)           CHECK (price IS NULL OR price > 0),
  stop_price        NUMERIC(20,8)           CHECK (stop_price IS NULL OR stop_price > 0),
  executed_qty      NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (executed_qty >= 0),
  executed_price    NUMERIC(20,8)           CHECK (executed_price IS NULL OR executed_price > 0),
  quote_qty         NUMERIC(20,8)           CHECK (quote_qty IS NULL OR quote_qty > 0),
  fee_amount        NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  fee_asset         VARCHAR(10),
  slippage_pct      NUMERIC(8,4)            CHECK (slippage_pct IS NULL OR slippage_pct >= 0),
  status            trade_status  NOT NULL DEFAULT 'PENDING',
  raw_response      JSONB,
  error_message     TEXT,
  retry_count       INTEGER       NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  placed_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  filled_at         TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- executed_qty cannot exceed quantity
  CONSTRAINT orders_exec_qty_lte_qty CHECK (executed_qty <= quantity),
  -- filled_at only when FILLED
  CONSTRAINT orders_filled_at_requires_status CHECK (
    (status = 'FILLED' AND filled_at IS NOT NULL) OR
    (status <> 'FILLED' AND filled_at IS NULL) OR
    filled_at IS NULL
  ),
  -- limit order must have price
  CONSTRAINT orders_limit_needs_price CHECK (
    type NOT IN ('LIMIT','STOP_LIMIT') OR price IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_orders_bot_id      ON orders(bot_id);
CREATE INDEX IF NOT EXISTS idx_orders_pair        ON orders(pair);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_external_id ON orders(external_order_id) WHERE external_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_placed_at   ON orders(placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_bot_status  ON orders(bot_id, status);

-- ── POSITIONS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id            UUID          REFERENCES bots(id) ON DELETE SET NULL,
  pair              VARCHAR(20)   NOT NULL CHECK (pair ~ '^[A-Z0-9/_-]{2,20}$'),
  side              position_side NOT NULL,
  status            position_status NOT NULL DEFAULT 'OPEN',
  entry_order_id    UUID          REFERENCES orders(id),
  exit_order_id     UUID          REFERENCES orders(id),
  quantity          NUMERIC(20,8) NOT NULL CHECK (quantity > 0),
  entry_price       NUMERIC(20,8) NOT NULL CHECK (entry_price > 0),
  exit_price        NUMERIC(20,8)           CHECK (exit_price IS NULL OR exit_price > 0),
  stop_loss_price   NUMERIC(20,8)           CHECK (stop_loss_price IS NULL OR stop_loss_price > 0),
  take_profit_price NUMERIC(20,8)           CHECK (take_profit_price IS NULL OR take_profit_price > 0),
  realized_pnl      NUMERIC(20,8),
  unrealized_pnl    NUMERIC(20,8),
  fee_total         NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (fee_total >= 0),
  net_pnl           NUMERIC(20,8),
  return_pct        NUMERIC(12,6)           GENERATED ALWAYS AS (
                      CASE WHEN entry_price > 0 AND quantity > 0
                           THEN ROUND((net_pnl / (entry_price * quantity)) * 100, 6)
                           ELSE NULL END
                    ) STORED,
  metadata          JSONB         NOT NULL DEFAULT '{}',
  opened_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  max_adverse_price NUMERIC(20,8),
  max_favourable_price NUMERIC(20,8),
  hold_duration_ms  BIGINT        GENERATED ALWAYS AS (
                      CASE WHEN closed_at IS NOT NULL
                           THEN EXTRACT(EPOCH FROM (closed_at - opened_at))::BIGINT * 1000
                           ELSE NULL END
                    ) STORED,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT positions_closed_needs_exit CHECK (
    (status = 'CLOSED' AND exit_price IS NOT NULL AND closed_at IS NOT NULL) OR
    status <> 'CLOSED'
  ),
  CONSTRAINT positions_sl_valid_long CHECK (
    side <> 'LONG' OR stop_loss_price IS NULL OR stop_loss_price < entry_price
  ),
  CONSTRAINT positions_sl_valid_short CHECK (
    side <> 'SHORT' OR stop_loss_price IS NULL OR stop_loss_price > entry_price
  )
);

CREATE INDEX IF NOT EXISTS idx_positions_bot_id    ON positions(bot_id);
CREATE INDEX IF NOT EXISTS idx_positions_pair      ON positions(pair);
CREATE INDEX IF NOT EXISTS idx_positions_status    ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON positions(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_bot_open  ON positions(bot_id, status) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_positions_net_pnl   ON positions(net_pnl DESC) WHERE status = 'CLOSED';

-- Prevent double-closing a position
CREATE OR REPLACE FUNCTION fn_prevent_reclose_position()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'CLOSED' AND NEW.status = 'CLOSED' THEN
    RAISE EXCEPTION 'Position % is already closed', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS positions_no_reclose ON positions;
CREATE TRIGGER positions_no_reclose
  BEFORE UPDATE ON positions
  FOR EACH ROW EXECUTE FUNCTION fn_prevent_reclose_position();

-- ── GRID LEVELS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS grid_levels (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID          NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  level_index     INTEGER       NOT NULL CHECK (level_index >= 0),
  price           NUMERIC(20,8) NOT NULL CHECK (price > 0),
  side            trade_side    NOT NULL,
  order_id        UUID          REFERENCES orders(id) ON DELETE SET NULL,
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  fills           INTEGER       NOT NULL DEFAULT 0 CHECK (fills >= 0),
  total_profit    NUMERIC(20,8) NOT NULL DEFAULT 0,
  last_filled_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (bot_id, level_index)
);

CREATE INDEX IF NOT EXISTS idx_grid_levels_bot    ON grid_levels(bot_id);
CREATE INDEX IF NOT EXISTS idx_grid_levels_active ON grid_levels(bot_id, is_active) WHERE is_active = true;

DROP TRIGGER IF EXISTS grid_levels_updated_at ON grid_levels;
CREATE TRIGGER grid_levels_updated_at
  BEFORE UPDATE ON grid_levels
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ── DCA PURCHASES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dca_purchases (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id        UUID          NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  asset         VARCHAR(20)   NOT NULL CHECK (char_length(TRIM(asset)) > 0),
  pair          VARCHAR(20)   NOT NULL CHECK (pair ~ '^[A-Z0-9/_-]{2,20}$'),
  quantity      NUMERIC(20,8) NOT NULL CHECK (quantity > 0),
  price_usdt    NUMERIC(20,8) NOT NULL CHECK (price_usdt > 0),
  cost_usdt     NUMERIC(20,8) NOT NULL CHECK (cost_usdt > 0),
  multiplier    NUMERIC(5,2)  NOT NULL DEFAULT 1.0 CHECK (multiplier >= 1.0 AND multiplier <= 10.0),
  sma_at_purchase NUMERIC(20,8),
  pct_below_sma   NUMERIC(8,4),
  order_id      UUID          REFERENCES orders(id) ON DELETE SET NULL,
  purchased_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- cost_usdt must approximately equal quantity * price_usdt (within 1% for fees)
  CONSTRAINT dca_cost_sanity CHECK (
    ABS(cost_usdt - (quantity * price_usdt)) / (quantity * price_usdt) < 0.05
  )
);

CREATE INDEX IF NOT EXISTS idx_dca_bot     ON dca_purchases(bot_id);
CREATE INDEX IF NOT EXISTS idx_dca_asset   ON dca_purchases(bot_id, asset);
CREATE INDEX IF NOT EXISTS idx_dca_time    ON dca_purchases(purchased_at DESC);

-- ── FUNDING PAYMENTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS funding_payments (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id        UUID          NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  position_id   UUID          REFERENCES positions(id) ON DELETE SET NULL,
  symbol        VARCHAR(20)   NOT NULL,
  funding_rate  NUMERIC(12,8) NOT NULL,
  payment_usdt  NUMERIC(20,8) NOT NULL,
  is_received   BOOLEAN       NOT NULL DEFAULT true,
  paid_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_funding_bot      ON funding_payments(bot_id);
CREATE INDEX IF NOT EXISTS idx_funding_position ON funding_payments(position_id);
CREATE INDEX IF NOT EXISTS idx_funding_paid_at  ON funding_payments(paid_at DESC);

-- ── BOT STATE ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_state (
  bot_id      UUID          NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  key         VARCHAR(100)  NOT NULL CHECK (key ~ '^[a-zA-Z0-9_:.-]+$'),
  value       JSONB         NOT NULL,
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bot_id, key)
);

CREATE INDEX IF NOT EXISTS idx_bot_state_bot ON bot_state(bot_id);

-- ── PERFORMANCE SNAPSHOTS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS performance_snapshots (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID          NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  snapshot_date   DATE          NOT NULL,
  total_trades    INTEGER       NOT NULL DEFAULT 0 CHECK (total_trades >= 0),
  winning_trades  INTEGER       NOT NULL DEFAULT 0 CHECK (winning_trades >= 0),
  losing_trades   INTEGER       NOT NULL DEFAULT 0 CHECK (losing_trades >= 0),
  gross_pnl       NUMERIC(20,8) NOT NULL DEFAULT 0,
  total_fees      NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (total_fees >= 0),
  net_pnl         NUMERIC(20,8) NOT NULL DEFAULT 0,
  max_drawdown    NUMERIC(10,4)           CHECK (max_drawdown IS NULL OR max_drawdown >= 0),
  sharpe_ratio    NUMERIC(10,4),
  sortino_ratio   NUMERIC(10,4),
  win_rate        NUMERIC(5,2)            CHECK (win_rate IS NULL OR win_rate BETWEEN 0 AND 100),
  avg_win_usdt    NUMERIC(20,8),
  avg_loss_usdt   NUMERIC(20,8),
  profit_factor   NUMERIC(10,4)           CHECK (profit_factor IS NULL OR profit_factor >= 0),
  capital_start   NUMERIC(20,8),
  capital_end     NUMERIC(20,8),
  metadata        JSONB         NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (bot_id, snapshot_date),
  CONSTRAINT snapshot_wins_lte_trades CHECK (winning_trades <= total_trades),
  CONSTRAINT snapshot_losses_lte_trades CHECK (losing_trades <= total_trades)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_bot  ON performance_snapshots(bot_id, snapshot_date DESC);

-- ── ALERTS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id        UUID        REFERENCES bots(id) ON DELETE SET NULL,
  type          alert_type  NOT NULL,
  message       TEXT        NOT NULL,
  context       JSONB       NOT NULL DEFAULT '{}',
  delivered     BOOLEAN     NOT NULL DEFAULT false,
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_bot       ON alerts(bot_id);
CREATE INDEX IF NOT EXISTS idx_alerts_delivered ON alerts(delivered, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_type      ON alerts(type);

-- ── SYSTEM LOGS (partitioned by month) ───────────────────────
CREATE TABLE IF NOT EXISTS system_logs (
  id          BIGSERIAL,
  bot_id      UUID        REFERENCES bots(id) ON DELETE SET NULL,
  level       log_level   NOT NULL,
  message     TEXT        NOT NULL CHECK (char_length(message) > 0),
  context     JSONB       NOT NULL DEFAULT '{}',
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, logged_at)
) PARTITION BY RANGE (logged_at);

-- Create partitions for current and next 2 months
DO $$
DECLARE
  m DATE;
BEGIN
  FOR i IN 0..2 LOOP
    m := DATE_TRUNC('month', NOW() + (i || ' months')::INTERVAL)::DATE;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS system_logs_%s
       PARTITION OF system_logs
       FOR VALUES FROM (%L) TO (%L)',
      TO_CHAR(m, 'YYYY_MM'),
      m,
      m + INTERVAL '1 month'
    );
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_logs_bot_id    ON system_logs(bot_id);
CREATE INDEX IF NOT EXISTS idx_logs_level     ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_logged_at ON system_logs(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_bot_level ON system_logs(bot_id, level, logged_at DESC);

-- Auto-drop partitions older than 90 days (call this from pg_cron)
CREATE OR REPLACE FUNCTION fn_drop_old_log_partitions(retain_months INT DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  partition_name TEXT;
  cutoff DATE := DATE_TRUNC('month', NOW() - (retain_months || ' months')::INTERVAL)::DATE;
BEGIN
  FOR partition_name IN
    SELECT c.relname FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'system_logs' AND c.relname < 'system_logs_' || TO_CHAR(cutoff, 'YYYY_MM')
  LOOP
    EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(partition_name);
    RAISE NOTICE 'Dropped partition: %', partition_name;
  END LOOP;
END;
$$;

-- ── VIEWS ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW bot_performance AS
SELECT
  b.id,
  b.name,
  b.bot_type,
  b.status,
  b.is_active,
  b.dry_run,
  b.initial_capital_usdt,
  b.current_capital_usdt,
  b.peak_capital_usdt,
  b.max_drawdown_pct,
  -- Live position counts from positions table
  COUNT(p.id)                                                AS total_positions,
  COUNT(p.id) FILTER (WHERE p.net_pnl > 0)                  AS wins,
  COUNT(p.id) FILTER (WHERE p.net_pnl <= 0 AND p.net_pnl IS NOT NULL) AS losses,
  COALESCE(SUM(p.net_pnl), 0)                               AS total_net_pnl,
  COALESCE(AVG(p.net_pnl), 0)                               AS avg_pnl_per_trade,
  COALESCE(MIN(p.net_pnl), 0)                               AS worst_trade,
  COALESCE(MAX(p.net_pnl), 0)                               AS best_trade,
  COALESCE(SUM(p.fee_total), 0)                             AS total_fees,
  COALESCE(
    COUNT(p.id) FILTER (WHERE p.net_pnl > 0)::FLOAT /
    NULLIF(COUNT(p.id) FILTER (WHERE p.net_pnl IS NOT NULL), 0) * 100, 0
  )                                                          AS win_rate_pct,
  COUNT(op.id)                                              AS open_positions,
  b.last_heartbeat,
  CASE
    WHEN b.last_heartbeat > NOW() - INTERVAL '2 minutes' THEN true
    ELSE false
  END                                                        AS is_healthy
FROM bots b
LEFT JOIN positions p  ON p.bot_id = b.id AND p.status = 'CLOSED'
LEFT JOIN positions op ON op.bot_id = b.id AND op.status = 'OPEN'
GROUP BY b.id, b.name, b.bot_type, b.status, b.is_active, b.dry_run,
         b.initial_capital_usdt, b.current_capital_usdt, b.peak_capital_usdt,
         b.max_drawdown_pct, b.last_heartbeat;

-- Daily PnL view
CREATE OR REPLACE VIEW daily_pnl AS
SELECT
  bot_id,
  DATE(closed_at)       AS trade_date,
  COUNT(*)              AS trades,
  SUM(net_pnl)          AS net_pnl,
  SUM(fee_total)        AS fees,
  COUNT(*) FILTER (WHERE net_pnl > 0) AS wins,
  COUNT(*) FILTER (WHERE net_pnl <= 0) AS losses
FROM positions
WHERE status = 'CLOSED' AND closed_at IS NOT NULL
GROUP BY bot_id, DATE(closed_at)
ORDER BY trade_date DESC;

-- Open position risk view
CREATE OR REPLACE VIEW open_position_risk AS
SELECT
  p.id,
  p.bot_id,
  b.name AS bot_name,
  p.pair,
  p.side,
  p.quantity,
  p.entry_price,
  p.stop_loss_price,
  p.take_profit_price,
  p.entry_price * p.quantity                                AS notional_usdt,
  CASE WHEN p.stop_loss_price IS NOT NULL
    THEN ABS(p.entry_price - p.stop_loss_price) * p.quantity
    ELSE NULL
  END                                                       AS max_loss_usdt,
  NOW() - p.opened_at                                       AS hold_duration,
  p.metadata,
  p.opened_at
FROM positions p
JOIN bots b ON b.id = p.bot_id
WHERE p.status = 'OPEN'
ORDER BY p.opened_at;

-- ── ROW-LEVEL SECURITY ────────────────────────────────────────
-- Enable RLS so app role only sees its own bot's data
ALTER TABLE bots               ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_state          ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_snapshots ENABLE ROW LEVEL SECURITY;

-- App role can do everything (policies added per deployment for multi-tenant)
CREATE POLICY bot_all ON bots               USING (true) WITH CHECK (true);
CREATE POLICY order_all ON orders           USING (true) WITH CHECK (true);
CREATE POLICY pos_all ON positions          USING (true) WITH CHECK (true);
CREATE POLICY log_all ON system_logs        USING (true) WITH CHECK (true);
CREATE POLICY state_all ON bot_state        USING (true) WITH CHECK (true);
CREATE POLICY snap_all ON performance_snapshots USING (true) WITH CHECK (true);

-- ── FUNCTIONS ─────────────────────────────────────────────────

-- Update bot aggregate counters atomically on position close
CREATE OR REPLACE FUNCTION fn_update_bot_on_position_close()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CLOSED' AND OLD.status = 'OPEN' THEN
    UPDATE bots SET
      total_trades  = total_trades + 1,
      total_wins    = total_wins   + CASE WHEN NEW.net_pnl > 0 THEN 1 ELSE 0 END,
      total_losses  = total_losses + CASE WHEN NEW.net_pnl <= 0 THEN 1 ELSE 0 END,
      total_pnl_usdt  = total_pnl_usdt  + COALESCE(NEW.net_pnl, 0),
      total_fees_usdt = total_fees_usdt + COALESCE(NEW.fee_total, 0),
      current_capital_usdt = current_capital_usdt + COALESCE(NEW.net_pnl, 0),
      peak_capital_usdt = GREATEST(peak_capital_usdt, current_capital_usdt + COALESCE(NEW.net_pnl, 0)),
      max_drawdown_pct = GREATEST(
        max_drawdown_pct,
        CASE WHEN peak_capital_usdt > 0
          THEN ROUND(((peak_capital_usdt - (current_capital_usdt + COALESCE(NEW.net_pnl, 0))) / peak_capital_usdt) * 100, 4)
          ELSE 0
        END
      ),
      updated_at = NOW()
    WHERE id = NEW.bot_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS positions_update_bot ON positions;
CREATE TRIGGER positions_update_bot
  AFTER UPDATE ON positions
  FOR EACH ROW EXECUTE FUNCTION fn_update_bot_on_position_close();

-- Enqueue alert on significant drawdown breach
CREATE OR REPLACE FUNCTION fn_alert_on_drawdown()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.max_drawdown_pct >= 10 AND (OLD.max_drawdown_pct < 10 OR OLD.max_drawdown_pct IS NULL) THEN
    INSERT INTO alerts (bot_id, type, message, context)
    VALUES (NEW.id, 'drawdown_breach',
            'Drawdown breached 10%',
            jsonb_build_object('drawdown_pct', NEW.max_drawdown_pct,
                               'current_capital', NEW.current_capital_usdt));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bots_drawdown_alert ON bots;
CREATE TRIGGER bots_drawdown_alert
  AFTER UPDATE ON bots
  FOR EACH ROW EXECUTE FUNCTION fn_alert_on_drawdown();

-- Computed profit_factor on snapshot insert/update
CREATE OR REPLACE FUNCTION fn_compute_snapshot_metrics()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_avg_win  NUMERIC;
  v_avg_loss NUMERIC;
BEGIN
  SELECT
    AVG(net_pnl) FILTER (WHERE net_pnl > 0),
    ABS(AVG(net_pnl) FILTER (WHERE net_pnl <= 0))
  INTO v_avg_win, v_avg_loss
  FROM positions
  WHERE bot_id = NEW.bot_id
    AND status = 'CLOSED'
    AND DATE(closed_at) = NEW.snapshot_date;

  NEW.avg_win_usdt  := v_avg_win;
  NEW.avg_loss_usdt := v_avg_loss;
  NEW.profit_factor := CASE WHEN v_avg_loss > 0 THEN ROUND(v_avg_win / v_avg_loss, 4) ELSE NULL END;
  NEW.win_rate      := CASE WHEN NEW.total_trades > 0
    THEN ROUND((NEW.winning_trades::NUMERIC / NEW.total_trades) * 100, 2)
    ELSE 0 END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS snapshots_compute_metrics ON performance_snapshots;
CREATE TRIGGER snapshots_compute_metrics
  BEFORE INSERT OR UPDATE ON performance_snapshots
  FOR EACH ROW EXECUTE FUNCTION fn_compute_snapshot_metrics();

-- Grant permissions to app role (set CRYPTO_BOT_DB_ROLE in env)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'crypto_bot_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crypto_bot_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crypto_bot_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO crypto_bot_app;
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- ADVANCED STRATEGIES — HISTORICAL DATA & SEASONAL SCHEMA
-- ═══════════════════════════════════════════════════════════════

-- ── OHLCV HISTORICAL PRICE DATA ───────────────────────────────
-- Stores raw candle data fetched from exchange APIs.
-- Partitioned by year for fast range queries.
CREATE TABLE IF NOT EXISTS ohlcv (
  id           BIGSERIAL,
  pair         VARCHAR(20)    NOT NULL CHECK (pair ~ '^[A-Z0-9/_-]{2,20}$'),
  exchange     VARCHAR(50)    NOT NULL,
  interval     VARCHAR(10)    NOT NULL CHECK (interval IN ('1m','5m','15m','1h','4h','1d','1w')),
  open_time    TIMESTAMPTZ    NOT NULL,
  open         NUMERIC(24,8)  NOT NULL CHECK (open > 0),
  high         NUMERIC(24,8)  NOT NULL CHECK (high >= open),
  low          NUMERIC(24,8)  NOT NULL CHECK (low <= open AND low > 0),
  close        NUMERIC(24,8)  NOT NULL CHECK (close > 0),
  volume       NUMERIC(30,8)  NOT NULL CHECK (volume >= 0),
  quote_volume NUMERIC(30,8)  NOT NULL DEFAULT 0,
  trade_count  INTEGER        NOT NULL DEFAULT 0,
  PRIMARY KEY  (id, open_time),
  UNIQUE       (pair, exchange, interval, open_time)
) PARTITION BY RANGE (open_time);

-- Partitions for 2022-2026 + future
DO $$
DECLARE yr INT;
BEGIN
  FOR yr IN 2022..2027 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS ohlcv_%s
       PARTITION OF ohlcv
       FOR VALUES FROM (%L) TO (%L)',
      yr,
      yr || '-01-01',
      (yr+1) || '-01-01'
    );
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_ohlcv_pair_interval_time ON ohlcv(pair, interval, open_time DESC);
CREATE INDEX IF NOT EXISTS idx_ohlcv_exchange_pair      ON ohlcv(exchange, pair, open_time DESC);

-- ── PRICE SPIKES ──────────────────────────────────────────────
-- A spike = candle where price moved > threshold% in one period.
-- Used by the seasonal engine to detect recurrence patterns.
CREATE TABLE IF NOT EXISTS price_spikes (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  pair            VARCHAR(20)  NOT NULL,
  exchange        VARCHAR(50)  NOT NULL,
  interval        VARCHAR(10)  NOT NULL,
  spike_time      TIMESTAMPTZ  NOT NULL,
  direction       trade_side   NOT NULL,  -- BUY=up spike, SELL=down spike
  open_price      NUMERIC(24,8) NOT NULL,
  close_price     NUMERIC(24,8) NOT NULL,
  high_price      NUMERIC(24,8) NOT NULL,
  low_price       NUMERIC(24,8) NOT NULL,
  pct_move        NUMERIC(10,4) NOT NULL,  -- % change open→close
  pct_wick        NUMERIC(10,4) NOT NULL,  -- % range high-low/open
  volume          NUMERIC(30,8) NOT NULL,
  volume_z_score  NUMERIC(10,4),           -- z-score vs rolling avg volume
  -- Calendar context (enables seasonal grouping)
  year            SMALLINT     NOT NULL GENERATED ALWAYS AS (EXTRACT(YEAR  FROM spike_time)::SMALLINT) STORED,
  month           SMALLINT     NOT NULL GENERATED ALWAYS AS (EXTRACT(MONTH FROM spike_time)::SMALLINT) STORED,
  week_of_year    SMALLINT     NOT NULL GENERATED ALWAYS AS (EXTRACT(WEEK  FROM spike_time)::SMALLINT) STORED,
  day_of_week     SMALLINT     NOT NULL GENERATED ALWAYS AS (EXTRACT(DOW   FROM spike_time)::SMALLINT) STORED,
  hour_of_day     SMALLINT     NOT NULL GENERATED ALWAYS AS (EXTRACT(HOUR  FROM spike_time)::SMALLINT) STORED,
  -- Post-spike tracking (filled by background job)
  revert_1h_pct   NUMERIC(10,4),
  revert_4h_pct   NUMERIC(10,4),
  revert_24h_pct  NUMERIC(10,4),
  revert_7d_pct   NUMERIC(10,4),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spikes_pair_time    ON price_spikes(pair, spike_time DESC);
CREATE INDEX IF NOT EXISTS idx_spikes_month_dow    ON price_spikes(pair, month, day_of_week);
CREATE INDEX IF NOT EXISTS idx_spikes_direction    ON price_spikes(pair, direction, month);
CREATE INDEX IF NOT EXISTS idx_spikes_pct_move     ON price_spikes(pair, pct_move DESC);
CREATE INDEX IF NOT EXISTS idx_spikes_year_month   ON price_spikes(year, month, pair);

-- ── SEASONAL PATTERNS ─────────────────────────────────────────
-- Pre-computed seasonal statistics per (pair, month).
-- Rebuilt by the seasonal engine after each data ingestion run.
CREATE TABLE IF NOT EXISTS seasonal_patterns (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  pair            VARCHAR(20)  NOT NULL,
  interval        VARCHAR(10)  NOT NULL,
  -- Period dimensions
  month           SMALLINT     CHECK (month BETWEEN 1 AND 12),
  week_of_year    SMALLINT     CHECK (week_of_year BETWEEN 1 AND 53),
  day_of_week     SMALLINT     CHECK (day_of_week BETWEEN 0 AND 6),
  hour_of_day     SMALLINT     CHECK (hour_of_day BETWEEN 0 AND 23),
  -- Coverage
  years_in_sample SMALLINT     NOT NULL CHECK (years_in_sample > 0),
  sample_count    INTEGER      NOT NULL CHECK (sample_count > 0),
  -- Return statistics
  avg_return_pct  NUMERIC(10,4) NOT NULL,
  median_return_pct NUMERIC(10,4) NOT NULL,
  std_return_pct  NUMERIC(10,4) NOT NULL,
  min_return_pct  NUMERIC(10,4) NOT NULL,
  max_return_pct  NUMERIC(10,4) NOT NULL,
  win_rate_pct    NUMERIC(6,2)  NOT NULL CHECK (win_rate_pct BETWEEN 0 AND 100),
  -- Seasonal signal strength
  t_stat          NUMERIC(10,4),  -- t-statistic vs zero
  p_value         NUMERIC(10,6),  -- statistical significance
  signal_strength NUMERIC(6,4)    CHECK (signal_strength BETWEEN 0 AND 1),
  -- Direction bias
  bullish_bias    BOOLEAN      NOT NULL DEFAULT false,
  bearish_bias    BOOLEAN      NOT NULL DEFAULT false,
  -- Volume patterns
  avg_volume_ratio NUMERIC(10,4), -- ratio vs annual avg volume for this period
  -- Spike frequency
  spike_frequency_pct NUMERIC(6,2), -- % of years this period had a spike
  computed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Only one row per (pair, interval, period combination)
  UNIQUE (pair, interval, month, week_of_year, day_of_week, hour_of_day)
);

CREATE INDEX IF NOT EXISTS idx_seasonal_pair_month ON seasonal_patterns(pair, month);
CREATE INDEX IF NOT EXISTS idx_seasonal_strength   ON seasonal_patterns(pair, signal_strength DESC);
CREATE INDEX IF NOT EXISTS idx_seasonal_bias       ON seasonal_patterns(pair, bullish_bias, month);

-- ── MEAN REVERSION SIGNALS ────────────────────────────────────
-- Logged by the mean reversion bot on every detected signal.
CREATE TABLE IF NOT EXISTS mean_reversion_signals (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id          UUID         REFERENCES bots(id) ON DELETE SET NULL,
  pair            VARCHAR(20)  NOT NULL,
  signal_time     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  direction       trade_side   NOT NULL,
  -- Statistical measures at signal time
  price           NUMERIC(24,8) NOT NULL,
  sma             NUMERIC(24,8) NOT NULL,
  std_dev         NUMERIC(24,8) NOT NULL,
  z_score         NUMERIC(10,4) NOT NULL,
  rsi             NUMERIC(6,2),
  bb_upper        NUMERIC(24,8),
  bb_lower        NUMERIC(24,8),
  bb_pct          NUMERIC(10,4),  -- where in BB range (0=lower, 1=upper)
  -- Outcome tracking
  acted_on        BOOLEAN      NOT NULL DEFAULT false,
  position_id     UUID         REFERENCES positions(id),
  revert_target   NUMERIC(24,8),
  revert_achieved BOOLEAN,
  pct_to_mean     NUMERIC(10,4), -- % price needs to move to reach mean
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mr_signals_pair ON mean_reversion_signals(pair, signal_time DESC);
CREATE INDEX IF NOT EXISTS idx_mr_signals_bot  ON mean_reversion_signals(bot_id, signal_time DESC);

-- ── HISTORICAL INGESTION LOG ──────────────────────────────────
-- Tracks what data has been ingested so we don't re-fetch.
CREATE TABLE IF NOT EXISTS ingestion_log (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  pair          VARCHAR(20)  NOT NULL,
  exchange      VARCHAR(50)  NOT NULL,
  interval      VARCHAR(10)  NOT NULL,
  from_time     TIMESTAMPTZ  NOT NULL,
  to_time       TIMESTAMPTZ  NOT NULL,
  candles_count INTEGER      NOT NULL CHECK (candles_count >= 0),
  status        VARCHAR(20)  NOT NULL CHECK (status IN ('pending','running','done','failed')),
  error_message TEXT,
  duration_ms   INTEGER,
  started_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  UNIQUE (pair, exchange, interval, from_time, to_time)
);

CREATE INDEX IF NOT EXISTS idx_ingestion_pair ON ingestion_log(pair, exchange, interval, to_time DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_status ON ingestion_log(status);

-- ── SEASONAL TRADE LOG ────────────────────────────────────────
-- Records every seasonal-signal-triggered trade for analysis.
CREATE TABLE IF NOT EXISTS seasonal_trades (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  bot_id            UUID         REFERENCES bots(id) ON DELETE SET NULL,
  position_id       UUID         REFERENCES positions(id) ON DELETE SET NULL,
  pair              VARCHAR(20)  NOT NULL,
  signal_month      SMALLINT     NOT NULL,
  signal_week       SMALLINT,
  signal_dow        SMALLINT,
  pattern_strength  NUMERIC(6,4),
  seasonal_bias     VARCHAR(10)  CHECK (seasonal_bias IN ('bullish','bearish','neutral')),
  entry_price       NUMERIC(24,8),
  exit_price        NUMERIC(24,8),
  net_pnl           NUMERIC(20,8),
  pattern_confirmed BOOLEAN,   -- did the seasonal pattern play out?
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── VIEW: best seasonal months per pair ───────────────────────
CREATE OR REPLACE VIEW best_seasonal_months AS
SELECT
  pair,
  month,
  ROUND(avg_return_pct, 2)    AS avg_return_pct,
  ROUND(win_rate_pct, 1)      AS win_rate_pct,
  ROUND(signal_strength, 4)   AS signal_strength,
  sample_count,
  years_in_sample,
  bullish_bias,
  bearish_bias,
  CASE month
    WHEN 1  THEN 'January'   WHEN 2  THEN 'February' WHEN 3  THEN 'March'
    WHEN 4  THEN 'April'     WHEN 5  THEN 'May'       WHEN 6  THEN 'June'
    WHEN 7  THEN 'July'      WHEN 8  THEN 'August'    WHEN 9  THEN 'September'
    WHEN 10 THEN 'October'   WHEN 11 THEN 'November'  WHEN 12 THEN 'December'
  END AS month_name
FROM seasonal_patterns
WHERE interval = '1d' AND month IS NOT NULL
  AND week_of_year IS NULL AND day_of_week IS NULL AND hour_of_day IS NULL
ORDER BY pair, avg_return_pct DESC;

-- ── VIEW: current month seasonal bias ─────────────────────────
CREATE OR REPLACE VIEW current_month_bias AS
SELECT
  sp.*,
  CASE month
    WHEN 1  THEN 'January'   WHEN 2  THEN 'February' WHEN 3  THEN 'March'
    WHEN 4  THEN 'April'     WHEN 5  THEN 'May'       WHEN 6  THEN 'June'
    WHEN 7  THEN 'July'      WHEN 8  THEN 'August'    WHEN 9  THEN 'September'
    WHEN 10 THEN 'October'   WHEN 11 THEN 'November'  WHEN 12 THEN 'December'
  END AS month_name,
  NOW()::DATE AS today
FROM seasonal_patterns sp
WHERE month = EXTRACT(MONTH FROM NOW())::SMALLINT
  AND interval = '1d'
  AND week_of_year IS NULL AND day_of_week IS NULL AND hour_of_day IS NULL
ORDER BY signal_strength DESC;
