'use strict';
/**
 * src/shared/rust-bridge/index.js
 *
 * Node.js ↔ Rust binary bridge.
 *
 * Architecture:
 *   - Spawns the compiled Rust binary as a child process
 *   - Communicates via stdin/stdout line-delimited JSON
 *   - Every call is async — request ID maps to a Promise resolver
 *   - Automatic fallback to JS indicators.js on any Rust error or timeout
 *   - Circuit breaker: if Rust fails N times consecutively, JS-only mode
 *   - Health check loop keeps the binary alive and detects crashes
 *   - Metrics tracked: rust_calls, fallback_calls, avg_latency_us, errors
 *
 * Security:
 *   - Binary path validated at startup (must be absolute, must exist)
 *   - Child process runs with restricted env (no secrets passed through)
 *   - Request size capped at 2MB to match Rust-side limit
 *   - Response size capped — oversized responses rejected
 *   - Request timeout enforced per-call (default 100ms for indicators)
 *   - All user-supplied values are numbers — no string injection possible
 *     since params are serialised via JSON.stringify before sending
 */

const { spawn }      = require('child_process');
const path           = require('path');
const fs             = require('fs');
const EventEmitter   = require('events');
const Indicators     = require('../indicators');

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const BINARY_NAME        = process.platform === 'win32' ? 'crypto-indicators.exe' : 'crypto-indicators';
const DEFAULT_BINARY_PATH= path.resolve(__dirname, '../../../rust/crypto-indicators/target/release', BINARY_NAME);
const MAX_REQUEST_BYTES  = 2_097_152;    // 2MB — matches Rust side
const MAX_RESPONSE_BYTES = 4_194_304;    // 4MB
const DEFAULT_TIMEOUT_MS = 100;          // per-call timeout — indicators are fast
const HEALTH_INTERVAL_MS = 30_000;       // how often to ping the binary
const CB_THRESHOLD       = 5;            // consecutive failures before circuit opens
const CB_RESET_MS        = 60_000;       // circuit reset after 1 min

// ── METRICS ───────────────────────────────────────────────────────────────────
const metrics = {
  rustCalls:       0,
  rustErrors:      0,
  fallbackCalls:   0,
  timeouts:        0,
  totalLatencyUs:  0,
  maxLatencyUs:    0,
  circuitTrips:    0,
  startedAt:       Date.now(),
};

function recordRustCall(latencyUs, errored) {
  metrics.rustCalls++;
  if (errored) metrics.rustErrors++;
  metrics.totalLatencyUs += latencyUs;
  if (latencyUs > metrics.maxLatencyUs) metrics.maxLatencyUs = latencyUs;
}

// ── BRIDGE CLASS ──────────────────────────────────────────────────────────────
class RustBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._binaryPath  = opts.binaryPath || DEFAULT_BINARY_PATH;
    this._timeoutMs   = opts.timeoutMs  || DEFAULT_TIMEOUT_MS;
    this._proc        = null;
    this._pending     = new Map();  // id → { resolve, reject, timer, startUs }
    this._nextId      = 1n;         // BigInt counter — never wraps
    this._cbFailures  = 0;
    this._cbOpenAt    = 0;
    this._ready       = false;
    this._healthTimer = null;
    this._lineBuffer  = '';
    this._log         = opts.logger || console;
  }

  // ── STARTUP ────────────────────────────────────────────────────────────────

  async start() {
    this._validateBinary();
    await this._spawn();
    await this._waitReady();
    this._startHealthCheck();
    this._log.info?.('[RUST-BRIDGE] Ready');
  }

  _validateBinary() {
    if (!path.isAbsolute(this._binaryPath)) {
      throw new Error(`RustBridge: binary path must be absolute: ${this._binaryPath}`);
    }
    if (!fs.existsSync(this._binaryPath)) {
      throw new Error(
        `RustBridge: binary not found at ${this._binaryPath}. ` +
        `Run: cd rust/crypto-indicators && cargo build --release`
      );
    }
    const stat = fs.statSync(this._binaryPath);
    if (!stat.isFile()) {
      throw new Error(`RustBridge: path is not a file: ${this._binaryPath}`);
    }
    // On Unix verify it's executable
    if (process.platform !== 'win32') {
      try { fs.accessSync(this._binaryPath, fs.constants.X_OK); }
      catch (_) { throw new Error(`RustBridge: binary is not executable: ${this._binaryPath}`); }
    }
  }

  _spawn() {
    // Strip all sensitive env vars — child only needs PATH and RUST_LOG
    const safeEnv = {
      PATH:     process.env.PATH || '',
      RUST_LOG: process.env.RUST_LOG || 'warn',
      HOME:     process.env.HOME || '',
      TMPDIR:   process.env.TMPDIR || '/tmp',
    };

    this._proc = spawn(this._binaryPath, [], {
      env:   safeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._proc.stdout.setEncoding('utf8');
    this._proc.stdout.on('data', (chunk) => this._onData(chunk));
    this._proc.stderr.setEncoding('utf8');
    this._proc.stderr.on('data', (chunk) => {
      // Binary logs to stderr — forward at debug level
      for (const line of chunk.split('\n')) {
        if (line.trim()) this._log.debug?.(`[RUST] ${line}`);
      }
    });

    this._proc.on('error', (err) => {
      this._log.error?.(`[RUST-BRIDGE] Process error: ${err.message}`);
      this._onProcessDied(err.message);
    });

    this._proc.on('exit', (code, signal) => {
      this._log.warn?.(`[RUST-BRIDGE] Process exited code=${code} signal=${signal}`);
      this._ready = false;
      this._onProcessDied(`exit code=${code} signal=${signal}`);
    });
  }

  async _waitReady(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this._call('health', {}, 2000);
        if (result?.status === 'ok') { this._ready = true; return; }
      } catch (_) {}
      await sleep(200);
    }
    throw new Error('RustBridge: binary did not become ready within timeout');
  }

  // ── DATA HANDLING ──────────────────────────────────────────────────────────

  _onData(chunk) {
    this._lineBuffer += chunk;
    let nl;
    while ((nl = this._lineBuffer.indexOf('\n')) !== -1) {
      const line = this._lineBuffer.slice(0, nl).trim();
      this._lineBuffer = this._lineBuffer.slice(nl + 1);
      if (!line) continue;

      // Response size guard
      if (line.length > MAX_RESPONSE_BYTES) {
        this._log.error?.(`[RUST-BRIDGE] Response too large (${line.length} bytes) — discarding`);
        continue;
      }

      let resp;
      try { resp = JSON.parse(line); }
      catch (e) {
        this._log.error?.(`[RUST-BRIDGE] JSON parse error: ${e.message} | line: ${line.slice(0, 200)}`);
        continue;
      }

      this._onResponse(resp);
    }
  }

  _onResponse(resp) {
    const id      = String(resp.id);
    const pending = this._pending.get(id);
    if (!pending) return; // timed out or unknown

    clearTimeout(pending.timer);
    this._pending.delete(id);

    const latencyUs = Number(BigInt(Date.now()) * 1000n - pending.startUs);
    recordRustCall(latencyUs, !resp.ok);

    if (resp.ok) {
      this._cbFailures = 0; // reset circuit breaker on success
      pending.resolve(resp.data);
    } else {
      this._onRustError(resp.error || 'unknown error', resp.error_kind || 'computation');
      pending.reject(new RustBridgeError(resp.error || 'Rust error', resp.error_kind));
    }
  }

  _onRustError(msg, kind) {
    this._cbFailures++;
    if (this._cbFailures >= CB_THRESHOLD) {
      this._cbOpenAt = Date.now();
      metrics.circuitTrips++;
      this._log.error?.(`[RUST-BRIDGE] Circuit breaker OPEN after ${this._cbFailures} failures. JS fallback active.`);
      this.emit('circuit_open');
    }
  }

  _onProcessDied(reason) {
    // Reject all pending requests
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`RustBridge: process died — ${reason}`));
    }
    this._pending.clear();
    this._ready = false;
    this.emit('process_died', reason);
  }

  // ── CIRCUIT BREAKER ────────────────────────────────────────────────────────

  get _circuitOpen() {
    if (this._cbFailures < CB_THRESHOLD) return false;
    if (Date.now() - this._cbOpenAt > CB_RESET_MS) {
      this._cbFailures = 0;
      this._log.info?.('[RUST-BRIDGE] Circuit breaker reset — retrying Rust');
      this.emit('circuit_closed');
      return false;
    }
    return true;
  }

  // ── CALL ───────────────────────────────────────────────────────────────────

  _call(fnName, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this._proc || this._proc.exitCode !== null) {
        return reject(new Error('RustBridge: process not running'));
      }

      const id  = String(this._nextId++);
      const req = JSON.stringify({ id: Number(id), fn_name: fnName, params });

      if (req.length > MAX_REQUEST_BYTES) {
        return reject(new RustBridgeError(
          `Request too large: ${req.length} bytes (limit ${MAX_REQUEST_BYTES})`,
          'validation'
        ));
      }

      const startUs = BigInt(Date.now()) * 1000n;
      const timer   = setTimeout(() => {
        this._pending.delete(id);
        metrics.timeouts++;
        this._cbFailures++;
        reject(new RustBridgeError(`Timeout after ${timeoutMs}ms for ${fnName}`, 'timeout'));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer, startUs });

      try {
        this._proc.stdin.write(req + '\n');
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`RustBridge: stdin write failed: ${err.message}`));
      }
    });
  }

  // ── HEALTH CHECK ───────────────────────────────────────────────────────────

  _startHealthCheck() {
    this._healthTimer = setInterval(async () => {
      if (!this._ready || this._circuitOpen) return;
      try {
        const h = await this._call('health', {}, 2000);
        if (h?.status !== 'ok') throw new Error('health check failed');
      } catch (err) {
        this._log.warn?.(`[RUST-BRIDGE] Health check failed: ${err.message}`);
        this._cbFailures++;
      }
    }, HEALTH_INTERVAL_MS);
    this._healthTimer.unref();
  }

  // ── STOP ───────────────────────────────────────────────────────────────────

  stop() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    if (this._proc) {
      this._proc.stdin.end();
      setTimeout(() => {
        if (this._proc && this._proc.exitCode === null) {
          this._proc.kill('SIGTERM');
        }
      }, 3000).unref();
    }
  }

  // ── PUBLIC API — EVERY INDICATOR ───────────────────────────────────────────
  // Each method: tries Rust first, falls back to JS Indicators on any error.

  async call(fnName, params) {
    if (!this._ready || this._circuitOpen) {
      return this._jsFallback(fnName, params);
    }
    try {
      const t0     = Date.now();
      const result = await this._call(fnName, params, this._timeoutMs);
      return result;
    } catch (err) {
      if (!(err instanceof RustBridgeError) || err.kind === 'validation') throw err;
      this._log.debug?.(`[RUST-BRIDGE] Fallback for ${fnName}: ${err.message}`);
      return this._jsFallback(fnName, params);
    }
  }

  // ── JS FALLBACK DISPATCHER ─────────────────────────────────────────────────
  // Maps bridge fn_name → Indicators.js call.
  // Every case returns the same shape as the Rust response.

  _jsFallback(fnName, params) {
    metrics.fallbackCalls++;
    const I = Indicators;
    const p = params;

    try {
      switch (fnName) {
        case 'sma':          return I.sma(p.data, p.n);
        case 'ema':          return I.ema(p.data, p.n);
        case 'wilder_sma':   return I.ma(p.data, p.n, 'WSMA');
        case 'ma':           return I.ma(p.data, p.n, p.type);
        case 'std_dev':      return I.std(p.data, p.n);
        case 'z_score':      return I.zScore(p.price, p.closes, p.n);
        case 'rsi':          return I.rsi(p.closes, p.n);
        case 'stoch_rsi':    return I.stochRsi(p.closes, p.rsi_period, 14, p.smooth_k, p.smooth_d);
        case 'macd':         return I.macd(p.closes, p.fast, p.slow, p.signal);
        case 'atr':          return I.atr(p.candles, p.n);
        case 'bollinger':    return I.bollingerBands(p.closes, p.n, p.k);
        case 'vwap':         return I.vwap(p.candles);
        case 'momentum':     return I.momentum(p.closes, p.n);
        case 'crossover':    return I.maCrossover(p.closes, p.fast, p.slow, p.type);
        case 'divergence':   return I.rsiDivergence(p.closes, p.rsi_values, p.lookback);
        case 'adx':          return I.adx(p.candles, p.n);
        case 'fibonacci':    return I.fibonacci(p.high, p.low);
        case 'pivot':        return I.pivotPoints(p.high, p.low, p.close);
        case 'donchian':     return I.donchianChannel(p.candles, p.n);
        case 'to_returns':   return I.toReturns(p.prices);
        case 'normalize':    return I.normalize(p.data);
        case 'correlation':  return I.correlation(p.a, p.b);
        case 'dtw':          return I.dtwDistance(p.a, p.b);
        case 'sharpe':       return I.sharpeRatio(p.returns, p.risk_free, p.periods_per_year);
        case 'max_drawdown': return I.maxDrawdown(p.equity);
        case 'kelly':        return I.kellyCriterion(p.win_rate, p.avg_win, p.avg_loss);
        case 'net_profit_pct': return I.netProfitPct ? I.netProfitPct(p.buy_ask, p.sell_bid, p.fee_buy_pct, p.fee_sell_pct) : null;
        case 'atr_stops': {
          const entry   = p.entry;
          const atr     = p.atr;
          const mult    = p.multiplier;
          const rr      = p.rr_ratio;
          const isLong  = p.is_long;
          const sl      = isLong ? entry - atr * mult : entry + atr * mult;
          const tp      = isLong ? entry + (entry - sl) * rr : entry - (sl - entry) * rr;
          return { stop_loss: sl, take_profit: tp };
        }
        case 'grid_profit': {
          const gross   = (p.sell_price - p.buy_price) * p.qty;
          const buyFee  = p.buy_price  * p.qty * p.maker_fee_pct / 100;
          const sellFee = p.sell_price * p.qty * p.maker_fee_pct / 100;
          return gross - buyFee - sellFee;
        }
        case 'funding_payment':
          return p.notional_usdt * p.funding_rate_pct / 100;
        case 'dca_multiplier': {
          const smaVal = I.sma(p.closes, p.sma_period);
          if (!smaVal) return { multiplier: 1.0, sma: null, drop_pct: 0, tier_matched: null };
          const dropPct = ((smaVal - p.price) / smaVal) * 100;
          if (dropPct <= 0) return { multiplier: 1.0, sma: smaVal, drop_pct: dropPct, tier_matched: null };
          const sorted = [...p.dips].sort((a, b) => b.drop_percent - a.drop_percent);
          const match  = sorted.find(d => dropPct >= d.drop_percent);
          const mult   = match ? Math.min(match.multiplier, p.max_multiplier) : 1.0;
          return { multiplier: mult, sma: smaVal, drop_pct: dropPct, tier_matched: match ? `${match.drop_percent}%->${mult}x` : null };
        }
        case 'health':
          return { status: 'ok (js-fallback)', version: 'js' };
        default:
          throw new Error(`No JS fallback for function: ${fnName}`);
      }
    } catch (err) {
      throw new Error(`JS fallback failed for ${fnName}: ${err.message}`);
    }
  }

  // ── METRICS ────────────────────────────────────────────────────────────────

  getMetrics() {
    const total = metrics.rustCalls + metrics.fallbackCalls;
    return {
      ...metrics,
      avgLatencyUs:   metrics.rustCalls > 0 ? metrics.totalLatencyUs / metrics.rustCalls : 0,
      fallbackRate:   total > 0 ? (metrics.fallbackCalls / total * 100).toFixed(2) + '%' : '0%',
      uptimeMs:       Date.now() - metrics.startedAt,
      circuitOpen:    this._circuitOpen,
      processRunning: this._proc?.exitCode === null,
    };
  }

  async getStats() {
    if (!this._ready || this._circuitOpen) return this.getMetrics();
    try {
      const rustStats = await this._call('stats', {}, 2000);
      return { ...this.getMetrics(), rust: rustStats };
    } catch (_) {
      return this.getMetrics();
    }
  }
}

// ── ERROR CLASS ───────────────────────────────────────────────────────────────

class RustBridgeError extends Error {
  constructor(message, kind = 'unknown') {
    super(message);
    this.name = 'RustBridgeError';
    this.kind = kind;
  }
}

// ── SINGLETON ─────────────────────────────────────────────────────────────────
// One bridge instance per process. Strategies import this and call bridge.call().

let _instance = null;

/**
 * Get or create the singleton bridge instance.
 * Starts the Rust binary on first call.
 * Falls back to JS-only mode if binary is not found (no error thrown).
 */
async function getBridge(opts = {}) {
  if (_instance) return _instance;

  _instance = new RustBridge(opts);

  // Attempt to start — if binary missing, log a warning and operate in JS-only mode
  try {
    await _instance.start();
  } catch (err) {
    console.warn(`[RUST-BRIDGE] Could not start Rust binary: ${err.message}`);
    console.warn('[RUST-BRIDGE] Operating in JS-only mode. Build with: cd rust/crypto-indicators && cargo build --release');
    // Mark as "ready" with circuit fully open so all calls go through JS fallback
    _instance._ready       = false;
    _instance._cbFailures  = CB_THRESHOLD;
    _instance._cbOpenAt    = Date.now() + 365 * 24 * 3600 * 1000; // 1 year from now
  }

  return _instance;
}

/**
 * Convenience wrapper — call a Rust/JS indicator by name.
 * Automatically handles Rust → JS fallback.
 */
async function callIndicator(fnName, params, opts = {}) {
  const bridge = await getBridge(opts);
  return bridge.call(fnName, params);
}

// ── UTILITY ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── EXPORTS ───────────────────────────────────────────────────────────────────

module.exports = {
  RustBridge,
  RustBridgeError,
  getBridge,
  callIndicator,
  getMetrics: () => metrics,
};
