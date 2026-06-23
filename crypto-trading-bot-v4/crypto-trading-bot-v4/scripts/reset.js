'use strict';
/**
 * scripts/reset.js
 * Drops all tables and re-applies schema. DESTRUCTIVE.
 * Blocked in production. Requires explicit --confirm flag.
 */

require('dotenv').config();
const { readFileSync } = require('fs');
const { join }         = require('path');
const { Pool }         = require('pg');

// ── Safety guards ─────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('[RESET] ❌  Blocked: NODE_ENV=production. This script is dev-only.');
  process.exit(1);
}

if (!process.argv.includes('--confirm')) {
  console.error('[RESET] ❌  You must pass --confirm to acknowledge this is destructive.');
  console.error('[RESET]     Usage: node scripts/reset.js --confirm');
  process.exit(1);
}

const DROP_SQL = `
  -- Drop triggers first (avoid dependency errors)
  DROP TRIGGER IF EXISTS bots_updated_at          ON bots;
  DROP TRIGGER IF EXISTS bots_protect_capital      ON bots;
  DROP TRIGGER IF EXISTS bots_drawdown_alert       ON bots;
  DROP TRIGGER IF EXISTS positions_no_reclose      ON positions;
  DROP TRIGGER IF EXISTS positions_update_bot      ON positions;
  DROP TRIGGER IF EXISTS grid_levels_updated_at    ON grid_levels;
  DROP TRIGGER IF EXISTS snapshots_compute_metrics ON performance_snapshots;

  -- Drop views
  DROP VIEW IF EXISTS bot_performance    CASCADE;
  DROP VIEW IF EXISTS daily_pnl          CASCADE;
  DROP VIEW IF EXISTS open_position_risk CASCADE;

  -- Drop tables (order respects FK dependencies)
  DROP TABLE IF EXISTS _migrations            CASCADE;
  DROP TABLE IF EXISTS alerts                 CASCADE;
  DROP TABLE IF EXISTS system_logs            CASCADE;
  DROP TABLE IF EXISTS performance_snapshots  CASCADE;
  DROP TABLE IF EXISTS bot_state              CASCADE;
  DROP TABLE IF EXISTS funding_payments       CASCADE;
  DROP TABLE IF EXISTS dca_purchases          CASCADE;
  DROP TABLE IF EXISTS grid_levels            CASCADE;
  DROP TABLE IF EXISTS positions              CASCADE;
  DROP TABLE IF EXISTS orders                 CASCADE;
  DROP TABLE IF EXISTS bots                   CASCADE;

  -- Drop functions
  DROP FUNCTION IF EXISTS fn_set_updated_at()            CASCADE;
  DROP FUNCTION IF EXISTS fn_protect_initial_capital()   CASCADE;
  DROP FUNCTION IF EXISTS fn_prevent_reclose_position()  CASCADE;
  DROP FUNCTION IF EXISTS fn_update_bot_on_position_close() CASCADE;
  DROP FUNCTION IF EXISTS fn_alert_on_drawdown()         CASCADE;
  DROP FUNCTION IF EXISTS fn_compute_snapshot_metrics()  CASCADE;
  DROP FUNCTION IF EXISTS fn_drop_old_log_partitions(INT) CASCADE;

  -- Drop types
  DROP TYPE IF EXISTS trade_side      CASCADE;
  DROP TYPE IF EXISTS trade_status    CASCADE;
  DROP TYPE IF EXISTS order_type      CASCADE;
  DROP TYPE IF EXISTS position_side   CASCADE;
  DROP TYPE IF EXISTS position_status CASCADE;
  DROP TYPE IF EXISTS bot_type        CASCADE;
  DROP TYPE IF EXISTS bot_status      CASCADE;
  DROP TYPE IF EXISTS log_level       CASCADE;
  DROP TYPE IF EXISTS alert_type      CASCADE;
`;

async function reset() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host:     process.env.POSTGRES_HOST     || 'localhost',
    port:     parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB       || 'crypto_bot',
    user:     process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    ssl:      process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const schema = readFileSync(join(__dirname, '../infrastructure/db/schema.sql'), 'utf8');
  const client = await pool.connect();

  console.log('[RESET] Connected. Starting destructive reset...');

  try {
    // Drop everything
    await client.query('BEGIN');
    await client.query(DROP_SQL);
    await client.query('COMMIT');
    console.log('[RESET] ✅  All objects dropped');

    // Re-apply schema
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    console.log('[RESET] ✅  Schema re-applied');

    // Re-create migrations table and mark schema as applied
    const { createHash }  = require('crypto');
    const checksum = createHash('sha256').update(schema).digest('hex');
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY, filename VARCHAR(255) NOT NULL UNIQUE,
        checksum VARCHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `INSERT INTO _migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      ['schema.sql', checksum]
    );

    console.log('[RESET] ✅  Complete. Run npm run db:seed to add default bots.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[RESET] ❌  Failed:', err.message);
    if (err.detail) console.error('[RESET]    Detail:', err.detail);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

reset().catch(err => {
  console.error('[RESET] Fatal:', err.message);
  process.exit(1);
});
