'use strict';
/**
 * src/strategies/advanced/historical_ingestion.js
 *
 * Fetches 3 years of OHLCV candle data from exchange REST APIs,
 * stores it in the ohlcv table, detects price spikes, and
 * triggers the seasonal pattern engine to recompute patterns.
 *
 * Run standalone: node src/strategies/advanced/historical_ingestion.js
 * Or called by the seasonal bot on startup.
 */

require('dotenv').config();
const axios  = require('axios');
const { db, cache } = require('../../../infrastructure/db/database');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  exchange:   process.env.EXCHANGE_A_NAME    || 'binance',
  baseUrl:    process.env.EXCHANGE_A_BASE_URL || 'https://api.binance.com',

  pairs: ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'],
  intervals: ['1d','4h','1h'],

  // Fetch 3 years of daily data
  lookbackYears: 3,

  // Spike detection thresholds
  spikeThresholds: {
    '1d':  3.0,   // >=3% move in a day
    '4h':  2.0,   // >=2% move in 4h
    '1h':  1.5,   // >=1.5% move in 1h
  },

  // Spike: volume must be >= this multiple of 20-period average
  volumeSpikeMultiplier: 1.5,

  // Batch size for DB inserts
  insertBatchSize: 500,

  // Rate limiting between API calls
  requestDelayMs: 300,
};

// ── EXCHANGE FETCHER ──────────────────────────────────────────────────────────
class ExchangeFetcher {
  constructor(baseUrl) {
    this.http = axios.create({ baseURL: baseUrl, timeout: 15_000 });
  }

  /**
   * Fetch up to 1000 candles per call (Binance limit).
   * Returns array of OHLCV objects.
   */
  async fetchKlines(pair, interval, startTime, endTime) {
    const res = await this.http.get('/api/v3/klines', {
      params: {
        symbol:    pair,
        interval:  interval,
        startTime: startTime,
        endTime:   endTime,
        limit:     1000,
      },
    });

    return res.data.map(k => ({
      openTime:    new Date(k[0]),
      open:        parseFloat(k[1]),
      high:        parseFloat(k[2]),
      low:         parseFloat(k[3]),
      close:       parseFloat(k[4]),
      volume:      parseFloat(k[5]),
      closeTime:   new Date(k[6]),
      quoteVolume: parseFloat(k[7]),
      tradeCount:  parseInt(k[8]),
    }));
  }

  /**
   * Fetch ALL candles between startMs and endMs,
   * paginating automatically (1000 at a time).
   */
  async fetchAllKlines(pair, interval, startMs, endMs, onProgress) {
    const allCandles = [];
    let   cursor     = startMs;

    while (cursor < endMs) {
      const batch = await this.fetchKlines(pair, interval, cursor, endMs);
      if (!batch.length) break;

      allCandles.push(...batch);
      cursor = batch[batch.length - 1].openTime.getTime() + 1;

      if (onProgress) onProgress(allCandles.length);

      // Respect rate limits
      await new Promise(r => setTimeout(r, CONFIG.requestDelayMs));
    }

    return allCandles;
  }
}

// ── DB HELPERS ────────────────────────────────────────────────────────────────
class OHLCVStore {
  /**
   * Bulk-upsert candles into ohlcv table.
   * ON CONFLICT DO NOTHING makes it idempotent.
   */
  async insertCandles(pair, exchange, interval, candles) {
    if (!candles.length) return 0;

    let inserted = 0;
    for (let i = 0; i < candles.length; i += CONFIG.insertBatchSize) {
      const batch = candles.slice(i, i + CONFIG.insertBatchSize);

      const values = batch.map((_, j) => {
        const base = j * 8;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`;
      }).join(',');

      const params = [];
      for (const c of batch) {
        params.push(pair, exchange, interval, c.openTime,
                    c.open, c.high, c.low, c.close, c.volume);
      }

      const res = await db.query(
        `INSERT INTO ohlcv (pair, exchange, interval, open_time, open, high, low, close, volume)
         VALUES ${values}
         ON CONFLICT (pair, exchange, interval, open_time) DO NOTHING`,
        params
      );
      inserted += res.rowCount || 0;
    }
    return inserted;
  }

  /**
   * Fetch stored candles for spike detection and seasonal analysis.
   */
  async getCandles(pair, interval, fromTime, toTime) {
    const res = await db.query(
      `SELECT open_time, open, high, low, close, volume
       FROM ohlcv
       WHERE pair = $1 AND interval = $2 AND open_time BETWEEN $3 AND $4
       ORDER BY open_time ASC`,
      [pair, interval, fromTime, toTime]
    );
    return res.rows;
  }

  /**
   * Get the latest stored candle time (so we only fetch new data).
   */
  async getLatestTime(pair, exchange, interval) {
    const res = await db.query(
      `SELECT MAX(open_time) AS latest FROM ohlcv
       WHERE pair = $1 AND exchange = $2 AND interval = $3`,
      [pair, exchange, interval]
    );
    return res.rows[0]?.latest ?? null;
  }

  async getCandleCount(pair, exchange, interval) {
    const res = await db.query(
      `SELECT COUNT(*) AS cnt FROM ohlcv WHERE pair=$1 AND exchange=$2 AND interval=$3`,
      [pair, exchange, interval]
    );
    return parseInt(res.rows[0]?.cnt || 0);
  }
}

// ── SPIKE DETECTOR ────────────────────────────────────────────────────────────
class SpikeDetector {
  /**
   * Scan a candle array, detect spikes, upsert to price_spikes.
   * A spike = |pctMove| >= threshold AND volume >= volumeSpikeMultiplier * rollingAvg.
   */
  async detectAndStore(pair, exchange, interval, candles) {
    if (candles.length < 25) return 0; // need at least 20 for rolling avg

    const threshold = CONFIG.spikeThresholds[interval] || 2.0;
    const spikes    = [];

    // Pre-compute 20-period rolling volume average
    for (let i = 20; i < candles.length; i++) {
      const c = candles[i];
      const o = parseFloat(c.open), cl = parseFloat(c.close);
      const h = parseFloat(c.high), l  = parseFloat(c.low);
      const v = parseFloat(c.volume);

      const pctMove = ((cl - o) / o) * 100;
      const pctWick = ((h - l)  / o) * 100;

      if (Math.abs(pctMove) < threshold) continue;

      // Rolling 20-bar volume average
      const volSlice  = candles.slice(i - 20, i).map(x => parseFloat(x.volume));
      const volAvg    = volSlice.reduce((a, b) => a + b, 0) / 20;
      const volStd    = Math.sqrt(volSlice.reduce((a, b) => a + Math.pow(b - volAvg, 2), 0) / 20);
      const volZ      = volStd > 0 ? (v - volAvg) / volStd : 0;

      // Volume must confirm the spike
      if (v < volAvg * CONFIG.volumeSpikeMultiplier) continue;

      spikes.push({
        pair,
        exchange,
        interval,
        spikeTime:   c.open_time,
        direction:   pctMove > 0 ? 'BUY' : 'SELL',
        openPrice:   o,
        closePrice:  cl,
        highPrice:   h,
        lowPrice:    l,
        pctMove:     parseFloat(pctMove.toFixed(4)),
        pctWick:     parseFloat(pctWick.toFixed(4)),
        volume:      v,
        volumeZScore:parseFloat(volZ.toFixed(4)),
      });
    }

    if (!spikes.length) return 0;

    // Batch upsert spikes
    for (let i = 0; i < spikes.length; i += 50) {
      const batch  = spikes.slice(i, i + 50);
      const vals   = batch.map((_, j) => {
        const b = j * 11;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
      }).join(',');
      const params = [];
      for (const s of batch) {
        params.push(s.pair, s.exchange, s.interval, s.spikeTime, s.direction,
                    s.openPrice, s.closePrice, s.highPrice, s.lowPrice,
                    s.pctMove, s.volumeZScore);
      }
      await db.query(
        `INSERT INTO price_spikes
           (pair, exchange, interval, spike_time, direction,
            open_price, close_price, high_price, low_price,
            pct_move, volume_z_score)
         VALUES ${vals}
         ON CONFLICT DO NOTHING`,
        params
      ).catch(e => console.error('[SPIKE] Insert error:', e.message));
    }

    return spikes.length;
  }

  /**
   * Back-fill reversion outcomes for spikes that have enough future data.
   */
  async backfillReversionOutcomes(pair, interval) {
    const unresolved = await db.query(
      `SELECT sp.id, sp.spike_time, sp.close_price, sp.direction
       FROM price_spikes sp
       WHERE sp.pair = $1 AND sp.interval = $2
         AND sp.revert_24h_pct IS NULL
         AND sp.spike_time < NOW() - INTERVAL '7 days'`,
      [pair, interval]
    );

    for (const spike of unresolved.rows) {
      const after = await db.query(
        `SELECT open_time, close
         FROM ohlcv
         WHERE pair = $1 AND interval = $2 AND open_time > $3
         ORDER BY open_time ASC
         LIMIT 168`,
        [pair, interval, spike.spike_time]
      );

      if (after.rows.length < 24) continue;

      const base    = parseFloat(spike.close_price);
      const get     = (n) => after.rows[n] ? parseFloat(after.rows[n].close) : null;
      const revert  = (price) => price ? ((price - base) / base * 100) : null;

      // Map approximate candle indexes to time offsets based on interval
      const stepMap = { '1h':1, '4h':4, '1d':24 };
      const step    = stepMap[interval] || 1;

      await db.query(
        `UPDATE price_spikes SET
           revert_1h_pct  = $2,
           revert_4h_pct  = $3,
           revert_24h_pct = $4,
           revert_7d_pct  = $5
         WHERE id = $1`,
        [
          spike.id,
          revert(get(Math.round(1/step))),
          revert(get(Math.round(4/step))),
          revert(get(Math.round(24/step))),
          revert(get(Math.round(168/step))),
        ]
      );
    }
  }
}

// ── INGESTION ORCHESTRATOR ────────────────────────────────────────────────────
class HistoricalIngestion {
  constructor() {
    this.fetcher  = new ExchangeFetcher(CONFIG.baseUrl);
    this.store    = new OHLCVStore();
    this.detector = new SpikeDetector();
  }

  async run() {
    const endMs   = Date.now();
    const startMs = endMs - CONFIG.lookbackYears * 365 * 24 * 60 * 60 * 1000;

    console.log(`[INGEST] Starting historical ingestion`);
    console.log(`[INGEST] Range: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`);
    console.log(`[INGEST] Pairs: ${CONFIG.pairs.join(', ')} | Intervals: ${CONFIG.intervals.join(', ')}`);

    for (const pair of CONFIG.pairs) {
      for (const interval of CONFIG.intervals) {
        await this._ingestPairInterval(pair, interval, startMs, endMs);
      }
    }

    console.log('[INGEST] All pairs/intervals complete. Running seasonal computation...');
  }

  async _ingestPairInterval(pair, interval, startMs, endMs) {
    const logKey = `${pair}:${interval}`;

    // Find where we left off (incremental ingestion)
    const latest = await this.store.getLatestTime(pair, CONFIG.exchange, interval);
    const from   = latest
      ? Math.max(startMs, new Date(latest).getTime() + 1)
      : startMs;

    if (from >= endMs) {
      console.log(`[INGEST] ${logKey}: up-to-date (${await this.store.getCandleCount(pair, CONFIG.exchange, interval)} candles stored)`);
      return;
    }

    // Log ingestion start
    const logRes = await db.query(
      `INSERT INTO ingestion_log (pair, exchange, interval, from_time, to_time, candles_count, status)
       VALUES ($1,$2,$3,$4,$5,0,'running') RETURNING id`,
      [pair, CONFIG.exchange, interval, new Date(from), new Date(endMs)]
    );
    const logId  = logRes.rows[0].id;
    const t0     = Date.now();

    try {
      console.log(`[INGEST] ${logKey}: fetching from ${new Date(from).toISOString()}`);

      const candles  = await this.fetcher.fetchAllKlines(
        pair, interval, from, endMs,
        (n) => process.stdout.write(`\r[INGEST] ${logKey}: ${n} candles fetched...`)
      );
      process.stdout.write('\n');

      if (!candles.length) {
        await db.query(`UPDATE ingestion_log SET status='done', candles_count=0, completed_at=NOW() WHERE id=$1`, [logId]);
        return;
      }

      // Insert into DB
      const inserted = await this.store.insertCandles(pair, CONFIG.exchange, interval, candles);
      console.log(`[INGEST] ${logKey}: inserted ${inserted}/${candles.length} new candles`);

      // Detect spikes in ALL stored data (not just new)
      const allCandles = await this.store.getCandles(pair, interval, new Date(startMs), new Date(endMs));
      const spikes     = await this.detector.detectAndStore(pair, CONFIG.exchange, interval, allCandles);
      console.log(`[INGEST] ${logKey}: detected ${spikes} spikes`);

      // Back-fill reversion outcomes
      await this.detector.backfillReversionOutcomes(pair, interval);

      await db.query(
        `UPDATE ingestion_log SET status='done', candles_count=$2, duration_ms=$3, completed_at=NOW() WHERE id=$1`,
        [logId, inserted, Date.now() - t0]
      );
    } catch (err) {
      console.error(`[INGEST] ${logKey}: FAILED — ${err.message}`);
      await db.query(
        `UPDATE ingestion_log SET status='failed', error_message=$2, duration_ms=$3, completed_at=NOW() WHERE id=$1`,
        [logId, err.message.slice(0, 500), Date.now() - t0]
      );
    }
  }
}

// ── RUN ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const ing = new HistoricalIngestion();
  ing.run()
    .then(() => { console.log('[INGEST] Done'); process.exit(0); })
    .catch(e  => { console.error('[INGEST] Fatal:', e.message); process.exit(1); });
}

module.exports = { HistoricalIngestion, OHLCVStore, SpikeDetector };
