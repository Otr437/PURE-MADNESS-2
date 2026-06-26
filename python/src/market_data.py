"""
Market Data — Python
Live stock and crypto market data, registered as tools into react_loop's TOOL_REGISTRY.

Stock data: Alpha Vantage (free tier, requires API key)
Crypto data: CoinGecko (no API key required for basic public endpoints)

export ALPHA_VANTAGE_API_KEY=...   (required for stock tools)
export MARKET_DATA_CACHE_TTL=60    (seconds, default 60)

This module has no side effects on import beyond tool registration — call
register_market_data_tools() explicitly from rag_agent.py / trading_agent.py
to wire these into the active tool registry.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import structlog
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from react_loop import tool

structlog.configure(processors=[
    structlog.processors.TimeStamper(fmt="iso"),
    structlog.processors.add_log_level,
    structlog.processors.JSONRenderer(),
])
log = structlog.get_logger()

ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query"
COINGECKO_BASE      = "https://api.coingecko.com/api/v3"
CACHE_TTL           = int(os.environ.get("MARKET_DATA_CACHE_TTL", "60"))
HTTP_TIMEOUT        = httpx.Timeout(connect=10.0, read=20.0, write=10.0, pool=10.0)

_http = httpx.Client(timeout=HTTP_TIMEOUT, headers={"User-Agent": "rag-ai-monorepo/2.0"})


# ── Simple in-memory TTL cache (circuit-breaker friendly: avoids hammering APIs) ──
@dataclass
class _CacheEntry:
    value:      Any
    expires_at: float


class _TTLCache:
    def __init__(self, ttl_seconds: int) -> None:
        self._ttl = ttl_seconds
        self._store: dict[str, _CacheEntry] = {}

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        if time.time() > entry.expires_at:
            del self._store[key]
            return None
        return entry.value

    def set(self, key: str, value: Any) -> None:
        self._store[key] = _CacheEntry(value=value, expires_at=time.time() + self._ttl)


_cache = _TTLCache(CACHE_TTL)


class MarketDataError(Exception):
    """Raised for any market data fetch failure after retries are exhausted."""


# ── Retryable HTTP GET (circuit-breaker pattern, matches rag_engine.py style) ───
@retry(
    retry=retry_if_exception_type((httpx.ConnectError, httpx.ReadTimeout, httpx.HTTPStatusError)),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    stop=stop_after_attempt(3),
)
def _get_json(url: str, params: dict | None = None) -> dict:
    resp = _http.get(url, params=params)
    resp.raise_for_status()
    return resp.json()


# ── Stock data (Alpha Vantage) ──────────────────────────────────────────────────
def get_stock_quote(symbol: str) -> dict:
    """
    Fetch the latest quote for a stock ticker.

    Returns:
        {symbol, price, change, change_pct, volume, latest_trading_day}

    Raises:
        MarketDataError if the API key is missing, the symbol is invalid,
        or the API call fails after retries.
    """
    symbol = symbol.strip().upper()
    if not symbol or not symbol.replace(".", "").replace("-", "").isalnum():
        raise MarketDataError(f"Invalid ticker symbol: '{symbol}'")

    api_key = os.environ.get("ALPHA_VANTAGE_API_KEY")
    if not api_key:
        raise MarketDataError("ALPHA_VANTAGE_API_KEY environment variable is not set")

    cache_key = f"quote:{symbol}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        data = _get_json(ALPHA_VANTAGE_BASE, params={
            "function": "GLOBAL_QUOTE",
            "symbol":   symbol,
            "apikey":   api_key,
        })
    except Exception as e:
        log.error("market_data.stock_quote_failed", symbol=symbol, error=str(e))
        raise MarketDataError(f"Failed to fetch quote for {symbol}: {e}") from e

    quote = data.get("Global Quote", {})
    if not quote:
        note = data.get("Note") or data.get("Information") or "No data returned"
        raise MarketDataError(f"No quote data for '{symbol}': {note}")

    result = {
        "symbol":              quote.get("01. symbol", symbol),
        "price":               float(quote.get("05. price", 0)),
        "change":              float(quote.get("09. change", 0)),
        "change_pct":          quote.get("10. change percent", "0%").rstrip("%"),
        "volume":              int(quote.get("06. volume", 0)),
        "latest_trading_day":  quote.get("07. latest trading day", ""),
        "previous_close":      float(quote.get("08. previous close", 0)),
    }
    _cache.set(cache_key, result)
    log.info("market_data.stock_quote", symbol=symbol, price=result["price"])
    return result


def get_stock_ohlcv(symbol: str, interval: str = "daily", output_size: str = "compact") -> list[dict]:
    """
    Fetch historical OHLCV (Open/High/Low/Close/Volume) bars for a stock ticker.

    Args:
        symbol:       Ticker symbol (e.g. "AAPL").
        interval:     "daily", "weekly", or "monthly".
        output_size:  "compact" (latest 100 bars) or "full" (20+ years).

    Returns:
        List of {date, open, high, low, close, volume}, most recent last.
    """
    symbol = symbol.strip().upper()
    if not symbol or not symbol.replace(".", "").replace("-", "").isalnum():
        raise MarketDataError(f"Invalid ticker symbol: '{symbol}'")
    if interval not in ("daily", "weekly", "monthly"):
        raise MarketDataError(f"interval must be daily/weekly/monthly, got '{interval}'")

    api_key = os.environ.get("ALPHA_VANTAGE_API_KEY")
    if not api_key:
        raise MarketDataError("ALPHA_VANTAGE_API_KEY environment variable is not set")

    func_map = {
        "daily":   "TIME_SERIES_DAILY",
        "weekly":  "TIME_SERIES_WEEKLY",
        "monthly": "TIME_SERIES_MONTHLY",
    }
    cache_key = f"ohlcv:{symbol}:{interval}:{output_size}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        data = _get_json(ALPHA_VANTAGE_BASE, params={
            "function":    func_map[interval],
            "symbol":      symbol,
            "outputsize":  output_size,
            "apikey":      api_key,
        })
    except Exception as e:
        log.error("market_data.stock_ohlcv_failed", symbol=symbol, error=str(e))
        raise MarketDataError(f"Failed to fetch OHLCV for {symbol}: {e}") from e

    ts_key = next((k for k in data if "Time Series" in k), None)
    if not ts_key:
        note = data.get("Note") or data.get("Information") or "No time series returned"
        raise MarketDataError(f"No OHLCV data for '{symbol}': {note}")

    series = data[ts_key]
    bars = sorted(
        [
            {
                "date":   date,
                "open":   float(bar["1. open"]),
                "high":   float(bar["2. high"]),
                "low":    float(bar["3. low"]),
                "close":  float(bar["4. close"]),
                "volume": int(bar["5. volume"]),
            }
            for date, bar in series.items()
        ],
        key=lambda b: b["date"],
    )
    _cache.set(cache_key, bars)
    log.info("market_data.stock_ohlcv", symbol=symbol, interval=interval, bars=len(bars))
    return bars


# ── Crypto data (CoinGecko) ─────────────────────────────────────────────────────
def get_crypto_quote(coin_id: str, vs_currency: str = "usd") -> dict:
    """
    Fetch the latest price and 24h stats for a cryptocurrency.

    Args:
        coin_id:     CoinGecko coin ID (e.g. "bitcoin", "ethereum", "solana").
        vs_currency: Quote currency (default "usd").

    Returns:
        {coin_id, price, change_24h_pct, market_cap, volume_24h}
    """
    coin_id     = coin_id.strip().lower()
    vs_currency = vs_currency.strip().lower()
    if not coin_id or not coin_id.replace("-", "").isalnum():
        raise MarketDataError(f"Invalid coin id: '{coin_id}'")

    cache_key = f"crypto_quote:{coin_id}:{vs_currency}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        data = _get_json(f"{COINGECKO_BASE}/simple/price", params={
            "ids":                       coin_id,
            "vs_currencies":             vs_currency,
            "include_24hr_change":       "true",
            "include_market_cap":        "true",
            "include_24hr_vol":          "true",
        })
    except Exception as e:
        log.error("market_data.crypto_quote_failed", coin_id=coin_id, error=str(e))
        raise MarketDataError(f"Failed to fetch crypto quote for {coin_id}: {e}") from e

    coin_data = data.get(coin_id)
    if not coin_data:
        raise MarketDataError(f"No data for coin '{coin_id}' — check the CoinGecko coin ID is correct")

    result = {
        "coin_id":         coin_id,
        "vs_currency":     vs_currency,
        "price":           coin_data.get(vs_currency, 0.0),
        "change_24h_pct":  coin_data.get(f"{vs_currency}_24h_change", 0.0),
        "market_cap":      coin_data.get(f"{vs_currency}_market_cap", 0.0),
        "volume_24h":      coin_data.get(f"{vs_currency}_24h_vol", 0.0),
    }
    _cache.set(cache_key, result)
    log.info("market_data.crypto_quote", coin_id=coin_id, price=result["price"])
    return result


def get_crypto_ohlcv(coin_id: str, vs_currency: str = "usd", days: int = 30) -> list[dict]:
    """
    Fetch historical OHLC data for a cryptocurrency.

    Args:
        coin_id:     CoinGecko coin ID.
        vs_currency: Quote currency.
        days:        Lookback window in days (1, 7, 14, 30, 90, 180, 365, or max).

    Returns:
        List of {timestamp, open, high, low, close}, most recent last.
    """
    coin_id     = coin_id.strip().lower()
    vs_currency = vs_currency.strip().lower()
    if not coin_id or not coin_id.replace("-", "").isalnum():
        raise MarketDataError(f"Invalid coin id: '{coin_id}'")
    if days < 1 or days > 365:
        raise MarketDataError("days must be between 1 and 365")

    cache_key = f"crypto_ohlcv:{coin_id}:{vs_currency}:{days}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        data = _get_json(f"{COINGECKO_BASE}/coins/{coin_id}/ohlc", params={
            "vs_currency": vs_currency,
            "days":        days,
        })
    except Exception as e:
        log.error("market_data.crypto_ohlcv_failed", coin_id=coin_id, error=str(e))
        raise MarketDataError(f"Failed to fetch crypto OHLCV for {coin_id}: {e}") from e

    if not isinstance(data, list) or not data:
        raise MarketDataError(f"No OHLCV data for '{coin_id}'")

    bars = [
        {
            "timestamp": int(row[0]),
            "open":      float(row[1]),
            "high":      float(row[2]),
            "low":       float(row[3]),
            "close":     float(row[4]),
        }
        for row in data
    ]
    _cache.set(cache_key, bars)
    log.info("market_data.crypto_ohlcv", coin_id=coin_id, days=days, bars=len(bars))
    return bars


# ── Technical indicators (computed locally — no external API needed) ───────────
def compute_sma(closes: list[float], period: int) -> list[float | None]:
    """Simple moving average. Returns None for indices before the window fills."""
    if period < 1:
        raise MarketDataError("period must be >= 1")
    out: list[float | None] = []
    for i in range(len(closes)):
        if i + 1 < period:
            out.append(None)
        else:
            out.append(sum(closes[i + 1 - period:i + 1]) / period)
    return out


def compute_rsi(closes: list[float], period: int = 14) -> list[float | None]:
    """Relative Strength Index using Wilder's smoothing method."""
    if period < 1:
        raise MarketDataError("period must be >= 1")
    if len(closes) < period + 1:
        return [None] * len(closes)

    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains  = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]

    out: list[float | None] = [None] * period
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    rs = avg_gain / avg_loss if avg_loss != 0 else float("inf")
    out.append(100.0 - (100.0 / (1.0 + rs)) if avg_loss != 0 else 100.0)

    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        rs = avg_gain / avg_loss if avg_loss != 0 else float("inf")
        out.append(100.0 - (100.0 / (1.0 + rs)) if avg_loss != 0 else 100.0)

    return out


def compute_atr(bars: list[dict], period: int = 14) -> list[float | None]:
    """Average True Range using Wilder's smoothing. Bars must have high/low/close keys."""
    if period < 1:
        raise MarketDataError("period must be >= 1")
    if len(bars) < 2:
        return [None] * len(bars)

    true_ranges: list[float] = []
    for i in range(1, len(bars)):
        high, low, prev_close = bars[i]["high"], bars[i]["low"], bars[i - 1]["close"]
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        true_ranges.append(tr)

    out: list[float | None] = [None] * period
    if len(true_ranges) < period:
        return [None] * len(bars)

    atr = sum(true_ranges[:period]) / period
    out.append(atr)
    for i in range(period, len(true_ranges)):
        atr = (atr * (period - 1) + true_ranges[i]) / period
        out.append(atr)

    return out


# ── Tool registration ───────────────────────────────────────────────────────────
def register_market_data_tools() -> None:
    """
    Register all market_data functions as tools in react_loop.TOOL_REGISTRY.
    Call this explicitly from trading_agent.py before running the ReAct loop.
    Idempotent — re-registering replaces the existing entry, no duplicates.
    """

    @tool("get_stock_quote", "Get the latest price quote for a stock ticker symbol.",
          {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]})
    def _get_stock_quote(symbol: str) -> str:
        try:
            q = get_stock_quote(symbol)
            return (f"{q['symbol']}: ${q['price']:.2f} ({q['change']:+.2f}, {q['change_pct']}%) "
                    f"vol={q['volume']:,} as of {q['latest_trading_day']}")
        except MarketDataError as e:
            return f"Error: {e}"

    @tool("get_stock_ohlcv", "Get historical daily/weekly/monthly OHLCV bars for a stock ticker.",
          {"type": "object", "properties": {
              "symbol": {"type": "string"},
              "interval": {"type": "string", "description": "daily, weekly, or monthly"},
          }, "required": ["symbol"]})
    def _get_stock_ohlcv(symbol: str, interval: str = "daily") -> str:
        try:
            bars = get_stock_ohlcv(symbol, interval=interval)
            recent = bars[-10:]
            lines = [f"{b['date']}: O={b['open']:.2f} H={b['high']:.2f} L={b['low']:.2f} C={b['close']:.2f} V={b['volume']:,}" for b in recent]
            return f"{symbol} last {len(recent)} {interval} bars:\n" + "\n".join(lines)
        except MarketDataError as e:
            return f"Error: {e}"

    @tool("get_crypto_quote", "Get the latest price for a cryptocurrency (use CoinGecko IDs like 'bitcoin', 'ethereum').",
          {"type": "object", "properties": {
              "coin_id": {"type": "string"},
              "vs_currency": {"type": "string"},
          }, "required": ["coin_id"]})
    def _get_crypto_quote(coin_id: str, vs_currency: str = "usd") -> str:
        try:
            q = get_crypto_quote(coin_id, vs_currency)
            return (f"{q['coin_id']}: {q['price']:,.2f} {q['vs_currency'].upper()} "
                    f"({q['change_24h_pct']:+.2f}% 24h) mcap={q['market_cap']:,.0f} vol24h={q['volume_24h']:,.0f}")
        except MarketDataError as e:
            return f"Error: {e}"

    @tool("get_crypto_ohlcv", "Get historical OHLC data for a cryptocurrency over N days.",
          {"type": "object", "properties": {
              "coin_id": {"type": "string"},
              "vs_currency": {"type": "string"},
              "days": {"type": "integer"},
          }, "required": ["coin_id"]})
    def _get_crypto_ohlcv(coin_id: str, vs_currency: str = "usd", days: int = 30) -> str:
        try:
            bars = get_crypto_ohlcv(coin_id, vs_currency, days)
            recent = bars[-10:]
            lines = [f"t={b['timestamp']}: O={b['open']:.2f} H={b['high']:.2f} L={b['low']:.2f} C={b['close']:.2f}" for b in recent]
            return f"{coin_id} last {len(recent)} bars ({days}d window):\n" + "\n".join(lines)
        except MarketDataError as e:
            return f"Error: {e}"

    @tool("compute_indicators", "Compute SMA, RSI, and ATR for a list of closing prices (and optionally OHLC bars for ATR).",
          {"type": "object", "properties": {
              "closes": {"type": "array", "items": {"type": "number"}},
              "sma_period": {"type": "integer"},
              "rsi_period": {"type": "integer"},
          }, "required": ["closes"]})
    def _compute_indicators(closes: list[float], sma_period: int = 20, rsi_period: int = 14) -> str:
        try:
            sma = compute_sma(closes, sma_period)
            rsi = compute_rsi(closes, rsi_period)
            latest_sma = next((v for v in reversed(sma) if v is not None), None)
            latest_rsi = next((v for v in reversed(rsi) if v is not None), None)
            parts = []
            if latest_sma is not None:
                parts.append(f"SMA({sma_period})={latest_sma:.2f}")
            if latest_rsi is not None:
                parts.append(f"RSI({rsi_period})={latest_rsi:.1f}")
            if not parts:
                return "Not enough data points to compute indicators"
            return ", ".join(parts)
        except MarketDataError as e:
            return f"Error: {e}"

    log.info("market_data.tools_registered", count=5)
