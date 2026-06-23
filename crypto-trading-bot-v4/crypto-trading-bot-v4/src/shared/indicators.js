'use strict';
/**
 * src/shared/indicators.js
 * Pure math/indicator functions. No side effects, no I/O, no imports.
 * Every function validates its inputs and returns null on insufficient data.
 * All numeric outputs are finite — NaN/Infinity are coerced to null.
 */

// ── Internal guard ────────────────────────────────────────────────────────────
function _fin(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}

function _requireArray(arr, minLen, label) {
  if (!Array.isArray(arr))        throw new TypeError(`${label}: expected array, got ${typeof arr}`);
  if (arr.length < minLen)        return false;
  if (arr.some(v => typeof v !== 'number' || !isFinite(v)))
    throw new TypeError(`${label}: array contains non-finite values`);
  return true;
}

// ── CANDLE VALIDATOR ──────────────────────────────────────────────────────────
function _validateCandle(c, i) {
  if (!c || typeof c !== 'object') throw new TypeError(`candle[${i}] is not an object`);
  for (const k of ['open','high','low','close']) {
    if (typeof c[k] !== 'number' || !isFinite(c[k]) || c[k] < 0)
      throw new TypeError(`candle[${i}].${k} is invalid: ${c[k]}`);
  }
  if (c.high < c.low)   throw new RangeError(`candle[${i}]: high(${c.high}) < low(${c.low})`);
  if (c.high < c.close) throw new RangeError(`candle[${i}]: high(${c.high}) < close(${c.close})`);
  if (c.low  > c.close) throw new RangeError(`candle[${i}]: low(${c.low}) > close(${c.close})`);
}

// ── INDICATORS ────────────────────────────────────────────────────────────────
const Indicators = {

  // ── Simple Moving Average ─────────────────────────────────────────────────
  sma(arr, n) {
    if (n < 1) throw new RangeError(`sma: period must be >= 1, got ${n}`);
    if (!_requireArray(arr, n, 'sma')) return null;
    return _fin(arr.slice(-n).reduce((a, b) => a + b, 0) / n);
  },

  // ── Exponential Moving Average (Wilder's method seed from SMA) ───────────
  ema(arr, n) {
    if (n < 1) throw new RangeError(`ema: period must be >= 1, got ${n}`);
    if (!_requireArray(arr, n, 'ema')) return null;
    const k = 2 / (n + 1);
    let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return _fin(e);
  },

  // ── Wilder's Smoothed Moving Average (used by ATR, RSI) ──────────────────
  wilderSma(arr, n) {
    if (n < 1) throw new RangeError(`wilderSma: period must be >= 1, got ${n}`);
    if (!_requireArray(arr, n, 'wilderSma')) return null;
    let sma = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < arr.length; i++) sma = (sma * (n - 1) + arr[i]) / n;
    return _fin(sma);
  },

  // ── MA dispatcher ─────────────────────────────────────────────────────────
  ma(arr, n, type = 'EMA') {
    const t = String(type).toUpperCase();
    if (!['SMA','EMA','WSMA'].includes(t)) throw new TypeError(`ma: unknown type "${type}"`);
    if (t === 'SMA')  return this.sma(arr, n);
    if (t === 'WSMA') return this.wilderSma(arr, n);
    return this.ema(arr, n);
  },

  // ── Population standard deviation ─────────────────────────────────────────
  std(arr, n) {
    if (n < 2) throw new RangeError(`std: period must be >= 2, got ${n}`);
    if (!_requireArray(arr, n, 'std')) return null;
    const s = arr.slice(-n);
    const m = s.reduce((a, b) => a + b, 0) / n;
    return _fin(Math.sqrt(s.reduce((a, b) => a + Math.pow(b - m, 2), 0) / n));
  },

  // ── Sample standard deviation ─────────────────────────────────────────────
  stdSample(arr, n) {
    if (n < 2) throw new RangeError(`stdSample: period must be >= 2, got ${n}`);
    if (!_requireArray(arr, n, 'stdSample')) return null;
    const s = arr.slice(-n);
    const m = s.reduce((a, b) => a + b, 0) / n;
    return _fin(Math.sqrt(s.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (n - 1)));
  },

  // ── Z-Score: how many std devs is price from rolling mean ────────────────
  zScore(price, closes, n) {
    if (typeof price !== 'number' || !isFinite(price)) throw new TypeError('zScore: price must be finite number');
    if (n < 2) throw new RangeError(`zScore: period must be >= 2, got ${n}`);
    if (!_requireArray(closes, n + 1, 'zScore')) return null;
    const window = closes.slice(-n - 1, -1);
    const mean   = window.reduce((a, b) => a + b, 0) / n;
    const sigma  = Math.sqrt(window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n);
    if (sigma === 0) return 0;
    return _fin((price - mean) / sigma);
  },

  // ── RSI — Wilder's smoothed method ────────────────────────────────────────
  rsi(closes, n = 14) {
    if (n < 1) throw new RangeError(`rsi: period must be >= 1, got ${n}`);
    if (!_requireArray(closes, n + 1, 'rsi')) return null;

    const changes = [];
    for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);

    const gains  = changes.map(d => d > 0 ? d : 0);
    const losses = changes.map(d => d < 0 ? Math.abs(d) : 0);

    // Initial averages
    let avgGain = gains.slice(0, n).reduce((a, b) => a + b, 0) / n;
    let avgLoss = losses.slice(0, n).reduce((a, b) => a + b, 0) / n;

    // Wilder's smoothing for remaining periods
    for (let i = n; i < changes.length; i++) {
      avgGain = (avgGain * (n - 1) + gains[i])  / n;
      avgLoss = (avgLoss * (n - 1) + losses[i]) / n;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return _fin(100 - 100 / (1 + rs));
  },

  // ── Stochastic RSI ────────────────────────────────────────────────────────
  stochRsi(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
    if (!_requireArray(closes, rsiPeriod + stochPeriod + smoothK + smoothD, 'stochRsi')) return null;

    // Build RSI history
    const rsiValues = [];
    for (let i = rsiPeriod; i <= closes.length; i++) {
      const r = this.rsi(closes.slice(0, i), rsiPeriod);
      if (r !== null) rsiValues.push(r);
    }

    if (rsiValues.length < stochPeriod) return null;

    // Raw stoch K
    const rawK = [];
    for (let i = stochPeriod; i <= rsiValues.length; i++) {
      const window = rsiValues.slice(i - stochPeriod, i);
      const lo = Math.min(...window), hi = Math.max(...window);
      rawK.push(hi === lo ? 50 : ((rsiValues[i - 1] - lo) / (hi - lo)) * 100);
    }

    const k = this.sma(rawK, smoothK);
    if (k === null || rawK.length < smoothK) return null;

    const kArr = [];
    for (let i = smoothK; i <= rawK.length; i++) {
      const v = this.sma(rawK.slice(0, i), smoothK);
      if (v !== null) kArr.push(v);
    }

    const d = this.sma(kArr, smoothD);
    return (k !== null && d !== null) ? { k: _fin(k), d: _fin(d) } : null;
  },

  // ── MACD — properly seeded EMA history ───────────────────────────────────
  macd(closes, fast = 12, slow = 26, signal = 9) {
    if (fast >= slow)  throw new RangeError(`macd: fast(${fast}) must be < slow(${slow})`);
    if (signal < 1)    throw new RangeError(`macd: signal period must be >= 1`);
    if (!_requireArray(closes, slow + signal, 'macd')) return null;

    // Build complete MACD line history
    const macdLine = [];
    for (let i = slow; i <= closes.length; i++) {
      const f = this.ema(closes.slice(0, i), fast);
      const s = this.ema(closes.slice(0, i), slow);
      if (f !== null && s !== null) macdLine.push(f - s);
    }

    if (macdLine.length < signal) return null;

    const signalLine = this.ema(macdLine, signal);
    const current    = macdLine[macdLine.length - 1];
    if (signalLine === null) return null;

    return {
      macdLine:   _fin(current),
      signalLine: _fin(signalLine),
      histogram:  _fin(current - signalLine),
      // Previous histogram for crossover detection
      prevHistogram: macdLine.length > signal
        ? _fin(macdLine[macdLine.length - 2] - (this.ema(macdLine.slice(0, -1), signal) || signalLine))
        : null,
    };
  },

  // ── ATR — Wilder's smoothed True Range ────────────────────────────────────
  atr(candles, n = 14) {
    if (n < 1) throw new RangeError(`atr: period must be >= 1, got ${n}`);
    if (!Array.isArray(candles) || candles.length < n + 1) return null;
    candles.slice(-(n + 2)).forEach((c, i) => _validateCandle(c, i));

    const s   = candles.slice(-(n + 1));
    const trs = [];
    for (let i = 1; i < s.length; i++) {
      trs.push(Math.max(
        s[i].high - s[i].low,
        Math.abs(s[i].high - s[i - 1].close),
        Math.abs(s[i].low  - s[i - 1].close)
      ));
    }
    // Use Wilder's smoothing for ATR
    let atr = trs.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < trs.length; i++) atr = (atr * (n - 1) + trs[i]) / n;
    return _fin(atr);
  },

  // ── Bollinger Bands ───────────────────────────────────────────────────────
  bollingerBands(closes, n = 20, k = 2) {
    if (n < 2) throw new RangeError(`bollingerBands: period must be >= 2, got ${n}`);
    if (k <= 0) throw new RangeError(`bollingerBands: multiplier must be > 0, got ${k}`);
    if (!_requireArray(closes, n, 'bollingerBands')) return null;

    const mid   = this.sma(closes, n);
    const sigma = this.std(closes, n);
    if (mid === null || sigma === null) return null;

    const upper = mid + k * sigma;
    const lower = mid - k * sigma;
    const price = closes[closes.length - 1];
    const width = upper - lower;
    const bbPct = width > 0 ? (price - lower) / width : 0.5;

    return {
      upper:    _fin(upper),
      mid:      _fin(mid),
      lower:    _fin(lower),
      sigma:    _fin(sigma),
      bbPct:    _fin(Math.max(0, Math.min(1, bbPct))),  // clamp 0-1
      width:    _fin(width),
      widthPct: _fin(mid > 0 ? width / mid * 100 : null), // %B width for squeeze detection
    };
  },

  // ── VWAP — volume-weighted average price ──────────────────────────────────
  vwap(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return null;
    let tpv = 0, vol = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (typeof c.volume !== 'number' || c.volume < 0) continue;
      const tp = (c.high + c.low + c.close) / 3;
      if (!isFinite(tp)) continue;
      tpv += tp * c.volume;
      vol += c.volume;
    }
    return vol > 0 ? _fin(tpv / vol) : null;
  },

  // ── Rate of Change / Momentum ─────────────────────────────────────────────
  momentum(closes, n) {
    if (n < 1) throw new RangeError(`momentum: period must be >= 1, got ${n}`);
    if (!_requireArray(closes, n + 1, 'momentum')) return null;
    const now  = closes[closes.length - 1];
    const past = closes[closes.length - 1 - n];
    if (past === 0) return null;
    return _fin(((now - past) / past) * 100);
  },

  // ── MA Crossover ──────────────────────────────────────────────────────────
  maCrossover(closes, fast, slow, type = 'EMA') {
    if (fast >= slow) throw new RangeError(`maCrossover: fast(${fast}) must be < slow(${slow})`);
    if (!_requireArray(closes, slow + 2, 'maCrossover')) return null;

    const cf = this.ma(closes,            fast, type);
    const cs = this.ma(closes,            slow, type);
    const pf = this.ma(closes.slice(0,-1), fast, type);
    const ps = this.ma(closes.slice(0,-1), slow, type);

    if (cf===null||cs===null||pf===null||ps===null) return null;

    if (pf <= ps && cf > cs) return 'golden';   // bullish crossover
    if (pf >= ps && cf < cs) return 'death';    // bearish crossover
    return null;
  },

  // ── RSI Divergence ────────────────────────────────────────────────────────
  // Bullish: price makes lower low, RSI makes higher low (hidden strength)
  // Bearish: price makes higher high, RSI makes lower high (hidden weakness)
  rsiDivergence(closes, rsiValues, lookback = 5) {
    if (lookback < 2) throw new RangeError(`rsiDivergence: lookback must be >= 2`);
    if (!_requireArray(closes,    lookback + 1, 'rsiDivergence:closes'))    return null;
    if (!_requireArray(rsiValues, lookback + 1, 'rsiDivergence:rsiValues')) return null;

    const priceSlice = closes.slice(-(lookback + 1));
    const rsiSlice   = rsiValues.slice(-(lookback + 1));
    const pNow       = priceSlice[priceSlice.length - 1];
    const rNow       = rsiSlice[rsiSlice.length - 1];
    const pPrev      = priceSlice.slice(0, -1);
    const rPrev      = rsiSlice.slice(0, -1);
    const pMin       = Math.min(...pPrev);
    const pMax       = Math.max(...pPrev);
    const rMin       = Math.min(...rPrev);
    const rMax       = Math.max(...rPrev);

    // Bullish divergence: price lower low, RSI higher low
    if (pNow < pMin && rNow > rMin) return 'bullish';
    // Bearish divergence: price higher high, RSI lower high
    if (pNow > pMax && rNow < rMax) return 'bearish';
    return null;
  },

  // ── Ichimoku Cloud (Tenkan/Kijun/Senkou A & B) ───────────────────────────
  ichimoku(candles, tenkan = 9, kijun = 26, senkou = 52) {
    if (!Array.isArray(candles) || candles.length < senkou) return null;

    const hlAvg = (start, end) => {
      const sl = candles.slice(start, end);
      return (Math.max(...sl.map(c => c.high)) + Math.min(...sl.map(c => c.low))) / 2;
    };

    const n          = candles.length;
    const tenkanSen  = hlAvg(n - tenkan, n);
    const kijunSen   = hlAvg(n - kijun,  n);
    const senkouA    = (tenkanSen + kijunSen) / 2;
    const senkouB    = hlAvg(n - senkou, n);
    const chikouSpan = candles[n - 1].close;

    return {
      tenkanSen:  _fin(tenkanSen),
      kijunSen:   _fin(kijunSen),
      senkouA:    _fin(senkouA),
      senkouB:    _fin(senkouB),
      chikouSpan: _fin(chikouSpan),
      aboveCloud: candles[n-1].close > Math.max(senkouA, senkouB),
      belowCloud: candles[n-1].close < Math.min(senkouA, senkouB),
    };
  },

  // ── Average Directional Index (trend strength) ────────────────────────────
  adx(candles, n = 14) {
    if (!Array.isArray(candles) || candles.length < n * 2) return null;
    candles.forEach((c, i) => _validateCandle(c, i));

    const plusDM  = [];
    const minusDM = [];
    const trArr   = [];

    for (let i = 1; i < candles.length; i++) {
      const upMove   = candles[i].high  - candles[i-1].high;
      const downMove = candles[i-1].low - candles[i].low;
      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
      trArr.push(Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i-1].close),
        Math.abs(candles[i].low  - candles[i-1].close)
      ));
    }

    const smoothedTR    = this.wilderSma(trArr, n);
    const smoothedPlusDM  = this.wilderSma(plusDM, n);
    const smoothedMinusDM = this.wilderSma(minusDM, n);

    if (!smoothedTR || smoothedTR === 0) return null;

    const plusDI  = (smoothedPlusDM  / smoothedTR) * 100;
    const minusDI = (smoothedMinusDM / smoothedTR) * 100;
    const dx      = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;

    return {
      adx:     _fin(dx),     // > 25 = trending, < 20 = ranging
      plusDI:  _fin(plusDI),
      minusDI: _fin(minusDI),
      trending: dx > 25,
      ranging:  dx < 20,
    };
  },

  // ── Fibonacci Retracement Levels ─────────────────────────────────────────
  fibonacci(high, low) {
    if (typeof high !== 'number' || typeof low !== 'number') throw new TypeError('fibonacci: high and low must be numbers');
    if (high <= low) throw new RangeError(`fibonacci: high(${high}) must be > low(${low})`);
    const diff = high - low;
    return {
      level0:    _fin(high),
      level236:  _fin(high - diff * 0.236),
      level382:  _fin(high - diff * 0.382),
      level500:  _fin(high - diff * 0.500),
      level618:  _fin(high - diff * 0.618),
      level786:  _fin(high - diff * 0.786),
      level1000: _fin(low),
      // Extension levels
      ext1272:   _fin(low  - diff * 0.272),
      ext1618:   _fin(low  - diff * 0.618),
    };
  },

  // ── Pivot Points (daily/weekly/monthly support & resistance) ─────────────
  pivotPoints(high, low, close) {
    if ([high, low, close].some(v => typeof v !== 'number' || !isFinite(v) || v < 0))
      throw new TypeError('pivotPoints: high, low, close must be positive finite numbers');
    const pp = (high + low + close) / 3;
    return {
      pp:  _fin(pp),
      r1:  _fin(2 * pp - low),
      r2:  _fin(pp + (high - low)),
      r3:  _fin(high + 2 * (pp - low)),
      s1:  _fin(2 * pp - high),
      s2:  _fin(pp - (high - low)),
      s3:  _fin(low - 2 * (high - pp)),
    };
  },

  // ── Volume Profile — price levels with most traded volume ─────────────────
  volumeProfile(candles, bins = 20) {
    if (!Array.isArray(candles) || candles.length === 0) return null;
    const lo  = Math.min(...candles.map(c => c.low));
    const hi  = Math.max(...candles.map(c => c.high));
    if (hi === lo) return null;
    const step    = (hi - lo) / bins;
    const profile = Array.from({ length: bins }, (_, i) => ({
      priceFrom: lo + step * i,
      priceTo:   lo + step * (i + 1),
      volume:    0,
    }));
    for (const c of candles) {
      const bin = Math.min(Math.floor((c.close - lo) / step), bins - 1);
      if (bin >= 0) profile[bin].volume += c.volume || 0;
    }
    const poc = profile.reduce((best, b) => b.volume > best.volume ? b : best, profile[0]);
    return { profile, poc, lo: _fin(lo), hi: _fin(hi) };
  },

  // ── Highest high / Lowest low over N candles ──────────────────────────────
  donchianChannel(candles, n) {
    if (n < 1) throw new RangeError(`donchianChannel: period must be >= 1`);
    if (!Array.isArray(candles) || candles.length < n) return null;
    const s   = candles.slice(-n);
    const hi  = Math.max(...s.map(c => c.high));
    const lo  = Math.min(...s.map(c => c.low));
    const mid = (hi + lo) / 2;
    return { upper: _fin(hi), lower: _fin(lo), mid: _fin(mid) };
  },

  // ── Returns from index 0 as % change array ────────────────────────────────
  toReturns(prices) {
    if (!_requireArray(prices, 2, 'toReturns')) return [];
    if (prices[0] === 0) throw new RangeError('toReturns: first price cannot be 0');
    return prices.map((p, i) => i === 0 ? 0 : _fin((p - prices[0]) / prices[0] * 100) || 0);
  },

  // ── Normalise array to [0, 1] range ───────────────────────────────────────
  normalize(arr) {
    if (!_requireArray(arr, 1, 'normalize')) return [];
    const min = Math.min(...arr), max = Math.max(...arr);
    if (max === min) return arr.map(() => 0.5);
    return arr.map(v => _fin((v - min) / (max - min)) ?? 0.5);
  },

  // ── Pearson Correlation ───────────────────────────────────────────────────
  correlation(a, b) {
    const n = Math.min(a.length, b.length);
    if (!_requireArray(a.slice(0,n), 2, 'correlation:a')) return 0;
    if (!_requireArray(b.slice(0,n), 2, 'correlation:b')) return 0;
    const ma = a.slice(0,n).reduce((x,y)=>x+y,0)/n;
    const mb = b.slice(0,n).reduce((x,y)=>x+y,0)/n;
    let num=0, da=0, db=0;
    for (let i=0;i<n;i++) {
      num += (a[i]-ma)*(b[i]-mb);
      da  += Math.pow(a[i]-ma,2);
      db  += Math.pow(b[i]-mb,2);
    }
    return (da===0||db===0) ? 0 : _fin(num/Math.sqrt(da*db)) ?? 0;
  },

  // ── DTW Distance (path similarity between two series) ────────────────────
  dtwDistance(a, b) {
    if (!_requireArray(a, 1, 'dtwDistance:a')) return Infinity;
    if (!_requireArray(b, 1, 'dtwDistance:b')) return Infinity;
    const n = a.length, m = b.length;
    const dtw = Array.from({length:n+1},()=>new Array(m+1).fill(Infinity));
    dtw[0][0] = 0;
    for (let i=1;i<=n;i++)
      for (let j=1;j<=m;j++) {
        const cost = Math.abs(a[i-1]-b[j-1]);
        dtw[i][j] = cost + Math.min(dtw[i-1][j], dtw[i][j-1], dtw[i-1][j-1]);
      }
    return dtw[n][m];
  },

  // ── Sharpe Ratio (annualised, assumes daily returns) ─────────────────────
  sharpeRatio(returns, riskFreeRate = 0, periodsPerYear = 365) {
    if (!_requireArray(returns, 2, 'sharpeRatio')) return null;
    const mean  = returns.reduce((a,b)=>a+b,0)/returns.length;
    const sigma = Math.sqrt(returns.reduce((a,b)=>a+Math.pow(b-mean,2),0)/(returns.length-1));
    if (sigma === 0) return null;
    return _fin(((mean - riskFreeRate) / sigma) * Math.sqrt(periodsPerYear));
  },

  // ── Maximum Drawdown from equity curve ────────────────────────────────────
  maxDrawdown(equity) {
    if (!_requireArray(equity, 2, 'maxDrawdown')) return null;
    let peak = equity[0], maxDD = 0;
    for (const v of equity) {
      if (v > peak) peak = v;
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    return _fin(maxDD * 100); // return as %
  },

  // ── Kelly Criterion — optimal position sizing ─────────────────────────────
  kellyCriterion(winRate, avgWin, avgLoss) {
    if (winRate < 0 || winRate > 1) throw new RangeError('kellyCriterion: winRate must be 0-1');
    if (avgWin <= 0)  throw new RangeError('kellyCriterion: avgWin must be > 0');
    if (avgLoss <= 0) throw new RangeError('kellyCriterion: avgLoss must be > 0');
    const b = avgWin / avgLoss;
    const q = 1 - winRate;
    const kelly = (b * winRate - q) / b;
    // Half-kelly for safety — cap at 25% of capital
    return _fin(Math.max(0, Math.min(0.25, kelly / 2)));
  },
};

module.exports = Indicators;
