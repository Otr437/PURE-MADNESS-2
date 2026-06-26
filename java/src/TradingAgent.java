/**
 * Trading Agent — Java
 * Wires MarketData, RAG strategy knowledge, and BacktestEngine into the ReAct
 * loop. Mirrors trading_agent.py safety contract exactly:
 *   - order_propose registered as a tool → drafts only, never executes
 *   - orderExecuteIBKR NOT registered as a tool → requires explicit human confirm=true
 *   - IBKR_LIVE_TRADING env var required for live mode (defaults to PAPER)
 *
 * CLI:
 *   java TradingAgent --task "Backtest SMA crossover on AAPL"
 *   java TradingAgent --max-iterations 20 --skip-ingest
 */

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class TradingAgent {

    static final ObjectMapper JSON = new ObjectMapper();

    static final String TRADING_SYSTEM_PROMPT =
        "You are a trading research assistant. You have access to:\n" +
        "- rag_search: a knowledge base of trading strategy theory (momentum, mean reversion, breakout, crypto-specific, risk management)\n" +
        "- get_stock_quote / get_stock_ohlcv: live and historical stock market data\n" +
        "- get_crypto_quote / get_crypto_ohlcv: live and historical cryptocurrency market data\n" +
        "- compute_indicators: SMA, RSI calculations\n" +
        "- run_backtest: test a named strategy preset against historical data and report performance metrics\n" +
        "- order_propose: draft a proposed order for human review — this NEVER executes a trade\n\n" +
        "CRITICAL SAFETY RULE: You can never execute trades. You can only use order_propose to draft\n" +
        "an order for a human to review and execute manually. If asked to \"buy\", \"sell\", \"execute\",\n" +
        "or \"place an order\", you must use order_propose, clearly state the order is a PROPOSAL\n" +
        "requiring human confirmation, and never claim a trade has been executed.\n\n" +
        "When researching a strategy, search the knowledge base first to ground your reasoning in\n" +
        "established strategy theory, then pull live or historical data to evaluate it, then\n" +
        "backtest if asked. Always cite which strategy concept underlies your reasoning.";

    // ── Order proposal (safety boundary — drafts only, never executes) ─────────
    public record OrderProposal(
        String proposalId,
        String symbol,
        String side,
        double quantity,
        String orderType,
        Double limitPrice,
        String assetClass,
        String rationale,
        String status
    ) {}

    static final ConcurrentHashMap<String, OrderProposal> PROPOSALS = new ConcurrentHashMap<>();

    public static OrderProposal proposeOrder(
        String symbol, String side, double quantity,
        String assetClass, String orderType, Double limitPrice, String rationale
    ) {
        if (!"buy".equals(side) && !"sell".equals(side))
            throw new IllegalArgumentException("side must be 'buy' or 'sell', got '" + side + "'");
        if (quantity <= 0)
            throw new IllegalArgumentException("quantity must be positive");
        if ("limit".equals(orderType) && limitPrice == null)
            throw new IllegalArgumentException("limitPrice is required for limit orders");

        String id = UUID.randomUUID().toString();
        OrderProposal proposal = new OrderProposal(
            id,
            symbol.trim().toUpperCase(),
            side,
            quantity,
            orderType == null || orderType.isBlank() ? "market" : orderType,
            limitPrice,
            assetClass == null || assetClass.isBlank() ? "equity" : assetClass,
            rationale,
            "PROPOSED — REQUIRES HUMAN CONFIRMATION"
        );
        PROPOSALS.put(id, proposal);
        log("INFO", "trading_agent.order_proposed", Map.of(
            "proposal_id", id, "symbol", proposal.symbol(),
            "side", side, "quantity", String.valueOf(quantity)));
        return proposal;
    }

    public static Optional<OrderProposal> getProposal(String proposalId) {
        return Optional.ofNullable(PROPOSALS.get(proposalId));
    }

    // ── IBKR execution (NOT registered as an agent tool — explicit opt-in only) ─
    public record ExecutionResult(
        String proposalId, String mode, String status, OrderProposal order, String note
    ) {}

    /**
     * Execute a previously-drafted order proposal via Interactive Brokers.
     * NOT registered in ReactLoop.TOOLS — the agent cannot call this autonomously.
     * Must be invoked directly by human-reviewed calling code after explicit review.
     *
     * @param confirm must be Boolean.TRUE — any other value, including null, is rejected
     */
    public static ExecutionResult orderExecuteIBKR(String proposalId, boolean confirm) {
        if (!confirm)
            throw new SecurityException(
                "Execution requires confirm=true from a human-reviewed call site. " +
                "This is not optional and has no default override.");

        OrderProposal proposal = PROPOSALS.get(proposalId);
        if (proposal == null)
            throw new IllegalArgumentException(
                "No proposal found with id '" + proposalId + "' — it may have expired or never existed");

        boolean liveTrading = "true".equalsIgnoreCase(System.getenv("IBKR_LIVE_TRADING"));
        String mode = liveTrading ? "LIVE" : "PAPER";

        if (liveTrading) {
            log("WARN", "trading_agent.LIVE_ORDER_EXECUTION", Map.of(
                "proposal_id", proposalId, "symbol", proposal.symbol(), "mode", mode));
        } else {
            log("INFO", "trading_agent.paper_order_execution", Map.of(
                "proposal_id", proposalId, "symbol", proposal.symbol(), "mode", mode));
        }

        return new ExecutionResult(
            proposalId, mode, "READY_FOR_BROKER_SUBMISSION", proposal,
            "This function validated and logged the confirmed order. Actual broker " +
            "submission happens via the IBKR MCP connector at the integration layer, " +
            "which must be invoked separately by the calling application."
        );
    }

    // ── RAG engine singleton for trading knowledge ─────────────────────────────
    static volatile RagEngine tradingEngine;
    static final Object ENGINE_LOCK = new Object();

    static RagEngine getTradingEngine() throws Exception {
        if (tradingEngine == null) {
            synchronized (ENGINE_LOCK) {
                if (tradingEngine == null)
                    tradingEngine = new RagEngine("trading_strategies");
            }
        }
        return tradingEngine;
    }

    // ── Tool registration ─────────────────────────────────────────────────────
    public static void registerTools() throws Exception {
        MarketData.registerTools();
        RagEngine engine = getTradingEngine();

        // rag_search — wired to the trading knowledge base
        if (!ReactLoop.TOOLS.containsKey("rag_search")) {
            ReactLoop.registerTool(
                "rag_search",
                "Search the trading strategy knowledge base for theory on momentum, mean reversion, breakout, crypto, and risk management.",
                JSON.createObjectNode()
                    .<ObjectNode>put("type", "object")
                    .set("properties", JSON.createObjectNode()
                        .set("query", JSON.createObjectNode().put("type", "string"))
                        .set("top_k", JSON.createObjectNode().put("type", "integer"))),
                input -> {
                    try {
                        String query = input.path("query").asText("");
                        int topK = input.path("top_k").asInt(5);
                        return engine.retrieveAsContext(query, topK);
                    } catch (Exception e) { return "Error: " + e.getMessage(); }
                }
            );
        }

        // run_backtest — runs one of three preset strategies against live OHLCV
        ReactLoop.registerTool(
            "run_backtest",
            "Backtest a named strategy preset against historical OHLCV data. Presets: sma_crossover, rsi_mean_reversion, breakout.",
            JSON.createObjectNode()
                .<ObjectNode>put("type", "object")
                .set("properties", JSON.createObjectNode()
                    .set("symbol",                JSON.createObjectNode().put("type", "string"))
                    .set("asset_class",           JSON.createObjectNode().put("type", "string"))
                    .set("strategy",              JSON.createObjectNode().put("type", "string"))
                    .set("lookback_days_or_size", JSON.createObjectNode().put("type", "string"))),
            input -> {
                try {
                    String symbol     = input.path("symbol").asText("");
                    String strategy   = input.path("strategy").asText("");
                    String assetClass = input.path("asset_class").asText("equity");
                    String lookback   = input.path("lookback_days_or_size").asText("compact");

                    List<MarketData.OHLCVBar> bars;
                    int barsPerYear;
                    if ("crypto".equals(assetClass)) {
                        int days = 90;
                        try { days = Integer.parseInt(lookback); } catch (NumberFormatException ignored) {}
                        List<MarketData.CryptoOHLCBar> cb = MarketData.getCryptoOHLCV(symbol, "usd", days);
                        bars = cb.stream().map(b -> new MarketData.OHLCVBar(
                            String.valueOf(b.timestamp()), b.open(), b.high(), b.low(), b.close(), 0
                        )).toList();
                        barsPerYear = 365;
                    } else {
                        String size = "full".equals(lookback) ? "full" : "compact";
                        bars = MarketData.getStockOHLCV(symbol, "daily", size);
                        barsPerYear = 252;
                    }

                    BacktestEngine.SignalFn signalFn = switch (strategy) {
                        case "sma_crossover"      -> BacktestEngine.makeSMACrossoverSignal(0, 0);
                        case "rsi_mean_reversion" -> BacktestEngine.makeRSIMeanReversionSignal(0, 0, 0);
                        case "breakout"            -> BacktestEngine.makeBreakoutSignal(0);
                        default -> throw new IllegalArgumentException(
                            "Unknown strategy '" + strategy + "'. Available: sma_crossover, rsi_mean_reversion, breakout");
                    };

                    BacktestEngine.BacktestResult result = BacktestEngine.runBacktest(
                        bars, signalFn, BacktestEngine.BacktestOptions.withBarsPerYear(barsPerYear)
                    );

                    return String.format(
                        "Backtest of '%s' on %s (%d bars):\n" +
                        "  Total Return: %.2f%%\n  Annualized Return: %.2f%%\n  Sharpe Ratio: %.2f\n" +
                        "  Max Drawdown: %.2f%%\n  Win Rate: %.1f%% (%d trades)\n" +
                        "  Avg Trade: %.2f%% | Best: %.2f%% | Worst: %.2f%%",
                        strategy, symbol.toUpperCase(), bars.size(),
                        result.totalReturnPct(), result.annualizedReturnPct(), result.sharpeRatio(),
                        result.maxDrawdownPct(), result.winRatePct(), result.numTrades(),
                        result.avgTradePct(), result.bestTradePct(), result.worstTradePct()
                    );
                } catch (Exception e) { return "Backtest failed: " + e.getMessage(); }
            }
        );

        // order_propose — drafts only, never executes
        ReactLoop.registerTool(
            "order_propose",
            "Draft a proposed order for human review. NEVER executes a trade — only creates a proposal that requires explicit human confirmation to execute.",
            JSON.createObjectNode()
                .<ObjectNode>put("type", "object")
                .set("properties", JSON.createObjectNode()
                    .set("symbol",      JSON.createObjectNode().put("type", "string"))
                    .set("side",        JSON.createObjectNode().put("type", "string"))
                    .set("quantity",    JSON.createObjectNode().put("type", "number"))
                    .set("asset_class", JSON.createObjectNode().put("type", "string"))
                    .set("order_type",  JSON.createObjectNode().put("type", "string"))
                    .set("limit_price", JSON.createObjectNode().put("type", "number"))
                    .set("rationale",   JSON.createObjectNode().put("type", "string"))),
            input -> {
                try {
                    String symbol     = input.path("symbol").asText("");
                    String side       = input.path("side").asText("");
                    double quantity   = input.path("quantity").asDouble(0);
                    String assetClass = input.path("asset_class").asText("equity");
                    String orderType  = input.path("order_type").asText("market");
                    Double limitPrice = input.has("limit_price") ? input.path("limit_price").asDouble() : null;
                    String rationale  = input.path("rationale").asText("");

                    OrderProposal proposal = proposeOrder(symbol, side, quantity, assetClass, orderType, limitPrice, rationale);
                    String priceStr = "limit".equals(orderType)
                        ? String.format("@ limit $%.2f", limitPrice)
                        : "@ market";

                    return String.format(
                        "ORDER PROPOSAL (id=%s) — %s\n  %s %.4g %s (%s) %s\n  Rationale: %s\n" +
                        "  This is a draft only. No order has been placed. A human must explicitly " +
                        "confirm and execute this proposal via the trading platform.",
                        proposal.proposalId(), proposal.status(),
                        side.toUpperCase(), quantity, symbol.toUpperCase(), orderType, priceStr, rationale
                    );
                } catch (IllegalArgumentException e) {
                    return "Error: invalid order parameters — " + e.getMessage();
                }
            }
        );

        log("INFO", "trading_agent.tools_registered", Map.of("total_tools", String.valueOf(ReactLoop.TOOLS.size())));
    }

    // ── Strategy knowledge ingestion ──────────────────────────────────────────
    public static int ingestStrategyKnowledge(String knowledgeDir) throws Exception {
        Path dir = knowledgeDir != null && !knowledgeDir.isBlank()
            ? Paths.get(knowledgeDir)
            : Paths.get(System.getProperty("user.dir"), "..", "..", "..", "knowledge", "trading_strategies").normalize();

        if (!dir.toFile().isDirectory()) {
            log("WARN", "trading_agent.knowledge_dir_missing", Map.of("path", dir.toString()));
            return 0;
        }

        List<RagEngine.Document> docs = Loaders.loadDirectory(dir, true);
        if (docs.isEmpty()) {
            log("WARN", "trading_agent.no_strategy_docs_found", Map.of("path", dir.toString()));
            return 0;
        }

        RagEngine engine = getTradingEngine();
        int count = engine.ingest(docs);
        log("INFO", "trading_agent.strategy_knowledge_ingested", Map.of(
            "docs", String.valueOf(docs.size()), "chunks", String.valueOf(count)));
        return count;
    }

    // ── Structured logging helper ──────────────────────────────────────────────
    static void log(String level, String event, Map<String, String> fields) {
        try {
            ObjectNode node = JSON.createObjectNode();
            node.put("timestamp", java.time.Instant.now().toString());
            node.put("level",   level);
            node.put("service", "trading-agent-java");
            node.put("event",   event);
            fields.forEach(node::put);
            System.err.println(JSON.writeValueAsString(node));
        } catch (Exception ignored) {
            System.err.println("{\"level\":\"" + level + "\",\"event\":\"" + event + "\"}");
        }
    }

    // ── CLI entry point ────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        String task = "Search the knowledge base for momentum strategies, then explain how a 50/200 SMA crossover works and what its main risk is.";
        int maxIterations = 20;
        boolean skipIngest = false;

        for (int i = 0; i < args.length; i++) {
            if ("--task".equals(args[i]) && i + 1 < args.length) { task = args[++i]; }
            else if ("--max-iterations".equals(args[i]) && i + 1 < args.length) { maxIterations = Integer.parseInt(args[++i]); }
            else if ("--skip-ingest".equals(args[i])) { skipIngest = true; }
        }

        if (!skipIngest) {
            try { ingestStrategyKnowledge(null); }
            catch (Exception e) { log("WARN", "trading_agent.ingest_warning", Map.of("error", e.getMessage())); }
        }

        registerTools();

        ReactLoop.ReactResult result = ReactLoop.runReact(task, TRADING_SYSTEM_PROMPT, maxIterations, null);

        System.out.println("\n" + "=".repeat(64));
        System.out.println("TRADING AGENT — FINAL ANSWER");
        System.out.println("=".repeat(64));
        System.out.println(result.answer);
        System.out.println("=".repeat(64));
        System.out.printf("Iterations: %d | Tokens: %d | Time: %dms%n",
            result.trace.iterations, result.trace.totalTokens, result.trace.elapsedMs);

        if (!PROPOSALS.isEmpty()) {
            System.out.printf("%n%d order proposal(s) drafted this session (none executed):%n", PROPOSALS.size());
            for (OrderProposal p : PROPOSALS.values()) {
                System.out.printf("  - %s %s %.4g %s (%s) — %s%n",
                    p.side().toUpperCase(), p.symbol(), p.quantity(), p.orderType(),
                    p.assetClass(), p.proposalId());
            }
        }
    }
}
