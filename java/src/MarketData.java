/**
 * Market Data — Java
 * Live stock and crypto market data via HTTP, registered as tools into ReactLoop.
 *
 * Stock data: Alpha Vantage (requires ALPHA_VANTAGE_API_KEY)
 * Crypto data: CoinGecko (no API key required for basic endpoints)
 * Cache:       in-memory TTL cache (MARKET_DATA_CACHE_TTL seconds, default 60)
 * Retry:       exponential backoff, 3 attempts per call
 */

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

public class MarketData {

    static final ObjectMapper JSON = new ObjectMapper();
    static final HttpClient   HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build();

    static final String ALPHA_VANTAGE_BASE = "https://www.alphavantage.co/query";
    static final String COINGECKO_BASE     = "https://api.coingecko.com/api/v3";
    static final long   CACHE_TTL_MS       = Long.parseLong(
        System.getenv().getOrDefault("MARKET_DATA_CACHE_TTL", "60")) * 1000L;

    static final Pattern SYMBOL_PATTERN  = Pattern.compile("^[A-Z0-9.\\-]+$");
    static final Pattern COIN_ID_PATTERN = Pattern.compile("^[a-z0-9\\-]+$");

    // ── TTL cache ─────────────────────────────────────────────────────────────
    record CacheEntry(Object value, long expiresAt) {}
    static final ConcurrentHashMap<String, CacheEntry> CACHE = new ConcurrentHashMap<>();

    static void cacheSet(String key, Object value) {
        CACHE.put(key, new CacheEntry(value, System.currentTimeMillis() + CACHE_TTL_MS));
    }

    @SuppressWarnings("unchecked")
    static <T> Optional<T> cacheGet(String key) {
        CacheEntry entry = CACHE.get(key);
        if (entry == null) return Optional.empty();
        if (System.currentTimeMillis() > entry.expiresAt()) { CACHE.remove(key); return Optional.empty(); }
        return Optional.of((T) entry.value());
    }

    // ── HTTP GET with exponential-backoff retry ────────────────────────────────
    static JsonNode getJson(String url) throws Exception {
        Exception lastErr = null;
        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(20))
                    .header("User-Agent", "rag-ai-monorepo/2.0")
                    .GET().build();
                HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
                if (resp.statusCode() < 200 || resp.statusCode() >= 300)
                    throw new RuntimeException("HTTP " + resp.statusCode() + ": " + resp.body().substring(0, Math.min(200, resp.body().length())));
                return JSON.readTree(resp.body());
            } catch (Exception e) {
                lastErr = e;
                if (attempt < 3) Thread.sleep(Math.min(1000L * (1L << attempt), 30_000L));
            }
        }
        throw new RuntimeException("API call failed after 3 attempts: " + lastErr.getMessage(), lastErr);
    }

    // ── Validation ────────────────────────────────────────────────────────────
    static String validateSymbol(String symbol) {
        String s = symbol.trim().toUpperCase();
        if (s.isEmpty() || !SYMBOL_PATTERN.matcher(s).matches())
            throw new IllegalArgumentException("Invalid ticker symbol: '" + symbol + "'");
        return s;
    }

    static String validateCoinId(String coinId) {
        String s = coinId.trim().toLowerCase();
        if (s.isEmpty() || !COIN_ID_PATTERN.matcher(s).matches())
            throw new IllegalArgumentException("Invalid coin id: '" + coinId + "'");
        return s;
    }

    // ── Stock Quote ───────────────────────────────────────────────────────────
    public record StockQuote(
        String symbol, double price, double change, String changePct,
        long volume, String latestTradingDay, double previousClose
    ) {}

    public static StockQuote getStockQuote(String symbolRaw) throws Exception {
        String sym = validateSymbol(symbolRaw);
        String apiKey = System.getenv("ALPHA_VANTAGE_API_KEY");
        if (apiKey == null || apiKey.isBlank())
            throw new IllegalStateException("ALPHA_VANTAGE_API_KEY environment variable is not set");

        String cacheKey = "quote:" + sym;
        Optional<StockQuote> cached = cacheGet(cacheKey);
        if (cached.isPresent()) return cached.get();

        String url = ALPHA_VANTAGE_BASE + "?function=GLOBAL_QUOTE&symbol=" + sym + "&apikey=" + apiKey;
        JsonNode data = getJson(url);
        JsonNode quote = data.path("Global Quote");

        if (quote.isEmpty())
            throw new RuntimeException("No quote data for '" + sym + "': " +
                (data.has("Note") ? data.get("Note").asText() :
                 data.has("Information") ? data.get("Information").asText() : "No data returned"));

        StockQuote result = new StockQuote(
            quote.path("01. symbol").asText(sym),
            quote.path("05. price").asDouble(0),
            quote.path("09. change").asDouble(0),
            quote.path("10. change percent").asText("0%").replace("%", ""),
            quote.path("06. volume").asLong(0),
            quote.path("07. latest trading day").asText(""),
            quote.path("08. previous close").asDouble(0)
        );
        cacheSet(cacheKey, result);
        return result;
    }

    // ── Stock OHLCV ───────────────────────────────────────────────────────────
    public record OHLCVBar(String date, double open, double high, double low, double close, long volume) {}

    public static List<OHLCVBar> getStockOHLCV(String symbolRaw, String interval, String outputSize) throws Exception {
        String sym = validateSymbol(symbolRaw);
        String apiKey = System.getenv("ALPHA_VANTAGE_API_KEY");
        if (apiKey == null || apiKey.isBlank())
            throw new IllegalStateException("ALPHA_VANTAGE_API_KEY environment variable is not set");

        Map<String, String> funcMap = Map.of(
            "daily", "TIME_SERIES_DAILY",
            "weekly", "TIME_SERIES_WEEKLY",
            "monthly", "TIME_SERIES_MONTHLY"
        );
        String func = funcMap.getOrDefault(interval, "TIME_SERIES_DAILY");
        String size = "full".equals(outputSize) ? "full" : "compact";

        String cacheKey = "ohlcv:" + sym + ":" + interval + ":" + size;
        Optional<List<OHLCVBar>> cached = cacheGet(cacheKey);
        if (cached.isPresent()) return cached.get();

        String url = ALPHA_VANTAGE_BASE + "?function=" + func + "&symbol=" + sym
            + "&outputsize=" + size + "&apikey=" + apiKey;
        JsonNode data = getJson(url);

        String tsKey = null;
        for (Iterator<String> it = data.fieldNames(); it.hasNext(); ) {
            String k = it.next();
            if (k.contains("Time Series")) { tsKey = k; break; }
        }
        if (tsKey == null)
            throw new RuntimeException("No OHLCV data for '" + sym + "': " +
                (data.has("Note") ? data.get("Note").asText() :
                 data.has("Information") ? data.get("Information").asText() : "No time series returned"));

        JsonNode series = data.get(tsKey);
        List<OHLCVBar> bars = new ArrayList<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = series.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            JsonNode bar = e.getValue();
            bars.add(new OHLCVBar(
                e.getKey(),
                bar.path("1. open").asDouble(0),
                bar.path("2. high").asDouble(0),
                bar.path("3. low").asDouble(0),
                bar.path("4. close").asDouble(0),
                bar.path("5. volume").asLong(0)
            ));
        }
        bars.sort(Comparator.comparing(OHLCVBar::date));
        cacheSet(cacheKey, bars);
        return bars;
    }

    // ── Crypto Quote ──────────────────────────────────────────────────────────
    public record CryptoQuote(
        String coinId, String vsCurrency, double price,
        double change24hPct, double marketCap, double volume24h
    ) {}

    public static CryptoQuote getCryptoQuote(String coinIdRaw, String vsCurrencyRaw) throws Exception {
        String cid = validateCoinId(coinIdRaw);
        String vs  = vsCurrencyRaw == null || vsCurrencyRaw.isBlank() ? "usd" : vsCurrencyRaw.trim().toLowerCase();

        String cacheKey = "crypto_quote:" + cid + ":" + vs;
        Optional<CryptoQuote> cached = cacheGet(cacheKey);
        if (cached.isPresent()) return cached.get();

        String url = COINGECKO_BASE + "/simple/price?ids=" + cid
            + "&vs_currencies=" + vs
            + "&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true";
        JsonNode data = getJson(url);
        JsonNode coinData = data.path(cid);
        if (coinData.isMissingNode() || coinData.isEmpty())
            throw new RuntimeException("No data for coin '" + cid + "' — check the CoinGecko coin ID is correct");

        CryptoQuote result = new CryptoQuote(
            cid, vs,
            coinData.path(vs).asDouble(0),
            coinData.path(vs + "_24h_change").asDouble(0),
            coinData.path(vs + "_market_cap").asDouble(0),
            coinData.path(vs + "_24h_vol").asDouble(0)
        );
        cacheSet(cacheKey, result);
        return result;
    }

    // ── Crypto OHLCV ─────────────────────────────────────────────────────────
    public record CryptoOHLCBar(long timestamp, double open, double high, double low, double close) {}

    public static List<CryptoOHLCBar> getCryptoOHLCV(String coinIdRaw, String vsCurrencyRaw, int days) throws Exception {
        String cid = validateCoinId(coinIdRaw);
        String vs  = vsCurrencyRaw == null || vsCurrencyRaw.isBlank() ? "usd" : vsCurrencyRaw.trim().toLowerCase();
        if (days < 1 || days > 365) throw new IllegalArgumentException("days must be between 1 and 365");

        String cacheKey = "crypto_ohlcv:" + cid + ":" + vs + ":" + days;
        Optional<List<CryptoOHLCBar>> cached = cacheGet(cacheKey);
        if (cached.isPresent()) return cached.get();

        String url = COINGECKO_BASE + "/coins/" + cid + "/ohlc?vs_currency=" + vs + "&days=" + days;
        JsonNode data = getJson(url);
        if (!data.isArray() || data.isEmpty())
            throw new RuntimeException("No OHLCV data for '" + cid + "'");

        List<CryptoOHLCBar> bars = new ArrayList<>();
        for (JsonNode row : data) {
            if (row.size() < 5) continue;
            bars.add(new CryptoOHLCBar(
                row.get(0).asLong(),
                row.get(1).asDouble(),
                row.get(2).asDouble(),
                row.get(3).asDouble(),
                row.get(4).asDouble()
            ));
        }
        cacheSet(cacheKey, bars);
        return bars;
    }

    // ── Technical indicators (pure computation, no network) ───────────────────
    public static double[] computeSMA(double[] closes, int period) {
        double[] out = new double[closes.length];
        Arrays.fill(out, Double.NaN);
        if (period < 1) return out;
        for (int i = period - 1; i < closes.length; i++) {
            double sum = 0;
            for (int j = i - period + 1; j <= i; j++) sum += closes[j];
            out[i] = sum / period;
        }
        return out;
    }

    public static double[] computeRSI(double[] closes, int period) {
        double[] out = new double[closes.length];
        Arrays.fill(out, Double.NaN);
        if (period < 1 || closes.length < period + 1) return out;

        double avgGain = 0, avgLoss = 0;
        for (int i = 1; i <= period; i++) {
            double delta = closes[i] - closes[i - 1];
            if (delta > 0) avgGain += delta; else avgLoss -= delta;
        }
        avgGain /= period;
        avgLoss /= period;
        out[period] = avgLoss == 0 ? 100.0 : 100.0 - 100.0 / (1.0 + avgGain / avgLoss);

        for (int i = period + 1; i < closes.length; i++) {
            double delta = closes[i] - closes[i - 1];
            double gain = Math.max(delta, 0), loss = Math.max(-delta, 0);
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            out[i] = avgLoss == 0 ? 100.0 : 100.0 - 100.0 / (1.0 + avgGain / avgLoss);
        }
        return out;
    }

    public static double[] computeATR(List<OHLCVBar> bars, int period) {
        double[] out = new double[bars.size()];
        Arrays.fill(out, Double.NaN);
        if (period < 1 || bars.size() < 2) return out;

        double[] tr = new double[bars.size() - 1];
        for (int i = 1; i < bars.size(); i++) {
            double high = bars.get(i).high(), low = bars.get(i).low(), prev = bars.get(i - 1).close();
            tr[i - 1] = Math.max(high - low, Math.max(Math.abs(high - prev), Math.abs(low - prev)));
        }
        if (tr.length < period) return out;

        double atr = 0;
        for (int i = 0; i < period; i++) atr += tr[i];
        atr /= period;
        out[period] = atr;
        for (int i = period; i < tr.length; i++) {
            atr = (atr * (period - 1) + tr[i]) / period;
            out[i + 1] = atr;
        }
        return out;
    }

    // ── Tool registration ─────────────────────────────────────────────────────
    public static void registerTools() {
        ReactLoop.registerTool(
            "get_stock_quote",
            "Get the latest price quote for a stock ticker symbol.",
            JSON.createObjectNode()
                .<ObjectNode>put("type", "object")
                .set("properties", JSON.createObjectNode()
                    .set("symbol", JSON.createObjectNode().put("type", "string"))),
            input -> {
                try {
                    StockQuote q = getStockQuote(input.path("symbol").asText(""));
                    return String.format("%s: $%.2f (%+.2f, %s%%) vol=%,d as of %s",
                        q.symbol(), q.price(), q.change(), q.changePct(), q.volume(), q.latestTradingDay());
                } catch (Exception e) { return "Error: " + e.getMessage(); }
            }
        );

        ReactLoop.registerTool(
            "get_stock_ohlcv",
            "Get historical daily/weekly/monthly OHLCV bars for a stock ticker.",
            JSON.createObjectNode()
                .<ObjectNode>put("type", "object")
                .set("properties", JSON.createObjectNode()
                    .set("symbol", JSON.createObjectNode().put("type", "string"))
                    .set("interval", JSON.createObjectNode().put("type", "string"))),
            input -> {
                try {
                    String sym = input.path("symbol").asText("");
                    String interval = input.path("interval").asText("daily");
                    List<OHLCVBar> bars = getStockOHLCV(sym, interval, "compact");
                    List<OHLCVBar> recent = bars.subList(Math.max(0, bars.size() - 10), bars.size());
                    StringBuilder sb = new StringBuilder(sym + " last " + recent.size() + " bars:\n");
                    for (OHLCVBar b : recent)
                        sb.append(String.format("%s: O=%.2f H=%.2f L=%.2f C=%.2f V=%,d%n",
                            b.date(), b.open(), b.high(), b.low(), b.close(), b.volume()));
                    return sb.toString().trim();
                } catch (Exception e) { return "Error: " + e.getMessage(); }
            }
        );

        ReactLoop.registerTool(
            "get_crypto_quote",
            "Get the latest price for a cryptocurrency (use CoinGecko IDs like 'bitcoin', 'ethereum').",
            JSON.createObjectNode()
                .<ObjectNode>put("type", "object")
                .set("properties", JSON.createObjectNode()
                    .set("coin_id", JSON.createObjectNode().put("type", "string"))
                    .set("vs_currency", JSON.createObjectNode().put("type", "string"))),
            input -> {
                try {
                    CryptoQuote q = getCryptoQuote(
                        input.path("coin_id").asText(""),
                        input.path("vs_currency").asText("usd")
                    );
                    return String.format("%s: %.2f %s (%+.2f%% 24h) mcap=%.0f vol24h=%.0f",
                        q.coinId(), q.price(), q.vsCurrency().toUpperCase(),
                        q.change24hPct(), q.marketCap(), q.volume24h());
                } catch (Exception e) { return "Error: " + e.getMessage(); }
            }
        );

        ReactLoop.registerTool(
            "get_crypto_ohlcv",
            "Get historical OHLC data for a cryptocurrency over N days.",
            JSON.createObjectNode()
                .<ObjectNode>put("type", "object")
                .set("properties", JSON.createObjectNode()
                    .set("coin_id", JSON.createObjectNode().put("type", "string"))
                    .set("vs_currency", JSON.createObjectNode().put("type", "string"))
                    .set("days", JSON.createObjectNode().put("type", "integer"))),
            input -> {
                try {
                    List<CryptoOHLCBar> bars = getCryptoOHLCV(
                        input.path("coin_id").asText(""),
                        input.path("vs_currency").asText("usd"),
                        input.path("days").asInt(30)
                    );
                    List<CryptoOHLCBar> recent = bars.subList(Math.max(0, bars.size() - 10), bars.size());
                    StringBuilder sb = new StringBuilder(input.path("coin_id").asText("") + " last " + recent.size() + " bars:\n");
                    for (CryptoOHLCBar b : recent)
                        sb.append(String.format("t=%d: O=%.2f H=%.2f L=%.2f C=%.2f%n",
                            b.timestamp(), b.open(), b.high(), b.low(), b.close()));
                    return sb.toString().trim();
                } catch (Exception e) { return "Error: " + e.getMessage(); }
            }
        );

        ReactLoop.registerTool(
            "compute_indicators",
            "Compute SMA and RSI for a list of closing prices.",
            JSON.createObjectNode()
                .<ObjectNode>put("type", "object")
                .set("properties", JSON.createObjectNode()
                    .set("closes", JSON.createObjectNode().put("type", "array"))
                    .set("sma_period", JSON.createObjectNode().put("type", "integer"))
                    .set("rsi_period", JSON.createObjectNode().put("type", "integer"))),
            input -> {
                try {
                    JsonNode closesNode = input.path("closes");
                    double[] closes = new double[closesNode.size()];
                    for (int i = 0; i < closesNode.size(); i++) closes[i] = closesNode.get(i).asDouble();
                    int smaPeriod = input.path("sma_period").asInt(20);
                    int rsiPeriod = input.path("rsi_period").asInt(14);

                    double[] sma = computeSMA(closes, smaPeriod);
                    double[] rsi = computeRSI(closes, rsiPeriod);

                    List<String> parts = new ArrayList<>();
                    for (int i = sma.length - 1; i >= 0; i--) {
                        if (!Double.isNaN(sma[i])) { parts.add(String.format("SMA(%d)=%.2f", smaPeriod, sma[i])); break; }
                    }
                    for (int i = rsi.length - 1; i >= 0; i--) {
                        if (!Double.isNaN(rsi[i])) { parts.add(String.format("RSI(%d)=%.1f", rsiPeriod, rsi[i])); break; }
                    }
                    return parts.isEmpty() ? "Not enough data points to compute indicators" : String.join(", ", parts);
                } catch (Exception e) { return "Error: " + e.getMessage(); }
            }
        );
    }
}
