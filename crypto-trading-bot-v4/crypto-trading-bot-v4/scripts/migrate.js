'use strict';
/**
 * scripts/migrate.js
 * Applies infrastructure/db/schema.sql idempotently.
 * Tracks applied migrations in a migrations table.
 */

require('dotenv').config();
const { readFileSync, existsSync, readdirSync } = require('fs');
const { join }   = require('path');
const { Pool }   = require('pg');
const { createHash } = require('crypto');

if (!process.env.DATABASE_URL && !process.env.POSTGRES_USER) {
  console.error('[MIGRATE] Error: DATABASE_URL or POSTGRES_USER/PASSWORD must be set in .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host:     process.env.POSTGRES_HOST     || 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB       || 'crypto_bot',
  user:     process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl:      process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15_000,
});

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL UNIQUE,
      checksum    VARCHAR(64)  NOT NULL,
      applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
}

async function migrate() {
  const client = await pool.connect();
  console.log('[MIGRATE] Connected to PostgreSQL');

  try {
    await ensureMigrationsTable(client);

    // Load applied migrations
    const applied  = await client.query('SELECT filename, checksum FROM _migrations ORDER BY id');
    const appliedMap = new Map(applied.rows.map(r => [r.filename, r.checksum]));

    // Discover migration files (schema.sql is the base; any *.sql in db/ is also applied)
    const dbDir = join(__dirname, '../infrastructure/db');
    const files = ['schema.sql', ...readdirSync(dbDir)
      .filter(f => f.endsWith('.sql') && f !== 'schema.sql')
      .sort()];

    let appliedCount = 0;
    let skippedCount = 0;

    for (const filename of files) {
      const filepath = join(dbDir, filename);
      if (!existsSync(filepath)) continue;

      const sql      = readFileSync(filepath, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      if (appliedMap.has(filename)) {
        // Verify checksum hasn't changed (protects against accidental edits)
        if (appliedMap.get(filename) !== checksum) {
          console.warn(`[MIGRATE] ⚠️  ${filename}: checksum changed — re-applying (idempotent schema)`);
        } else {
          console.log(`[MIGRATE] ⏭  ${filename}: already applied, skipping`);
          skippedCount++;
          continue;
        }
      }

      console.log(`[MIGRATE] ⬆  Applying ${filename}...`);
      const start = Date.now();

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO _migrations (filename, checksum)
           VALUES ($1, $2)
           ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = NOW()`,
          [filename, checksum]
        );
        await client.query('COMMIT');
        console.log(`[MIGRATE] ✅  ${filename} applied in ${Date.now() - start}ms`);
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[MIGRATE] ❌  ${filename} FAILED:`, err.message);
        if (err.detail) console.error('[MIGRATE]    Detail:', err.detail);
        if (err.hint)   console.error('[MIGRATE]    Hint:', err.hint);
        process.exit(1);
      }
    }

    console.log(`\n[MIGRATE] Done. Applied: ${appliedCount}, Skipped: ${skippedCount}`);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('[MIGRATE] Fatal:', err.message);
  process.exit(1);
});
