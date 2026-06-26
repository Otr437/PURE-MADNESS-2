//! Market Data — Rust
//! Live stock and crypto market data, registered as tools into ToolRegistry.
//!
//! Stock data: Alpha Vantage (free tier, requires API key)
//! Crypto data: CoinGecko (no API key required for basic public endpoints)
//!
//! export ALPHA_VANTAGE_API_KEY=...
//! export MARKET_DATA_CACHE_TTL=60   (seconds, default 60)

use std::collections::HashMap;
use std::env;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::Value;

const ALPHA_VANTAGE_BASE: &str = "https://www.alphavantage.co/query";
const COINGECKO_BASE:     &str = "https://api.coingecko.com/api/v3";

static SYMBOL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Z0-9.\-]+$").unwrap());
static COIN_ID_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-z0-9\-]+$").unwrap());

fn validate_symbol(symbol: &str) -> Result<String> {
    let s = symbol.trim().to_uppercase();
    if s.is_empty() || !SYMBOL_RE.is_match(&s) {
        anyhow::bail!("invalid ticker symbol: '{}'", symbol);
    }
    Ok(s)
}

fn validate_coin_id(coin_id: &str) -> Result<String> {
    let s = coin_id.trim().to_lowercase();
    if s.is_empty() || !COIN_ID_RE.is_match(&s) {
        anyhow::bail!("invalid coin id: '{}'", coin_id);
    }
    Ok(s)
}

// ── TTL cache (circuit-breaker-friendly: avoids hammering external APIs) ───────
struct CacheEntry { value: Value, expires_at: Instant }

pub struct TTLCache {
    ttl:   Duration,
    store: Mutex<HashMap<String, CacheEntry>>,
}

impl TTLCache {
    pub fn new(ttl: Duration) -> Self {
        Self { ttl, store: Mutex::new(HashMap::new()) }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        let mut store = self.store.lock().unwrap();
        match store.get(key) {
            Some(entry) if Instant::now() < entry.expires_at => Some(entry.value.clone()),
            Some(_) => { store.remove(key); None }
            None => None,
        }
    }

    pub fn set(&self, key: &str, value: Value) {
        let mut store = self.store.lock().unwrap();
        store.insert(key.to_string(), CacheEntry { value, expires_at: Instant::now() + self.ttl });
    }
}

static MD_CACHE: Lazy<TTLCache> = Lazy::new(|| {
    let ttl_secs: u64 = env::var("MARKET_DATA_CACHE_TTL").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
    TTLCache::new(Duration::from_secs(ttl_secs))
});

static MD_HTTP: Lazy<HttpClient> = Lazy::new(|| {
    HttpClient::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("rag-ai-monorepo/2.0")
        .build()
        .expect("failed to build market_data HTTP client")
});

// ── Retryable HTTP GET (exponential backoff, circuit-breaker pattern) ──────────
async fn get_json(url: &str) -> Result<Value> {
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1u32..=3 {
        match MD_HTTP.get(url).send().await {
            Ok(resp) if resp.status().is_success() => {
                return resp.json::<Value>().await.map_err(|e| anyhow!("invalid JSON response: {}", e));
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                last_err = Some(anyhow!("HTTP {}: {}", status, body));
            }
            Err(e) => last_err = Some(anyhow!(e)),
        }
        if attempt < 3 {
            let delay_secs = (2u64.pow(attempt)).min(30);
            tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("unknown error fetching {}", url)))
}

// ── Stock data (Alpha Vantage) ──────────────────────────────────────────────────
#[derive(Debug, Clone, serde::Serialize)]
pub struct StockQuote {
    pub symbol: String, pub price: f64, pub change: f64, pub change_pct: String,
    pub volume: i64, pub latest_trading_day: String, pub previous_close: f64,
}

pub async fn get_stock_quote(symbol: &str) -> Result<StockQuote> {
    let sym = validate_symbol(symbol)?;
    let api_key = env::var("ALPHA_VANTAGE_API_KEY")
        .map_err(|_| anyhow!("ALPHA_VANTAGE_API_KEY environment variable is not set"))?;

    let cache_key = format!("quote:{}", sym);
    if let Some(cached) = MD_CACHE.get(&cache_key) {
        return Ok(serde_json::from_value(cached)?);
    }

    let url = format!("{}?function=GLOBAL_QUOTE&symbol={}&apikey={}", ALPHA_VANTAGE_BASE, sym, api_key);
    let data = get_json(&url).await.map_err(|e| anyhow!("failed to fetch quote for {}: {}", sym, e))?;

    let quote = data.get("Global Quote").filter(|q| q.is_object() && !q.as_object().unwrap().is_empty());
    let quote = match quote {
        Some(q) => q,
        None => {
            let note = data.get("Note").or_else(|| data.get("Information"))
                .and_then(|v| v.as_str()).unwrap_or("No data returned");
            anyhow::bail!("no quote data for '{}': {}", sym, note);
        }
    };

    let get_str = |k: &str| quote.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let get_f64 = |k: &str| get_str(k).parse::<f64>().unwrap_or(0.0);
    let get_i64 = |k: &str| get_str(k).parse::<i64>().unwrap_or(0);

    let result = StockQuote {
        symbol:             { let s = get_str("01. symbol"); if s.is_empty() { sym.clone() } else { s } },
        price:              get_f64("05. price"),
        change:             get_f64("09. change"),
        change_pct:         get_str("10. change percent").trim_end_matches('%').to_string(),
        volume:             get_i64("06. volume"),
        latest_trading_day: get_str("07. latest trading day"),
        previous_close:     get_f64("08. previous close"),
    };
    MD_CACHE.set(&cache_key, serde_json::to_value(&result)?);
    Ok(result)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OHLCVBar {
    pub date: String, pub open: f64, pub high: f64, pub low: f64, pub close: f64, pub volume: i64,
}

pub async fn get_stock_ohlcv(symbol: &str, interval: &str, output_size: &str) -> Result<Vec<OHLCVBar>> {
    let sym = validate_symbol(symbol)?;
    let api_key = env::var("ALPHA_VANTAGE_API_KEY")
        .map_err(|_| anyhow!("ALPHA_VANTAGE_API_KEY environment variable is not set"))?;

    let func = match interval {
        "daily"   => "TIME_SERIES_DAILY",
        "weekly"  => "TIME_SERIES_WEEKLY",
        "monthly" => "TIME_SERIES_MONTHLY",
        other => anyhow::bail!("interval must be daily/weekly/monthly, got '{}'", other),
    };
    let size = if output_size == "full" { "full" } else { "compact" };

    let cache_key = format!("ohlcv:{}:{}:{}", sym, interval, size);
    if let Some(cached) = MD_CACHE.get(&cache_key) {
        return Ok(serde_json::from_value(cached)?);
    }

    let url = format!("{}?function={}&symbol={}&outputsize={}&apikey={}", ALPHA_VANTAGE_BASE, func, sym, size, api_key);
    let data = get_json(&url).await.map_err(|e| anyhow!("failed to fetch OHLCV for {}: {}", sym, e))?;

    let obj = data.as_object().ok_or_else(|| anyhow!("unexpected response shape for '{}'", sym))?;
    let ts_key = obj.keys().find(|k| k.contains("Time Series"));
    let ts_key = match ts_key {
        Some(k) => k,
        None => {
            let note = data.get("Note").or_else(|| data.get("Information"))
                .and_then(|v| v.as_str()).unwrap_or("No time series returned");
            anyhow::bail!("no OHLCV data for '{}': {}", sym, note);
        }
    };

    let series = data[ts_key].as_object().ok_or_else(|| anyhow!("unexpected time series format"))?;
    let mut bars: Vec<OHLCVBar> = series.iter().map(|(date, bar)| {
        let get = |k: &str| bar.get(k).and_then(|v| v.as_str()).unwrap_or("0").parse::<f64>().unwrap_or(0.0);
        OHLCVBar {
            date: date.clone(),
            open: get("1. open"), high: get("2. high"), low: get("3. low"), close: get("4. close"),
            volume: bar.get("5. volume").and_then(|v| v.as_str()).unwrap_or("0").parse().unwrap_or(0),
        }
    }).collect();
    bars.sort_by(|a, b| a.date.cmp(&b.date));

    MD_CACHE.set(&cache_key, serde_json::to_value(&bars)?);
    Ok(bars)
}

// ── Crypto data (CoinGecko) ─────────────────────────────────────────────────────
#[derive(Debug, Clone, serde::Serialize)]
pub struct CryptoQuote {
    pub coin_id: String, pub vs_currency: String, pub price: f64,
    pub change_24h_pct: f64, pub market_cap: f64, pub volume_24h: f64,
}

pub async fn get_crypto_quote(coin_id: &str, vs_currency: &str) -> Result<CryptoQuote> {
    let cid = validate_coin_id(coin_id)?;
    let vs  = if vs_currency.trim().is_empty() { "usd".to_string() } else { vs_currency.trim().to_lowercase() };

    let cache_key = format!("crypto_quote:{}:{}", cid, vs);
    if let Some(cached) = MD_CACHE.get(&cache_key) {
        return Ok(serde_json::from_value(cached)?);
    }

    let url = format!(
        "{}/simple/price?ids={}&vs_currencies={}&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true",
        COINGECKO_BASE, cid, vs
    );
    let data = get_json(&url).await.map_err(|e| anyhow!("failed to fetch crypto quote for {}: {}", cid, e))?;

    let coin_data = data.get(&cid)
        .ok_or_else(|| anyhow!("no data for coin '{}' — check the CoinGecko coin ID is correct", cid))?;

    let get = |k: &str| coin_data.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let result = CryptoQuote {
        coin_id: cid, vs_currency: vs.clone(),
        price:           get(&vs),
        change_24h_pct:  get(&format!("{}_24h_change", vs)),
        market_cap:      get(&format!("{}_market_cap", vs)),
        volume_24h:      get(&format!("{}_24h_vol", vs)),
    };
    MD_CACHE.set(&cache_key, serde_json::to_value(&result)?);
    Ok(result)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CryptoOHLCBar { pub timestamp: i64, pub open: f64, pub high: f64, pub low: f64, pub close: f64 }

pub async fn get_crypto_ohlcv(coin_id: &str, vs_currency: &str, days: u32) -> Result<Vec<CryptoOHLCBar>> {
    let cid = validate_coin_id(coin_id)?;
    let vs  = if vs_currency.trim().is_empty() { "usd".to_string() } else { vs_currency.trim().to_lowercase() };
    if days < 1 || days > 365 {
        anyhow::bail!("days must be between 1 and 365");
    }

    let cache_key = format!("crypto_ohlcv:{}:{}:{}", cid, vs, days);
    if let Some(cached) = MD_CACHE.get(&cache_key) {
        return Ok(serde_json::from_value(cached)?);
    }

    let url = format!("{}/coins/{}/ohlc?vs_currency={}&days={}", COINGECKO_BASE, cid, vs, days);
    let data = get_json(&url).await.map_err(|e| anyhow!("failed to fetch crypto OHLCV for {}: {}", cid, e))?;

    let rows = data.as_array().ok_or_else(|| anyhow!("unexpected response shape for '{}'", cid))?;
    if rows.is_empty() {
        anyhow::bail!("no OHLCV data for '{}'", cid);
    }

    let bars: Vec<CryptoOHLCBar> = rows.iter().filter_map(|row| {
        let arr = row.as_array()?;
        if arr.len() < 5 { return None; }
        Some(CryptoOHLCBar {
            timestamp: arr[0].as_i64().unwrap_or(0),
            open:  arr[1].as_f64().unwrap_or(0.0),
            high:  arr[2].as_f64().unwrap_or(0.0),
            low:   arr[3].as_f64().unwrap_or(0.0),
            close: arr[4].as_f64().unwrap_or(0.0),
        })
    }).collect();

    MD_CACHE.set(&cache_key, serde_json::to_value(&bars)?);
    Ok(bars)
}

// ── Technical indicators (computed locally — no external API needed) ───────────
pub fn compute_sma(closes: &[f64], period: usize) -> Vec<Option<f64>> {
    if period == 0 { return vec![None; closes.len()]; }
    (0..closes.len()).map(|i| {
        if i + 1 < period { None }
        else {
            let window = &closes[i + 1 - period..=i];
            Some(window.iter().sum::<f64>() / period as f64)
        }
    }).collect()
}

pub fn compute_rsi(closes: &[f64], period: usize) -> Vec<Option<f64>> {
    let n = closes.len();
    if period == 0 || n < period + 1 {
        return vec![None; n];
    }

    let deltas: Vec<f64> = (1..n).map(|i| closes[i] - closes[i - 1]).collect();
    let gains:  Vec<f64> = deltas.iter().map(|d| d.max(0.0)).collect();
    let losses: Vec<f64> = deltas.iter().map(|d| (-d).max(0.0)).collect();

    let mut out: Vec<Option<f64>> = vec![None; period];
    let mut avg_gain: f64 = gains[..period].iter().sum::<f64>() / period as f64;
    let mut avg_loss: f64 = losses[..period].iter().sum::<f64>() / period as f64;

    let rsi_from = |g: f64, l: f64| if l == 0.0 { 100.0 } else { 100.0 - (100.0 / (1.0 + g / l)) };
    out.push(Some(rsi_from(avg_gain, avg_loss)));

    for i in period..deltas.len() {
        avg_gain = (avg_gain * (period as f64 - 1.0) + gains[i]) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + losses[i]) / period as f64;
        out.push(Some(rsi_from(avg_gain, avg_loss)));
    }
    out
}

pub fn compute_atr(bars: &[OHLCVBar], period: usize) -> Vec<Option<f64>> {
    let n = bars.len();
    if period == 0 || n < 2 {
        return vec![None; n];
    }

    let true_ranges: Vec<f64> = (1..n).map(|i| {
        let (high, low, prev_close) = (bars[i].high, bars[i].low, bars[i - 1].close);
        (high - low).max((high - prev_close).abs()).max((low - prev_close).abs())
    }).collect();

    if true_ranges.len() < period {
        return vec![None; n];
    }

    let mut out: Vec<Option<f64>> = vec![None; period];
    let mut atr = true_ranges[..period].iter().sum::<f64>() / period as f64;
    out.push(Some(atr));

    for i in period..true_ranges.len() {
        atr = (atr * (period as f64 - 1.0) + true_ranges[i]) / period as f64;
        out.push(Some(atr));
    }
    out
}

// ── Tool registration ───────────────────────────────────────────────────────────
use crate::react_loop::ToolRegistry;

pub fn register_market_data_tools(registry: &mut ToolRegistry) {
    registry.register(
        "get_stock_quote", "Get the latest price quote for a stock ticker symbol.",
        serde_json::json!({ "type": "object", "properties": { "symbol": { "type": "string" } }, "required": ["symbol"] }),
        std::sync::Arc::new(|input: Value| {
            let symbol = input["symbol"].as_str().unwrap_or("").to_string();
            let rt = tokio::runtime::Handle::current();
            std::thread::spawn(move || rt.block_on(async move {
                match get_stock_quote(&symbol).await {
                    Ok(q) => Ok(format!("{}: ${:.2} ({:+.2}, {}%) vol={} as of {}",
                        q.symbol, q.price, q.change, q.change_pct, q.volume, q.latest_trading_day)),
                    Err(e) => Ok(format!("Error: {}", e)),
                }
            })).join().map_err(|e| anyhow!("{:?}", e))?
        }),
    );

    registry.register(
        "get_stock_ohlcv", "Get historical daily/weekly/monthly OHLCV bars for a stock ticker.",
        serde_json::json!({ "type": "object", "properties": {
            "symbol": { "type": "string" }, "interval": { "type": "string" }
        }, "required": ["symbol"] }),
        std::sync::Arc::new(|input: Value| {
            let symbol = input["symbol"].as_str().unwrap_or("").to_string();
            let interval = input["interval"].as_str().unwrap_or("daily").to_string();
            let rt = tokio::runtime::Handle::current();
            std::thread::spawn(move || rt.block_on(async move {
                match get_stock_ohlcv(&symbol, &interval, "compact").await {
                    Ok(bars) => {
                        let recent: Vec<&OHLCVBar> = bars.iter().rev().take(10).collect();
                        let lines: Vec<String> = recent.iter().rev().map(|b| format!(
                            "{}: O={:.2} H={:.2} L={:.2} C={:.2} V={}", b.date, b.open, b.high, b.low, b.close, b.volume
                        )).collect();
                        Ok(format!("{} last {} bars:\n{}", symbol, lines.len(), lines.join("\n")))
                    }
                    Err(e) => Ok(format!("Error: {}", e)),
                }
            })).join().map_err(|e| anyhow!("{:?}", e))?
        }),
    );

    registry.register(
        "get_crypto_quote", "Get the latest price for a cryptocurrency (use CoinGecko IDs like 'bitcoin', 'ethereum').",
        serde_json::json!({ "type": "object", "properties": {
            "coin_id": { "type": "string" }, "vs_currency": { "type": "string" }
        }, "required": ["coin_id"] }),
        std::sync::Arc::new(|input: Value| {
            let coin_id = input["coin_id"].as_str().unwrap_or("").to_string();
            let vs = input["vs_currency"].as_str().unwrap_or("usd").to_string();
            let rt = tokio::runtime::Handle::current();
            std::thread::spawn(move || rt.block_on(async move {
                match get_crypto_quote(&coin_id, &vs).await {
                    Ok(q) => Ok(format!("{}: {:.2} {} ({:+.2}% 24h) mcap={:.0} vol24h={:.0}",
                        q.coin_id, q.price, q.vs_currency.to_uppercase(), q.change_24h_pct, q.market_cap, q.volume_24h)),
                    Err(e) => Ok(format!("Error: {}", e)),
                }
            })).join().map_err(|e| anyhow!("{:?}", e))?
        }),
    );

    registry.register(
        "get_crypto_ohlcv", "Get historical OHLC data for a cryptocurrency over N days.",
        serde_json::json!({ "type": "object", "properties": {
            "coin_id": { "type": "string" }, "vs_currency": { "type": "string" }, "days": { "type": "integer" }
        }, "required": ["coin_id"] }),
        std::sync::Arc::new(|input: Value| {
            let coin_id = input["coin_id"].as_str().unwrap_or("").to_string();
            let vs = input["vs_currency"].as_str().unwrap_or("usd").to_string();
            let days = input["days"].as_u64().unwrap_or(30) as u32;
            let rt = tokio::runtime::Handle::current();
            std::thread::spawn(move || rt.block_on(async move {
                match get_crypto_ohlcv(&coin_id, &vs, days).await {
                    Ok(bars) => {
                        let recent: Vec<&CryptoOHLCBar> = bars.iter().rev().take(10).collect();
                        let lines: Vec<String> = recent.iter().rev().map(|b| format!(
                            "t={}: O={:.2} H={:.2} L={:.2} C={:.2}", b.timestamp, b.open, b.high, b.low, b.close
                        )).collect();
                        Ok(format!("{} last {} bars:\n{}", coin_id, lines.len(), lines.join("\n")))
                    }
                    Err(e) => Ok(format!("Error: {}", e)),
                }
            })).join().map_err(|e| anyhow!("{:?}", e))?
        }),
    );

    registry.register(
        "compute_indicators", "Compute SMA and RSI for a list of closing prices.",
        serde_json::json!({ "type": "object", "properties": {
            "closes": { "type": "array", "items": { "type": "number" } },
            "sma_period": { "type": "integer" }, "rsi_period": { "type": "integer" }
        }, "required": ["closes"] }),
        std::sync::Arc::new(|input: Value| {
            let closes: Vec<f64> = input["closes"].as_array().map(|a| {
                a.iter().filter_map(|v| v.as_f64()).collect()
            }).unwrap_or_default();
            let sma_period = input["sma_period"].as_u64().unwrap_or(20) as usize;
            let rsi_period = input["rsi_period"].as_u64().unwrap_or(14) as usize;

            let sma = compute_sma(&closes, sma_period);
            let rsi = compute_rsi(&closes, rsi_period);
            let latest_sma = sma.iter().rev().find_map(|v| *v);
            let latest_rsi = rsi.iter().rev().find_map(|v| *v);

            let mut parts = Vec::new();
            if let Some(v) = latest_sma { parts.push(format!("SMA({})={:.2}", sma_period, v)); }
            if let Some(v) = latest_rsi { parts.push(format!("RSI({})={:.1}", rsi_period, v)); }

            Ok(if parts.is_empty() { "Not enough data points to compute indicators".to_string() } else { parts.join(", ") })
        }),
    );
}

// ── Tests ──────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sma_basic() {
        let result = compute_sma(&[1.0, 2.0, 3.0, 4.0, 5.0], 3);
        assert_eq!(result, vec![None, None, Some(2.0), Some(3.0), Some(4.0)]);
    }

    #[test]
    fn test_sma_period_one() {
        let result = compute_sma(&[1.0, 2.0, 3.0], 1);
        assert_eq!(result, vec![Some(1.0), Some(2.0), Some(3.0)]);
    }

    #[test]
    fn test_sma_zero_period() {
        let result = compute_sma(&[1.0, 2.0, 3.0], 0);
        assert_eq!(result, vec![None, None, None]);
    }

    #[test]
    fn test_rsi_insufficient_data() {
        let result = compute_rsi(&[1.0, 2.0, 3.0], 14);
        assert!(result.iter().all(|v| v.is_none()));
    }

    #[test]
    fn test_rsi_all_gains_saturates_100() {
        let closes: Vec<f64> = (1..=19).map(|i| i as f64).collect();
        let result = compute_rsi(&closes, 14);
        assert_eq!(*result.last().unwrap(), Some(100.0));
    }

    #[test]
    fn test_rsi_bounded() {
        let closes = vec![10.0, 12.0, 11.0, 13.0, 12.0, 14.0, 13.0, 15.0, 14.0, 16.0, 15.0, 17.0, 16.0, 18.0, 17.0, 19.0];
        let result = compute_rsi(&closes, 14);
        for v in result.into_iter().flatten() {
            assert!((0.0..=100.0).contains(&v));
        }
    }

    #[test]
    fn test_atr_basic() {
        let bars = vec![
            OHLCVBar { date: "1".into(), open: 9.0, high: 10.0, low: 8.0, close: 9.0, volume: 0 },
            OHLCVBar { date: "2".into(), open: 10.0, high: 11.0, low: 9.0, close: 10.0, volume: 0 },
            OHLCVBar { date: "3".into(), open: 11.0, high: 12.0, low: 10.0, close: 11.0, volume: 0 },
        ];
        let result = compute_atr(&bars, 2);
        assert_eq!(result.len(), bars.len());
        assert!(result.last().unwrap().unwrap() > 0.0);
    }

    #[test]
    fn test_atr_too_few_bars() {
        let bars = vec![OHLCVBar { date: "1".into(), open: 9.0, high: 10.0, low: 9.0, close: 9.5, volume: 0 }];
        let result = compute_atr(&bars, 14);
        assert!(result.iter().all(|v| v.is_none()));
    }

    #[test]
    fn test_ttl_cache_set_get() {
        let cache = TTLCache::new(Duration::from_secs(60));
        cache.set("key1", serde_json::json!("value1"));
        assert_eq!(cache.get("key1"), Some(serde_json::json!("value1")));
    }

    #[test]
    fn test_ttl_cache_miss() {
        let cache = TTLCache::new(Duration::from_secs(60));
        assert_eq!(cache.get("nonexistent"), None);
    }

    #[test]
    fn test_ttl_cache_expiry() {
        let cache = TTLCache::new(Duration::from_secs(0));
        cache.set("key1", serde_json::json!("value1"));
        std::thread::sleep(Duration::from_millis(10));
        assert_eq!(cache.get("key1"), None);
    }

    #[test]
    fn test_validate_symbol_rejects_invalid() {
        assert!(validate_symbol("").is_err());
        assert!(validate_symbol("BAD SYMBOL!").is_err());
        assert!(validate_symbol("aapl").is_ok());
    }

    #[test]
    fn test_validate_coin_id_rejects_invalid() {
        assert!(validate_coin_id("").is_err());
        assert!(validate_coin_id("Bitcoin!").is_err());
        assert!(validate_coin_id("bitcoin").is_ok());
    }
}
