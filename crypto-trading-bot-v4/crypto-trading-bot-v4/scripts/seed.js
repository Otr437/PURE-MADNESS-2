'use strict';
/**
 * scripts/seed.js
 * Seeds the database with default bot records.
 * Safe to re-run — uses ON CONFLICT DO NOTHING.
 */

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { Pool }       = require('pg');
const defaultConfigs = require('../config/default');

const BOTS = [
  { key: 'cross_arb',  name: 'Cross-Exchange Arbitrage', botType: 'cross_exchange_arb', tradeAmount: 100  },
  { key: 'tri_arb',    name: 'Triangular Arbitrage',     botType: 'triangular_arb',     tradeAmount: 500  },
  { key: 'cash_carry', name: 'Cash & Carry',             botType: 'cash_carry',         tradeAmount: 1000 },
  { key: 'dca',        name: 'DCA Bot',                  botType: 'dca',                tradeAmount: 100  },
  { key: 'grid',       name: 'Grid Bot',                 botType: 'grid',               tradeAmount: 1000 },
  { key: 'trend',      name: 'Trend Following',          botType: 'trend_following',    tradeAmount: 500  },
  { key: 'scalp',      name: 'Momentum Scalp',           botType: 'momentum_scalp',     tradeAmount: 200  },
];

// Keys to strip from config before persisting (should never be in DB)
const SENSITIVE = ['apiKey','apiSecret','privateKey','clientSecret','password','secret'];

function sanitise(config) {
  const out = JSON.parse(JSON.stringify(config));
  const redact = (obj) => {
    for (const k of Object.keys(obj || {})) {
      if (SENSITIVE.some(s => k.toLowerCase().includes(s))) delete obj[k];
      else if (typeof obj[k] === 'object' && obj[k] !== null) redact(obj[k]);
    }
  };
  redact(out);
  return out;
}

async function seed() {
  if (!process.env.POSTGRES_USER && !process.env.DATABASE_URL) {
    console.error('[SEED] Error: POSTGRES_USER or DATABASE_URL must be set');
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
  });

  const client = await pool.connect();
  console.log('[SEED] Connected');

  let created = 0, skipped = 0;

  try {
    for (const def of BOTS) {
      const config = sanitise(defaultConfigs[def.key] || {});
      const id     = uuidv4();

      const res = await client.query(
        `INSERT INTO bots (id, name, bot_type, config, dry_run,
                           initial_capital_usdt, current_capital_usdt,
                           max_position_usdt, daily_loss_limit_usdt)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [
          id,
          def.name,
          def.botType,
          JSON.stringify(config),
          true,                          // dry_run default
          def.tradeAmount,              // initial_capital_usdt
          def.tradeAmount,              // max_position_usdt
          def.tradeAmount * 0.1,        // daily_loss_limit_usdt (10% of capital)
        ]
      );

      if (res.rows.length) {
        console.log(`[SEED] ✅  Created: ${def.name} (${res.rows[0].id})`);
        created++;
      } else {
        console.log(`[SEED] ⏭  Skipped (already exists): ${def.name}`);
        skipped++;
      }
    }

    console.log(`\n[SEED] Done. Created: ${created}, Skipped: ${skipped}`);
  } catch (err) {
    console.error('[SEED] ❌ Failed:', err.message);
    if (err.detail) console.error('[SEED]    Detail:', err.detail);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error('[SEED] Fatal:', err.message);
  process.exit(1);
});
