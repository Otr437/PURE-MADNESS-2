/**
 * Market Data — TypeScript
 * Live stock and crypto market data, registered as tools into react_loop's toolRegistry.
 *
 * Stock data: Alpha Vantage (free tier, requires API key)
 * Crypto data: CoinGecko (no API key required for basic public endpoints)
 *
 * export ALPHA_VANTAGE_API_KEY=...
 * export MARKET_DATA_CACHE_TTL=60   (seconds, default 60)
 */

import { registerTool } from "./react_loop";

const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";
const COINGECKO_BASE     = "https://api.coingecko.com/api/v3";
const CACHE_TTL_MS       = parseInt(process.env.MARKET_DATA_CACHE_TTL ?? "60", 10) * 1000;
const FETCH_TIMEOUT_MS   = 20_000;

export class MarketDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketDataError";
  }
}

// ── Simple in-memory TTL cache (avoids hammering external APIs) ────────────────
interface CacheEntry<T> { value: T; expiresAt: number; }
class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();
  constructor(private ttlMs: number) {}

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return null; }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
const cache = new TTLCache(CACHE_TTL_MS);

// ── Retryable fetch with exponential backoff (circuit-breaker pattern) ────────
async function fetchWithRetry(url: string, maxAttempts = 3): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "rag-ai-monorepo/2.0" } });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timeout);
      lastErr = e;
      if (attempt < maxAttempts) {
        const delayMs = Math.min(2 ** attempt * 1000, 30_000);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

function validateSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (!s || !/^[A-Z0-9.\-]+$/.test(s)) throw new MarketDataError(`Invalid ticker symbol: '${symbol}'`);
  return s;
}

function validateCoinId(coinId: string): string {
  const s = coinId.trim().toLowerCase();
  if (!s || !/^[a-z0-9\-]+$/.test(s)) throw new MarketDataError(`Invalid coin id: '${coinId}'`);
  return s;
}

// ── Stock data (Alpha Vantage) ──────────────────────────────────────────────────
export interface StockQuote {
  symbol: string; price: number; change: number; changePct: string;
  volume: number; latestTradingDay: string; previousClose: number;
}

export async function getStockQuote(symbolRaw: string): Promise<StockQuote> {
  const symbol = validateSymbol(symbolRaw);
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) throw new MarketDataError("ALPHA_VANTAGE_API_KEY environment variable is not set");

  const cacheKey = `quote:${symbol}`;
  const cached = cache.get<StockQuote>(cacheKey);
  if (cached) return cached;

  const url = `${ALPHA_VANTAGE_BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  let data: any;
  try {
    data = await fetchWithRetry(url);
  } catch (e) {
    throw new MarketDataError(`Failed to fetch quote for ${symbol}: ${e instanceof Error ? e.message : e}`);
  }

  const quote = data["Global Quote"];
  if (!quote || Object.keys(quote).length === 0) {
    const note = data.Note ?? data.Information ?? "No data returned";
    throw new MarketDataError(`No quote data for '${symbol}': ${note}`);
  }

  const result: StockQuote = {
    symbol:           quote["01. symbol"] ?? symbol,
    price:            parseFloat(quote["05. price"] ?? "0"),
    change:           parseFloat(quote["09. change"] ?? "0"),
    changePct:        (quote["10. change percent"] ?? "0%").replace("%", ""),
    volume:           parseInt(quote["06. volume"] ?? "0", 10),
    latestTradingDay: quote["07. latest trading day"] ?? "",
    previousClose:    parseFloat(quote["08. previous close"] ?? "0"),
  };
  cache.set(cacheKey, result);
  return result;
}

export interface OHLCVBar { date: string; open: number; high: number; low: number; close: number; volume: number; }

export async function getStockOHLCV(
  symbolRaw: string,
  interval: "daily" | "weekly" | "monthly" = "daily",
  outputSize: "compact" | "full" = "compact",
): Promise<OHLCVBar[]> {
  const symbol = validateSymbol(symbolRaw);
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) throw new MarketDataError("ALPHA_VANTAGE_API_KEY environment variable is not set");

  const funcMap = { daily: "TIME_SERIES_DAILY", weekly: "TIME_SERIES_WEEKLY", monthly: "TIME_SERIES_MONTHLY" };
  const cacheKey = `ohlcv:${symbol}:${interval}:${outputSize}`;
  const cached = cache.get<OHLCVBar[]>(cacheKey);
  if (cached) return cached;

  const url = `${ALPHA_VANTAGE_BASE}?function=${funcMap[interval]}&symbol=${encodeURIComponent(symbol)}&outputsize=${outputSize}&apikey=${encodeURIComponent(apiKey)}`;
  let data: any;
  try {
    data = await fetchWithRetry(url);
  } catch (e) {
    throw new MarketDataError(`Failed to fetch OHLCV for ${symbol}: ${e instanceof Error ? e.message : e}`);
  }

  const tsKey = Object.keys(data).find((k) => k.includes("Time Series"));
  if (!tsKey) {
    const note = data.Note ?? data.Information ?? "No time series returned";
    throw new MarketDataError(`No OHLCV data for '${symbol}': ${note}`);
  }

  const series = data[tsKey];
  const bars: OHLCVBar[] = Object.entries(series)
    .map(([date, bar]: [string, any]) => ({
      date,
      open:   parseFloat(bar["1. open"]),
      high:   parseFloat(bar["2. high"]),
      low:    parseFloat(bar["3. low"]),
      close:  parseFloat(bar["4. close"]),
      volume: parseInt(bar["5. volume"], 10),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  cache.set(cacheKey, bars);
  return bars;
}

// ── Crypto data (CoinGecko) ─────────────────────────────────────────────────────
export interface CryptoQuote {
  coinId: string; vsCurrency: string; price: number;
  change24hPct: number; marketCap: number; volume24h: number;
}

export async function getCryptoQuote(coinIdRaw: string, vsCurrencyRaw = "usd"): Promise<CryptoQuote> {
  const coinId     = validateCoinId(coinIdRaw);
  const vsCurrency = vsCurrencyRaw.trim().toLowerCase();

  const cacheKey = `crypto_quote:${coinId}:${vsCurrency}`;
  const cached = cache.get<CryptoQuote>(cacheKey);
  if (cached) return cached;

  const url = `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=${encodeURIComponent(vsCurrency)}&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`;
  let data: any;
  try {
    data = await fetchWithRetry(url);
  } catch (e) {
    throw new MarketDataError(`Failed to fetch crypto quote for ${coinId}: ${e instanceof Error ? e.message : e}`);
  }

  const coinData = data[coinId];
  if (!coinData) throw new MarketDataError(`No data for coin '${coinId}' — check the CoinGecko coin ID is correct`);

  const result: CryptoQuote = {
    coinId, vsCurrency,
    price:        coinData[vsCurrency] ?? 0,
    change24hPct: coinData[`${vsCurrency}_24h_change`] ?? 0,
    marketCap:    coinData[`${vsCurrency}_market_cap`] ?? 0,
    volume24h:    coinData[`${vsCurrency}_24h_vol`] ?? 0,
  };
  cache.set(cacheKey, result);
  return result;
}

export interface CryptoOHLCBar { timestamp: number; open: number; high: number; low: number; close: number; }

export async function getCryptoOHLCV(coinIdRaw: string, vsCurrencyRaw = "usd", days = 30): Promise<CryptoOHLCBar[]> {
  const coinId     = validateCoinId(coinIdRaw);
  const vsCurrency = vsCurrencyRaw.trim().toLowerCase();
  if (days < 1 || days > 365) throw new MarketDataError("days must be between 1 and 365");

  const cacheKey = `crypto_ohlcv:${coinId}:${vsCurrency}:${days}`;
  const cached = cache.get<CryptoOHLCBar[]>(cacheKey);
  if (cached) return cached;

  const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(coinId)}/ohlc?vs_currency=${encodeURIComponent(vsCurrency)}&days=${days}`;
  let data: any;
  try {
    data = await fetchWithRetry(url);
  } catch (e) {
    throw new MarketDataError(`Failed to fetch crypto OHLCV for ${coinId}: ${e instanceof Error ? e.message : e}`);
  }

  if (!Array.isArray(data) || data.length === 0) throw new MarketDataError(`No OHLCV data for '${coinId}'`);

  const bars: CryptoOHLCBar[] = data.map((row: number[]) => ({
    timestamp: row[0], open: row[1], high: row[2], low: row[3], close: row[4],
  }));
  cache.set(cacheKey, bars);
  return bars;
}

// ── Technical indicators (computed locally — no external API needed) ───────────
export function computeSMA(closes: number[], period: number): (number | null)[] {
  if (period < 1) throw new MarketDataError("period must be >= 1");
  return closes.map((_, i) => {
    if (i + 1 < period) return null;
    const window = closes.slice(i + 1 - period, i + 1);
    return window.reduce((a, b) => a + b, 0) / period;
  });
}

export function computeRSI(closes: number[], period = 14): (number | null)[] {
  if (period < 1) throw new MarketDataError("period must be >= 1");
  if (closes.length < period + 1) return closes.map(() => null);

  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  const gains  = deltas.map((d) => Math.max(d, 0));
  const losses = deltas.map((d) => Math.max(-d, 0));

  const out: (number | null)[] = new Array(period).fill(null);
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rsiFromAvgs = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out.push(rsiFromAvgs(avgGain, avgLoss));

  for (let i = period; i < deltas.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    out.push(rsiFromAvgs(avgGain, avgLoss));
  }
  return out;
}

export function computeATR(bars: { high: number; low: number; close: number }[], period = 14): (number | null)[] {
  if (period < 1) throw new MarketDataError("period must be >= 1");
  if (bars.length < 2) return bars.map(() => null);

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i];
    const prevClose = bars[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  if (trueRanges.length < period) return bars.map(() => null);

  const out: (number | null)[] = new Array(period).fill(null);
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(atr);
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    out.push(atr);
  }
  return out;
}

// ── Tool registration ───────────────────────────────────────────────────────────
export function registerMarketDataTools(): void {
  registerTool(
    { name: "get_stock_quote", description: "Get the latest price quote for a stock ticker symbol.",
      input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
    async ({ symbol }) => {
      try {
        const q = await getStockQuote(symbol as string);
        return `${q.symbol}: $${q.price.toFixed(2)} (${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)}, ${q.changePct}%) vol=${q.volume.toLocaleString()} as of ${q.latestTradingDay}`;
      } catch (e) { return `Error: ${e instanceof Error ? e.message : e}`; }
    },
  );

  registerTool(
    { name: "get_stock_ohlcv", description: "Get historical daily/weekly/monthly OHLCV bars for a stock ticker.",
      input_schema: { type: "object", properties: { symbol: { type: "string" }, interval: { type: "string" } }, required: ["symbol"] } },
    async ({ symbol, interval }) => {
      try {
        const bars = await getStockOHLCV(symbol as string, (interval as any) ?? "daily");
        const recent = bars.slice(-10);
        return `${symbol} last ${recent.length} bars:\n` + recent.map((b) => `${b.date}: O=${b.open.toFixed(2)} H=${b.high.toFixed(2)} L=${b.low.toFixed(2)} C=${b.close.toFixed(2)} V=${b.volume.toLocaleString()}`).join("\n");
      } catch (e) { return `Error: ${e instanceof Error ? e.message : e}`; }
    },
  );

  registerTool(
    { name: "get_crypto_quote", description: "Get the latest price for a cryptocurrency (use CoinGecko IDs like 'bitcoin', 'ethereum').",
      input_schema: { type: "object", properties: { coin_id: { type: "string" }, vs_currency: { type: "string" } }, required: ["coin_id"] } },
    async ({ coin_id, vs_currency }) => {
      try {
        const q = await getCryptoQuote(coin_id as string, (vs_currency as string) ?? "usd");
        return `${q.coinId}: ${q.price.toLocaleString()} ${q.vsCurrency.toUpperCase()} (${q.change24hPct >= 0 ? "+" : ""}${q.change24hPct.toFixed(2)}% 24h) mcap=${q.marketCap.toLocaleString()} vol24h=${q.volume24h.toLocaleString()}`;
      } catch (e) { return `Error: ${e instanceof Error ? e.message : e}`; }
    },
  );

  registerTool(
    { name: "get_crypto_ohlcv", description: "Get historical OHLC data for a cryptocurrency over N days.",
      input_schema: { type: "object", properties: { coin_id: { type: "string" }, vs_currency: { type: "string" }, days: { type: "integer" } }, required: ["coin_id"] } },
    async ({ coin_id, vs_currency, days }) => {
      try {
        const bars = await getCryptoOHLCV(coin_id as string, (vs_currency as string) ?? "usd", (days as number) ?? 30);
        const recent = bars.slice(-10);
        return `${coin_id} last ${recent.length} bars:\n` + recent.map((b) => `t=${b.timestamp}: O=${b.open.toFixed(2)} H=${b.high.toFixed(2)} L=${b.low.toFixed(2)} C=${b.close.toFixed(2)}`).join("\n");
      } catch (e) { return `Error: ${e instanceof Error ? e.message : e}`; }
    },
  );

  registerTool(
    { name: "compute_indicators", description: "Compute SMA and RSI for a list of closing prices.",
      input_schema: { type: "object", properties: { closes: { type: "array", items: { type: "number" } }, sma_period: { type: "integer" }, rsi_period: { type: "integer" } }, required: ["closes"] } },
    ({ closes, sma_period, rsi_period }) => {
      try {
        const sma = computeSMA(closes as number[], (sma_period as number) ?? 20);
        const rsi = computeRSI(closes as number[], (rsi_period as number) ?? 14);
        const latestSma = [...sma].reverse().find((v) => v !== null);
        const latestRsi = [...rsi].reverse().find((v) => v !== null);
        const parts: string[] = [];
        if (latestSma != null) parts.push(`SMA(${sma_period ?? 20})=${(latestSma as number).toFixed(2)}`);
        if (latestRsi != null) parts.push(`RSI(${rsi_period ?? 14})=${(latestRsi as number).toFixed(1)}`);
        return parts.length ? parts.join(", ") : "Not enough data points to compute indicators";
      } catch (e) { return `Error: ${e instanceof Error ? e.message : e}`; }
    },
  );
}
