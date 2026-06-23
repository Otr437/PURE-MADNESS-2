'use strict';
/**
 * src/strategies/advanced/seasonal_engine.js
 *
 * Seasonal Pattern Engine.
 * Reads 3 years of stored OHLCV + spike data, computes:
 *   - Monthly average returns, win rates, std dev per pair
 *   - Weekly and day-of-week biases
 *   - Hourly patterns (best hours to buy/sell per DOW)
 *   - Spike recurrence frequency per calendar period
 *   - t-statistic + p-value for each signal (statistical significance)
 *   - Similarity scoring: compares YTD price path to same period in prior years
 *
 * Outputs are stored in seasonal_patterns and used by SeasonalBot.
 */

require('dotenv').config();
const { db, cache } = require('../../../infrastructure/db/database');

// ── MATH HELPERS ──────────────────────────────────────────────────────────────
const Math2 = {
  mean: (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,

  median: (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
  },

  std: (arr) => {
    if (arr.length < 2) return 0;
    const m = Math2.mean(arr);
    return Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (arr.length - 1));
  },

  // One-sample t-stat testing if mean != 0
  tStat: (arr) => {
    if (arr.length < 2) return 0;
    const m = Math2.mean(arr);
    const s = Math2.std(arr);
    if (s === 0) return 0;
    return (m / s) * Math.sqrt(arr.length);
  },

  // Approximate two-tailed p-value from t-stat (uses normal approximation for df>30)
  pValue: (t, df) => {
    if (df < 1) return 1;
    const absT = Math.abs(t);
    // Use normal approximation when df >= 30
    if (df >= 30) {
      return 2 * (1 - Math2.normCDF(absT));
    }
    // Very rough t-distribution approx for small samples
    const x = df / (df + absT * absT);
    const p = Math2.betaIncomplete(0.5 * df, 0.5, x);
    return Math.min(1, Math.max(0, p));
  },

  normCDF: (x) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  },

  betaIncomplete: (a, b, x) => {
    // Simplified regularized incomplete beta for t-distribution p-value
    if (x <= 0) return 0; if (x >= 1) return 1;
    const lbeta = Math2.lgamma(a) + Math2.lgamma(b) - Math2.lgamma(a + b);
    return Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / (a * Math.exp(lbeta));
  },

  lgamma: (z) => {
    const g = [76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,0.1208650973866179e-2,-0.5395239384953e-5];
    let x = z, y = z, tmp = z + 5.5;
    tmp -= (z + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (const c of g) { y++; ser += c / y; }
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  },

  // Pearson correlation between two arrays
  correlation: (a, b) => {
    if (a.length !== b.length || a.length < 2) return 0;
    const ma = Math2.mean(a), mb = Math2.mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da  += Math.pow(a[i] - ma, 2);
      db  += Math.pow(b[i] - mb, 2);
    }
    return (da === 0 || db === 0) ? 0 : num / Math.sqrt(da * db);
  },

  // Normalize array to % returns from first element
  toReturns: (prices) => prices.map((p, i) => i === 0 ? 0 : (p - prices[0]) / prices[0] * 100),

  // Normalise array to 0-1 range
  normalize: (arr) => {
    const min = Math.min(...arr), max = Math.max(...arr);
    if (max === min) return arr.map(() => 0.5);
    return arr.map(v => (v - min) / (max - min));
  },

  // DTW distance (simplified) for path similarity
  dtwDistance: (a, b) => {
    const n = a.length, m = b.length;
    const dtw = Array.from({ length: n+1 }, () => new Array(m+1).fill(Infinity));
    dtw[0][0] = 0;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const cost = Math.abs(a[i-1] - b[j-1]);
        dtw[i][j]  = cost + Math.min(dtw[i-1][j], dtw[i][j-1], dtw[i-1][j-1]);
      }
    }
    return dtw[n][m];
  },
};

// ── SEASONAL ENGINE ───────────────────────────────────────────────────────────
class SeasonalEngine {
  constructor() {
    this.pairs     = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];
    this.intervals = ['1d','4h','1h'];
    this.lookbackYears = 3;
  }

  // ── Main entry point ────────────────────────────────────────────────────────
  async computeAll() {
    console.log('[SEASONAL] Computing all patterns...');
    for (const pair of this.pairs) {
      for (const interval of this.intervals) {
        try {
          await this._computePairInterval(pair, interval);
        } catch (e) {
          console.error(`[SEASONAL] ${pair}:${interval} failed: ${e.message}`);
        }
      }
      // Also compute path similarity for daily only
      await this._computePathSimilarity(pair).catch(e =>
        console.error(`[SEASONAL] Path similarity ${pair}: ${e.message}`)
      );
    }
    console.log('[SEASONAL] Done. Invalidating cache...');
    await cache.del('seasonal:patterns:all');
  }

  // ── Per-pair/interval computation ───────────────────────────────────────────
  async _computePairInterval(pair, interval) {
    const fromDate = new Date(Date.now() - this.lookbackYears * 365 * 24 * 3600 * 1000);

    const candles = await db.query(
      `SELECT open_time, open, high, low, close, volume
       FROM ohlcv
       WHERE pair = $1 AND interval = $2 AND open_time >= $3
       ORDER BY open_time ASC`,
      [pair, interval, fromDate]
    );

    if (candles.rows.length < 30) {
      console.log(`[SEASONAL] ${pair}:${interval}: insufficient data (${candles.rows.length} candles)`);
      return;
    }

    const rows = candles.rows;
    // Compute per-candle return
    const enriched = rows.map((r, i) => ({
      ...r,
      returnPct: i === 0 ? 0 : ((parseFloat(r.close) - parseFloat(rows[i-1].close)) / parseFloat(rows[i-1].close)) * 100,
      time:      new Date(r.open_time),
    }));

    // Compute avg volume for ratio normalisation
    const avgVol = Math2.mean(enriched.map(r => parseFloat(r.volume)));

    // ── Monthly patterns ──────────────────────────────────────────────────────
    for (let month = 1; month <= 12; month++) {
      const subset = enriched.filter(r => r.time.getMonth() + 1 === month);
      if (subset.length < 2) continue;
      await this._upsertPattern(pair, interval, { month }, subset, avgVol);
    }

    // ── Weekly patterns ────────────────────────────────────────────────────────
    for (let dow = 0; dow <= 6; dow++) {
      const subset = enriched.filter(r => r.time.getDay() === dow);
      if (subset.length < 5) continue;
      await this._upsertPattern(pair, interval, { dayOfWeek: dow }, subset, avgVol);
    }

    // ── Hourly patterns (only for 1h and 4h) ──────────────────────────────────
    if (['1h','4h'].includes(interval)) {
      for (let hour = 0; hour <= 23; hour++) {
        const subset = enriched.filter(r => r.time.getUTCHours() === hour);
        if (subset.length < 5) continue;
        await this._upsertPattern(pair, interval, { hourOfDay: hour }, subset, avgVol);
      }
    }

    // ── Week-of-year patterns ──────────────────────────────────────────────────
    for (let woy = 1; woy <= 53; woy++) {
      const subset = enriched.filter(r => this._weekOfYear(r.time) === woy);
      if (subset.length < 2) continue;
      await this._upsertPattern(pair, interval, { weekOfYear: woy }, subset, avgVol);
    }

    console.log(`[SEASONAL] ${pair}:${interval}: patterns computed from ${rows.length} candles`);
  }

  // ── Upsert a single pattern row ─────────────────────────────────────────────
  async _upsertPattern(pair, interval, period, subset, avgVol) {
    const returns   = subset.map(r => r.returnPct);
    const volumes   = subset.map(r => parseFloat(r.volume));
    const wins      = returns.filter(r => r > 0).length;
    const n         = returns.length;

    const avgReturn = Math2.mean(returns);
    const medReturn = Math2.median(returns);
    const stdReturn = Math2.std(returns);
    const minReturn = Math.min(...returns);
    const maxReturn = Math.max(...returns);
    const winRate   = (wins / n) * 100;
    const tStat     = Math2.tStat(returns);
    const pVal      = Math2.pValue(tStat, n - 1);
    const volRatio  = avgVol > 0 ? Math2.mean(volumes) / avgVol : 1;

    // Signal strength: combination of win rate deviation from 50%, sample size, and p-value
    const winBias    = Math.abs(winRate - 50) / 50;
    const sizeFactor = Math.min(n / 36, 1); // caps at 3 years of monthly data
    const sigFactor  = 1 - Math.min(pVal, 1);
    const strength   = (winBias * 0.4 + sigFactor * 0.4 + sizeFactor * 0.2);

    // Spike frequency from price_spikes table
    const spikeQuery = await db.query(
      `SELECT COUNT(DISTINCT year) AS spike_years,
              COUNT(*) AS total_spikes
       FROM price_spikes
       WHERE pair = $1 AND interval = $2
         ${period.month      !== undefined ? 'AND month = ' + period.month : ''}
         ${period.dayOfWeek  !== undefined ? 'AND day_of_week = ' + period.dayOfWeek : ''}
         ${period.hourOfDay  !== undefined ? 'AND hour_of_day = ' + period.hourOfDay : ''}
         ${period.weekOfYear !== undefined ? 'AND week_of_year = ' + period.weekOfYear : ''}`,
      [pair, interval]
    );

    const spikeYears = parseInt(spikeQuery.rows[0]?.spike_years || 0);
    const spikeFreq  = this.lookbackYears > 0 ? (spikeYears / this.lookbackYears) * 100 : 0;

    // Unique constraint columns
    const { month = null, weekOfYear = null, dayOfWeek = null, hourOfDay = null } = period;

    await db.query(
      `INSERT INTO seasonal_patterns
         (pair, interval, month, week_of_year, day_of_week, hour_of_day,
          years_in_sample, sample_count,
          avg_return_pct, median_return_pct, std_return_pct, min_return_pct, max_return_pct,
          win_rate_pct, t_stat, p_value, signal_strength,
          bullish_bias, bearish_bias,
          avg_volume_ratio, spike_frequency_pct, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
       ON CONFLICT (pair, interval, month, week_of_year, day_of_week, hour_of_day)
       DO UPDATE SET
         years_in_sample    = EXCLUDED.years_in_sample,
         sample_count       = EXCLUDED.sample_count,
         avg_return_pct     = EXCLUDED.avg_return_pct,
         median_return_pct  = EXCLUDED.median_return_pct,
         std_return_pct     = EXCLUDED.std_return_pct,
         min_return_pct     = EXCLUDED.min_return_pct,
         max_return_pct     = EXCLUDED.max_return_pct,
         win_rate_pct       = EXCLUDED.win_rate_pct,
         t_stat             = EXCLUDED.t_stat,
         p_value            = EXCLUDED.p_value,
         signal_strength    = EXCLUDED.signal_strength,
         bullish_bias       = EXCLUDED.bullish_bias,
         bearish_bias       = EXCLUDED.bearish_bias,
         avg_volume_ratio   = EXCLUDED.avg_volume_ratio,
         spike_frequency_pct= EXCLUDED.spike_frequency_pct,
         computed_at        = NOW()`,
      [
        pair, interval,
        month, weekOfYear, dayOfWeek, hourOfDay,
        this.lookbackYears, n,
        parseFloat(avgReturn.toFixed(4)),
        parseFloat(medReturn.toFixed(4)),
        parseFloat(stdReturn.toFixed(4)),
        parseFloat(minReturn.toFixed(4)),
        parseFloat(maxReturn.toFixed(4)),
        parseFloat(winRate.toFixed(2)),
        parseFloat(tStat.toFixed(4)),
        parseFloat(pVal.toFixed(6)),
        parseFloat(strength.toFixed(4)),
        avgReturn > 0.5 && winRate >= 55,  // bullish bias
        avgReturn < -0.5 && winRate <= 45, // bearish bias
        parseFloat(volRatio.toFixed(4)),
        parseFloat(spikeFreq.toFixed(2)),
      ]
    );
  }

  // ── Path similarity: compare YTD to same period in prior years ──────────────
  async _computePathSimilarity(pair) {
    const now       = new Date();
    const ytdStart  = new Date(now.getFullYear(), 0, 1); // Jan 1 current year
    const dayOfYear = Math.floor((now - ytdStart) / 86400000);

    const ytdCandles = await db.query(
      `SELECT close FROM ohlcv
       WHERE pair = $1 AND interval = '1d' AND open_time >= $2
       ORDER BY open_time ASC LIMIT $3`,
      [pair, ytdStart, dayOfYear]
    );
    if (ytdCandles.rows.length < 10) return;

    const ytdPrices  = ytdCandles.rows.map(r => parseFloat(r.close));
    const ytdReturns = Math2.normalize(Math2.toReturns(ytdPrices));
    const similarities = [];

    // Compare to each of the last 3 years
    for (let y = 1; y <= this.lookbackYears; y++) {
      const year   = now.getFullYear() - y;
      const yStart = new Date(year, 0, 1);
      const yEnd   = new Date(year, now.getMonth(), now.getDate());

      const priorCandles = await db.query(
        `SELECT close FROM ohlcv
         WHERE pair = $1 AND interval = '1d' AND open_time BETWEEN $2 AND $3
         ORDER BY open_time ASC`,
        [pair, yStart, yEnd]
      );
      if (priorCandles.rows.length < 10) continue;

      const priorPrices  = priorCandles.rows.map(r => parseFloat(r.close));
      const priorReturns = Math2.normalize(Math2.toReturns(priorPrices));

      // Align lengths
      const minLen = Math.min(ytdReturns.length, priorReturns.length);
      const corr   = Math2.correlation(ytdReturns.slice(0, minLen), priorReturns.slice(0, minLen));
      const dtw    = Math2.dtwDistance(ytdReturns.slice(0, minLen), priorReturns.slice(0, minLen));

      // Combined similarity: 60% correlation + 40% DTW proximity
      const dtwScore = Math.max(0, 1 - dtw / minLen);
      const simScore = corr * 0.6 + dtwScore * 0.4;

      similarities.push({ year, correlation: corr, dtwScore, simScore });
    }

    if (!similarities.length) return;

    // Cache results for the seasonal bot to use
    await cache.set(
      `seasonal:path_similarity:${pair}`,
      { pair, computedAt: now.toISOString(), dayOfYear, similarities },
      3600 * 6 // 6 hour TTL
    );

    const best = similarities.sort((a, b) => b.simScore - a.simScore)[0];
    console.log(
      `[SEASONAL] ${pair} YTD most similar to ${best.year}: ` +
      `corr=${best.correlation.toFixed(3)} simScore=${best.simScore.toFixed(3)}`
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  _weekOfYear(date) {
    const d    = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day  = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const year = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - year) / 86400000) + 1) / 7);
  }

  // ── Query API for the bot ────────────────────────────────────────────────────

  /** Get the seasonal bias for a specific pair right now */
  async getCurrentBias(pair, interval = '1d') {
    const now   = new Date();
    const month = now.getMonth() + 1;
    const dow   = now.getDay();
    const hour  = now.getUTCHours();
    const woy   = this._weekOfYear(now);

    // Monthly (strongest signal)
    const monthly = await db.query(
      `SELECT * FROM seasonal_patterns
       WHERE pair=$1 AND interval=$2 AND month=$3
         AND week_of_year IS NULL AND day_of_week IS NULL AND hour_of_day IS NULL`,
      [pair, interval, month]
    );

    // Weekly DOW
    const daily = await db.query(
      `SELECT * FROM seasonal_patterns
       WHERE pair=$1 AND interval=$2 AND day_of_week=$3
         AND month IS NULL AND week_of_year IS NULL AND hour_of_day IS NULL`,
      [pair, interval, dow]
    );

    // Path similarity
    const pathSim = await cache.get(`seasonal:path_similarity:${pair}`);

    return {
      pair, interval, now: now.toISOString(),
      monthly:    monthly.rows[0] ?? null,
      dayOfWeek:  daily.rows[0]   ?? null,
      pathSimilarity: pathSim,
      // Composite signal
      signal: this._compositeSignal(monthly.rows[0], daily.rows[0], pathSim),
    };
  }

  /** Combine multiple seasonal signals into a single score (-1 to +1) */
  _compositeSignal(monthly, dow, pathSim) {
    let score = 0, weight = 0;

    if (monthly) {
      const monthScore = (parseFloat(monthly.avg_return_pct) / 10) *
                         parseFloat(monthly.signal_strength);
      score  += monthScore * 0.5;
      weight += 0.5;
    }

    if (dow) {
      const dowScore = (parseFloat(dow.avg_return_pct) / 5) *
                        parseFloat(dow.signal_strength);
      score  += dowScore * 0.3;
      weight += 0.3;
    }

    if (pathSim?.similarities?.length) {
      const bestSim = pathSim.similarities[0];
      // If current year looks like a bullish prior year, lean long
      const simBias = bestSim.simScore > 0.6 ? 0.2 : 0;
      score  += simBias;
      weight += 0.2;
    }

    if (weight === 0) return { score: 0, direction: 'neutral', confidence: 0 };

    const normalised  = Math.max(-1, Math.min(1, score / weight));
    const direction   = normalised > 0.15 ? 'bullish' : normalised < -0.15 ? 'bearish' : 'neutral';
    const confidence  = Math.abs(normalised);

    return { score: parseFloat(normalised.toFixed(4)), direction, confidence: parseFloat(confidence.toFixed(4)) };
  }

  /** Get the historically best entry times for this pair (buy low targets) */
  async getBestEntryWindows(pair, interval = '1d') {
    const res = await db.query(
      `SELECT month, avg_return_pct, win_rate_pct, signal_strength,
              spike_frequency_pct, bullish_bias, bearish_bias
       FROM seasonal_patterns
       WHERE pair=$1 AND interval=$2 AND month IS NOT NULL
         AND week_of_year IS NULL AND day_of_week IS NULL AND hour_of_day IS NULL
       ORDER BY avg_return_pct DESC`,
      [pair, interval]
    );
    return res.rows;
  }

  /** Get months that historically precede rallies (best to accumulate/buy) */
  async getAccumulationMonths(pair) {
    const res = await db.query(
      `SELECT sp.month,
              sp.avg_return_pct AS this_month_avg,
              next_sp.avg_return_pct AS next_month_avg,
              sp.win_rate_pct,
              sp.signal_strength
       FROM seasonal_patterns sp
       JOIN seasonal_patterns next_sp
         ON next_sp.pair = sp.pair AND next_sp.interval = sp.interval
         AND next_sp.month = (sp.month % 12) + 1
         AND next_sp.week_of_year IS NULL AND next_sp.day_of_week IS NULL AND next_sp.hour_of_day IS NULL
       WHERE sp.pair=$1 AND sp.interval='1d' AND sp.month IS NOT NULL
         AND sp.week_of_year IS NULL AND sp.day_of_week IS NULL AND sp.hour_of_day IS NULL
         AND next_sp.avg_return_pct > 2   -- next month historically up >2%
         AND sp.avg_return_pct < 0        -- current month historically down (dip to buy)
       ORDER BY next_sp.avg_return_pct DESC`,
      [pair]
    );
    return res.rows; // months where dipping NOW typically precedes a rally
  }

  /** Fetch spike recurrence: did spikes in this month historically resolve in which direction? */
  async getSpikeReversionStats(pair, month, interval = '1d') {
    const res = await db.query(
      `SELECT
         direction,
         COUNT(*) AS count,
         ROUND(AVG(ABS(pct_move)), 4) AS avg_spike_pct,
         ROUND(AVG(revert_1h_pct),  4) AS avg_revert_1h,
         ROUND(AVG(revert_4h_pct),  4) AS avg_revert_4h,
         ROUND(AVG(revert_24h_pct), 4) AS avg_revert_24h,
         ROUND(AVG(revert_7d_pct),  4) AS avg_revert_7d,
         ROUND(COUNT(*) FILTER (WHERE revert_24h_pct * CASE direction WHEN 'BUY' THEN -1 ELSE 1 END > 0)
               ::FLOAT / NULLIF(COUNT(*),0) * 100, 1) AS reversion_rate_pct
       FROM price_spikes
       WHERE pair=$1 AND interval=$2 AND month=$3
       GROUP BY direction`,
      [pair, interval, month]
    );
    return res.rows;
  }
}

// ── RUN STANDALONE ────────────────────────────────────────────────────────────
if (require.main === module) {
  const engine = new SeasonalEngine();
  engine.computeAll()
    .then(() => { console.log('[SEASONAL] Complete'); process.exit(0); })
    .catch(e  => { console.error('[SEASONAL] Fatal:', e.message); process.exit(1); });
}

module.exports = { SeasonalEngine, Math2 };
