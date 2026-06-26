// Market Data — Go
// Live stock and crypto market data, registered as tools into the shared
// GoToolRegistry (react_loop.go).
//
// Stock data: Alpha Vantage (free tier, requires API key)
// Crypto data: CoinGecko (no API key required for basic public endpoints)
//
// export ALPHA_VANTAGE_API_KEY=...
// export MARKET_DATA_CACHE_TTL=60   (seconds, default 60)

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	alphaVantageBase = "https://www.alphavantage.co/query"
	coinGeckoBase    = "https://api.coingecko.com/api/v3"
)

var marketDataSymbolRe = regexp.MustCompile(`^[A-Z0-9.\-]+$`)
var marketDataCoinIDRe = regexp.MustCompile(`^[a-z0-9\-]+$`)

type MarketDataError struct{ Msg string }

func (e *MarketDataError) Error() string { return e.Msg }

func mdErrorf(format string, args ...interface{}) error {
	return &MarketDataError{Msg: fmt.Sprintf(format, args...)}
}

// ── TTL cache (circuit-breaker-friendly: avoids hammering external APIs) ───────
type mdCacheEntry struct {
	value     interface{}
	expiresAt time.Time
}

type mdTTLCache struct {
	mu    sync.Mutex
	ttl   time.Duration
	store map[string]mdCacheEntry
}

func newMDCache(ttl time.Duration) *mdTTLCache {
	return &mdTTLCache{ttl: ttl, store: make(map[string]mdCacheEntry)}
}

func (c *mdTTLCache) Get(key string) (interface{}, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.store[key]
	if !ok || time.Now().After(entry.expiresAt) {
		delete(c.store, key)
		return nil, false
	}
	return entry.value, true
}

func (c *mdTTLCache) Set(key string, value interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.store[key] = mdCacheEntry{value: value, expiresAt: time.Now().Add(c.ttl)}
}

var mdCache = newMDCache(func() time.Duration {
	ttl := 60
	if v := os.Getenv("MARKET_DATA_CACHE_TTL"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			ttl = n
		}
	}
	return time.Duration(ttl) * time.Second
}())

var mdHTTPClient = &http.Client{Timeout: 20 * time.Second}

// ── Retryable HTTP GET (exponential backoff, circuit-breaker pattern) ──────────
func mdGetJSON(rawURL string, result interface{}) error {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		req, err := http.NewRequest("GET", rawURL, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "rag-ai-monorepo/2.0")

		resp, err := mdHTTPClient.Do(req)
		if err != nil {
			lastErr = err
		} else {
			defer resp.Body.Close()
			body, readErr := io.ReadAll(resp.Body)
			if readErr != nil {
				lastErr = readErr
			} else if resp.StatusCode != http.StatusOK {
				lastErr = fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
			} else {
				return json.Unmarshal(body, result)
			}
		}

		if attempt < 3 {
			delay := time.Duration(1<<uint(attempt)) * time.Second
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
			time.Sleep(delay)
		}
	}
	return lastErr
}

func validateMDSymbol(symbol string) (string, error) {
	s := strings.ToUpper(strings.TrimSpace(symbol))
	if s == "" || !marketDataSymbolRe.MatchString(s) {
		return "", mdErrorf("invalid ticker symbol: '%s'", symbol)
	}
	return s, nil
}

func validateMDCoinID(coinID string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(coinID))
	if s == "" || !marketDataCoinIDRe.MatchString(s) {
		return "", mdErrorf("invalid coin id: '%s'", coinID)
	}
	return s, nil
}

// ── Stock data (Alpha Vantage) ──────────────────────────────────────────────────
type StockQuote struct {
	Symbol           string  `json:"symbol"`
	Price            float64 `json:"price"`
	Change           float64 `json:"change"`
	ChangePct        string  `json:"change_pct"`
	Volume           int64   `json:"volume"`
	LatestTradingDay string  `json:"latest_trading_day"`
	PreviousClose    float64 `json:"previous_close"`
}

func getStockQuote(symbol string) (*StockQuote, error) {
	sym, err := validateMDSymbol(symbol)
	if err != nil {
		return nil, err
	}
	apiKey := os.Getenv("ALPHA_VANTAGE_API_KEY")
	if apiKey == "" {
		return nil, mdErrorf("ALPHA_VANTAGE_API_KEY environment variable is not set")
	}

	cacheKey := "quote:" + sym
	if cached, ok := mdCache.Get(cacheKey); ok {
		return cached.(*StockQuote), nil
	}

	reqURL := fmt.Sprintf("%s?function=GLOBAL_QUOTE&symbol=%s&apikey=%s",
		alphaVantageBase, url.QueryEscape(sym), url.QueryEscape(apiKey))

	var raw map[string]interface{}
	if err := mdGetJSON(reqURL, &raw); err != nil {
		return nil, mdErrorf("failed to fetch quote for %s: %v", sym, err)
	}

	quote, ok := raw["Global Quote"].(map[string]interface{})
	if !ok || len(quote) == 0 {
		note := "No data returned"
		if n, ok := raw["Note"].(string); ok {
			note = n
		} else if n, ok := raw["Information"].(string); ok {
			note = n
		}
		return nil, mdErrorf("no quote data for '%s': %s", sym, note)
	}

	result := &StockQuote{
		Symbol:           mdStr(quote["01. symbol"], sym),
		Price:            mdFloat(quote["05. price"]),
		Change:           mdFloat(quote["09. change"]),
		ChangePct:        strings.TrimSuffix(mdStr(quote["10. change percent"], "0%"), "%"),
		Volume:           mdInt(quote["06. volume"]),
		LatestTradingDay: mdStr(quote["07. latest trading day"], ""),
		PreviousClose:    mdFloat(quote["08. previous close"]),
	}
	mdCache.Set(cacheKey, result)
	return result, nil
}

type OHLCVBar struct {
	Date   string  `json:"date"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume int64   `json:"volume"`
}

func getStockOHLCV(symbol, interval, outputSize string) ([]OHLCVBar, error) {
	sym, err := validateMDSymbol(symbol)
	if err != nil {
		return nil, err
	}
	apiKey := os.Getenv("ALPHA_VANTAGE_API_KEY")
	if apiKey == "" {
		return nil, mdErrorf("ALPHA_VANTAGE_API_KEY environment variable is not set")
	}

	funcMap := map[string]string{"daily": "TIME_SERIES_DAILY", "weekly": "TIME_SERIES_WEEKLY", "monthly": "TIME_SERIES_MONTHLY"}
	fn, ok := funcMap[interval]
	if !ok {
		return nil, mdErrorf("interval must be daily/weekly/monthly, got '%s'", interval)
	}
	if outputSize != "compact" && outputSize != "full" {
		outputSize = "compact"
	}

	cacheKey := fmt.Sprintf("ohlcv:%s:%s:%s", sym, interval, outputSize)
	if cached, ok := mdCache.Get(cacheKey); ok {
		return cached.([]OHLCVBar), nil
	}

	reqURL := fmt.Sprintf("%s?function=%s&symbol=%s&outputsize=%s&apikey=%s",
		alphaVantageBase, fn, url.QueryEscape(sym), outputSize, url.QueryEscape(apiKey))

	var raw map[string]interface{}
	if err := mdGetJSON(reqURL, &raw); err != nil {
		return nil, mdErrorf("failed to fetch OHLCV for %s: %v", sym, err)
	}

	var tsKey string
	for k := range raw {
		if strings.Contains(k, "Time Series") {
			tsKey = k
			break
		}
	}
	if tsKey == "" {
		note := "No time series returned"
		if n, ok := raw["Note"].(string); ok {
			note = n
		} else if n, ok := raw["Information"].(string); ok {
			note = n
		}
		return nil, mdErrorf("no OHLCV data for '%s': %s", sym, note)
	}

	series, ok := raw[tsKey].(map[string]interface{})
	if !ok {
		return nil, mdErrorf("unexpected time series format for '%s'", sym)
	}

	bars := make([]OHLCVBar, 0, len(series))
	for date, v := range series {
		bar, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		bars = append(bars, OHLCVBar{
			Date:   date,
			Open:   mdFloat(bar["1. open"]),
			High:   mdFloat(bar["2. high"]),
			Low:    mdFloat(bar["3. low"]),
			Close:  mdFloat(bar["4. close"]),
			Volume: mdInt(bar["5. volume"]),
		})
	}
	sort.Slice(bars, func(i, j int) bool { return bars[i].Date < bars[j].Date })

	mdCache.Set(cacheKey, bars)
	return bars, nil
}

// ── Crypto data (CoinGecko) ─────────────────────────────────────────────────────
type CryptoQuote struct {
	CoinID       string  `json:"coin_id"`
	VsCurrency   string  `json:"vs_currency"`
	Price        float64 `json:"price"`
	Change24hPct float64 `json:"change_24h_pct"`
	MarketCap    float64 `json:"market_cap"`
	Volume24h    float64 `json:"volume_24h"`
}

func getCryptoQuote(coinID, vsCurrency string) (*CryptoQuote, error) {
	cid, err := validateMDCoinID(coinID)
	if err != nil {
		return nil, err
	}
	vs := strings.ToLower(strings.TrimSpace(vsCurrency))
	if vs == "" {
		vs = "usd"
	}

	cacheKey := fmt.Sprintf("crypto_quote:%s:%s", cid, vs)
	if cached, ok := mdCache.Get(cacheKey); ok {
		return cached.(*CryptoQuote), nil
	}

	reqURL := fmt.Sprintf("%s/simple/price?ids=%s&vs_currencies=%s&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true",
		coinGeckoBase, url.QueryEscape(cid), url.QueryEscape(vs))

	var raw map[string]map[string]float64
	if err := mdGetJSON(reqURL, &raw); err != nil {
		return nil, mdErrorf("failed to fetch crypto quote for %s: %v", cid, err)
	}

	coinData, ok := raw[cid]
	if !ok {
		return nil, mdErrorf("no data for coin '%s' — check the CoinGecko coin ID is correct", cid)
	}

	result := &CryptoQuote{
		CoinID:       cid,
		VsCurrency:   vs,
		Price:        coinData[vs],
		Change24hPct: coinData[vs+"_24h_change"],
		MarketCap:    coinData[vs+"_market_cap"],
		Volume24h:    coinData[vs+"_24h_vol"],
	}
	mdCache.Set(cacheKey, result)
	return result, nil
}

type CryptoOHLCBar struct {
	Timestamp int64   `json:"timestamp"`
	Open      float64 `json:"open"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Close     float64 `json:"close"`
}

func getCryptoOHLCV(coinID, vsCurrency string, days int) ([]CryptoOHLCBar, error) {
	cid, err := validateMDCoinID(coinID)
	if err != nil {
		return nil, err
	}
	vs := strings.ToLower(strings.TrimSpace(vsCurrency))
	if vs == "" {
		vs = "usd"
	}
	if days < 1 || days > 365 {
		return nil, mdErrorf("days must be between 1 and 365")
	}

	cacheKey := fmt.Sprintf("crypto_ohlcv:%s:%s:%d", cid, vs, days)
	if cached, ok := mdCache.Get(cacheKey); ok {
		return cached.([]CryptoOHLCBar), nil
	}

	reqURL := fmt.Sprintf("%s/coins/%s/ohlc?vs_currency=%s&days=%d",
		coinGeckoBase, url.QueryEscape(cid), url.QueryEscape(vs), days)

	var raw [][]float64
	if err := mdGetJSON(reqURL, &raw); err != nil {
		return nil, mdErrorf("failed to fetch crypto OHLCV for %s: %v", cid, err)
	}
	if len(raw) == 0 {
		return nil, mdErrorf("no OHLCV data for '%s'", cid)
	}

	bars := make([]CryptoOHLCBar, len(raw))
	for i, row := range raw {
		if len(row) < 5 {
			continue
		}
		bars[i] = CryptoOHLCBar{
			Timestamp: int64(row[0]), Open: row[1], High: row[2], Low: row[3], Close: row[4],
		}
	}
	mdCache.Set(cacheKey, bars)
	return bars, nil
}

// ── Technical indicators (computed locally — no external API needed) ───────────
func computeSMA(closes []float64, period int) []*float64 {
	out := make([]*float64, len(closes))
	if period < 1 {
		return out
	}
	for i := range closes {
		if i+1 < period {
			continue
		}
		sum := 0.0
		for _, v := range closes[i+1-period : i+1] {
			sum += v
		}
		avg := sum / float64(period)
		out[i] = &avg
	}
	return out
}

func computeRSI(closes []float64, period int) []*float64 {
	out := make([]*float64, len(closes))
	if period < 1 || len(closes) < period+1 {
		return out
	}

	deltas := make([]float64, len(closes)-1)
	for i := 1; i < len(closes); i++ {
		deltas[i-1] = closes[i] - closes[i-1]
	}
	gains := make([]float64, len(deltas))
	losses := make([]float64, len(deltas))
	for i, d := range deltas {
		if d > 0 {
			gains[i] = d
		} else {
			losses[i] = -d
		}
	}

	avgGain, avgLoss := 0.0, 0.0
	for i := 0; i < period; i++ {
		avgGain += gains[i]
		avgLoss += losses[i]
	}
	avgGain /= float64(period)
	avgLoss /= float64(period)

	rsiAt := func(g, l float64) float64 {
		if l == 0 {
			return 100
		}
		rs := g / l
		return 100 - (100 / (1 + rs))
	}

	idx := period // index into `out` corresponding to closes[period]
	v := rsiAt(avgGain, avgLoss)
	out[idx] = &v

	for i := period; i < len(deltas); i++ {
		avgGain = (avgGain*float64(period-1) + gains[i]) / float64(period)
		avgLoss = (avgLoss*float64(period-1) + losses[i]) / float64(period)
		val := rsiAt(avgGain, avgLoss)
		out[i+1] = &val
	}
	return out
}

func computeATR(bars []OHLCVBar, period int) []*float64 {
	out := make([]*float64, len(bars))
	if period < 1 || len(bars) < 2 {
		return out
	}

	trueRanges := make([]float64, len(bars)-1)
	for i := 1; i < len(bars); i++ {
		high, low, prevClose := bars[i].High, bars[i].Low, bars[i-1].Close
		tr := high - low
		if v := abs(high - prevClose); v > tr {
			tr = v
		}
		if v := abs(low - prevClose); v > tr {
			tr = v
		}
		trueRanges[i-1] = tr
	}

	if len(trueRanges) < period {
		return out
	}

	atr := 0.0
	for i := 0; i < period; i++ {
		atr += trueRanges[i]
	}
	atr /= float64(period)
	idx := period
	v := atr
	out[idx] = &v

	for i := period; i < len(trueRanges); i++ {
		atr = (atr*float64(period-1) + trueRanges[i]) / float64(period)
		val := atr
		out[i+1] = &val
	}
	return out
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// ── JSON coercion helpers (Alpha Vantage returns everything as strings) ────────
func mdStr(v interface{}, def string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return def
}

func mdFloat(v interface{}) float64 {
	switch x := v.(type) {
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	case float64:
		return x
	}
	return 0
}

func mdInt(v interface{}) int64 {
	switch x := v.(type) {
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	case float64:
		return int64(x)
	}
	return 0
}

// ── Tool registration ───────────────────────────────────────────────────────────
func registerMarketDataTools() {
	registerGoTool("get_stock_quote", "Get the latest price quote for a stock ticker symbol.",
		map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"symbol": map[string]interface{}{"type": "string"}},
			"required":   []string{"symbol"},
		},
		func(input map[string]interface{}) (string, error) {
			symbol, _ := input["symbol"].(string)
			q, err := getStockQuote(symbol)
			if err != nil {
				return fmt.Sprintf("Error: %v", err), nil
			}
			return fmt.Sprintf("%s: $%.2f (%+.2f, %s%%) vol=%d as of %s",
				q.Symbol, q.Price, q.Change, q.ChangePct, q.Volume, q.LatestTradingDay), nil
		},
	)

	registerGoTool("get_stock_ohlcv", "Get historical daily/weekly/monthly OHLCV bars for a stock ticker.",
		map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"symbol":   map[string]interface{}{"type": "string"},
				"interval": map[string]interface{}{"type": "string"},
			},
			"required": []string{"symbol"},
		},
		func(input map[string]interface{}) (string, error) {
			symbol, _ := input["symbol"].(string)
			interval, _ := input["interval"].(string)
			if interval == "" {
				interval = "daily"
			}
			bars, err := getStockOHLCV(symbol, interval, "compact")
			if err != nil {
				return fmt.Sprintf("Error: %v", err), nil
			}
			start := 0
			if len(bars) > 10 {
				start = len(bars) - 10
			}
			recent := bars[start:]
			var sb strings.Builder
			fmt.Fprintf(&sb, "%s last %d bars:\n", symbol, len(recent))
			for _, b := range recent {
				fmt.Fprintf(&sb, "%s: O=%.2f H=%.2f L=%.2f C=%.2f V=%d\n", b.Date, b.Open, b.High, b.Low, b.Close, b.Volume)
			}
			return sb.String(), nil
		},
	)

	registerGoTool("get_crypto_quote", "Get the latest price for a cryptocurrency (use CoinGecko IDs like 'bitcoin', 'ethereum').",
		map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"coin_id":     map[string]interface{}{"type": "string"},
				"vs_currency": map[string]interface{}{"type": "string"},
			},
			"required": []string{"coin_id"},
		},
		func(input map[string]interface{}) (string, error) {
			coinID, _ := input["coin_id"].(string)
			vs, _ := input["vs_currency"].(string)
			if vs == "" {
				vs = "usd"
			}
			q, err := getCryptoQuote(coinID, vs)
			if err != nil {
				return fmt.Sprintf("Error: %v", err), nil
			}
			return fmt.Sprintf("%s: %.2f %s (%+.2f%% 24h) mcap=%.0f vol24h=%.0f",
				q.CoinID, q.Price, strings.ToUpper(q.VsCurrency), q.Change24hPct, q.MarketCap, q.Volume24h), nil
		},
	)

	registerGoTool("get_crypto_ohlcv", "Get historical OHLC data for a cryptocurrency over N days.",
		map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"coin_id":     map[string]interface{}{"type": "string"},
				"vs_currency": map[string]interface{}{"type": "string"},
				"days":        map[string]interface{}{"type": "integer"},
			},
			"required": []string{"coin_id"},
		},
		func(input map[string]interface{}) (string, error) {
			coinID, _ := input["coin_id"].(string)
			vs, _ := input["vs_currency"].(string)
			if vs == "" {
				vs = "usd"
			}
			days := 30
			if v, ok := input["days"].(float64); ok {
				days = int(v)
			}
			bars, err := getCryptoOHLCV(coinID, vs, days)
			if err != nil {
				return fmt.Sprintf("Error: %v", err), nil
			}
			start := 0
			if len(bars) > 10 {
				start = len(bars) - 10
			}
			recent := bars[start:]
			var sb strings.Builder
			fmt.Fprintf(&sb, "%s last %d bars:\n", coinID, len(recent))
			for _, b := range recent {
				fmt.Fprintf(&sb, "t=%d: O=%.2f H=%.2f L=%.2f C=%.2f\n", b.Timestamp, b.Open, b.High, b.Low, b.Close)
			}
			return sb.String(), nil
		},
	)

	registerGoTool("compute_indicators", "Compute SMA and RSI for a list of closing prices.",
		map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"closes":     map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "number"}},
				"sma_period": map[string]interface{}{"type": "integer"},
				"rsi_period": map[string]interface{}{"type": "integer"},
			},
			"required": []string{"closes"},
		},
		func(input map[string]interface{}) (string, error) {
			rawCloses, _ := input["closes"].([]interface{})
			closes := make([]float64, len(rawCloses))
			for i, v := range rawCloses {
				closes[i] = mdFloat(v)
			}
			smaPeriod := 20
			if v, ok := input["sma_period"].(float64); ok {
				smaPeriod = int(v)
			}
			rsiPeriod := 14
			if v, ok := input["rsi_period"].(float64); ok {
				rsiPeriod = int(v)
			}

			sma := computeSMA(closes, smaPeriod)
			rsi := computeRSI(closes, rsiPeriod)

			var parts []string
			for i := len(sma) - 1; i >= 0; i-- {
				if sma[i] != nil {
					parts = append(parts, fmt.Sprintf("SMA(%d)=%.2f", smaPeriod, *sma[i]))
					break
				}
			}
			for i := len(rsi) - 1; i >= 0; i-- {
				if rsi[i] != nil {
					parts = append(parts, fmt.Sprintf("RSI(%d)=%.1f", rsiPeriod, *rsi[i]))
					break
				}
			}
			if len(parts) == 0 {
				return "Not enough data points to compute indicators", nil
			}
			return strings.Join(parts, ", "), nil
		},
	)
}
