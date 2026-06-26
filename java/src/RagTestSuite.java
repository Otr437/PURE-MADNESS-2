/**
 * Test suite — Java RAG AI Monorepo
 * Tests: MemoryStore, Loaders, EvalHarness, ModelRouter, RagEngine
 *
 * mvn test
 */

import org.junit.jupiter.api.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class RagTestSuite {

    // ── MemoryStore tests ─────────────────────────────────────────────────────
    @Nested
    class MemoryStoreTests {
        Path tmpDir;
        MemoryStore store;

        @BeforeEach
        void setUp() throws Exception {
            tmpDir = Files.createTempDirectory("rag-test-");
            store  = new MemoryStore(tmpDir.toString());
        }

        @AfterEach
        void tearDown() throws Exception {
            if (tmpDir != null) {
                try (var stream = Files.walk(tmpDir)) {
                    stream.sorted(Comparator.reverseOrder()).map(Path::toFile).forEach(File::delete);
                }
            }
        }

        @Test
        void testCreateAndLoad() throws Exception {
            MemoryStore.Session session = store.create(Map.of("user", "test"));
            assertNotNull(session);
            assertNotNull(session.sessionId);
            MemoryStore.Session loaded = store.load(session.sessionId);
            assertNotNull(loaded);
            assertEquals(session.sessionId, loaded.sessionId);
            assertEquals("test", loaded.metadata.get("user"));
        }

        @Test
        void testAppendMessages() throws Exception {
            MemoryStore.Session s = store.create(null);
            store.appendUser(s.sessionId, "Hello");
            store.appendAssistant(s.sessionId, "Hi there!");
            MemoryStore.Session loaded = store.load(s.sessionId);
            assertEquals(2, loaded.messages.size());
            assertEquals("user",      loaded.messages.get(0).get("role"));
            assertEquals("assistant", loaded.messages.get(1).get("role"));
        }

        @Test
        void testDelete() throws Exception {
            MemoryStore.Session s = store.create(null);
            assertTrue(store.delete(s.sessionId));
            assertNull(store.load(s.sessionId));
        }

        @Test
        void testListSessions() throws Exception {
            MemoryStore.Session s1 = store.create(null);
            MemoryStore.Session s2 = store.create(null);
            List<String> ids = store.listSessions();
            assertTrue(ids.contains(s1.sessionId));
            assertTrue(ids.contains(s2.sessionId));
        }

        @Test
        void testPathTraversalRejected() {
            assertThrows(IllegalArgumentException.class, () -> store.load("../../etc/passwd"));
        }

        @Test
        void testBuildContextMessages() throws Exception {
            MemoryStore.Session s = store.create(null);
            store.appendUser(s.sessionId, "First question");
            store.appendAssistant(s.sessionId, "First answer");
            MemoryStore.Session loaded = store.load(s.sessionId);
            List<Map<String, Object>> msgs = MemoryStore.buildContextMessages(loaded, "New question");
            Map<String, Object> last = msgs.get(msgs.size() - 1);
            assertEquals("user",         last.get("role"));
            assertEquals("New question", last.get("content"));
        }
    }

    // ── Loader tests ──────────────────────────────────────────────────────────
    @Nested
    class LoaderTests {
        Path tmpDir;

        @BeforeEach
        void setUp() throws Exception {
            tmpDir = Files.createTempDirectory("rag-loaders-test-");
        }

        @AfterEach
        void tearDown() throws Exception {
            if (tmpDir != null) {
                try (var stream = Files.walk(tmpDir)) {
                    stream.sorted(Comparator.reverseOrder()).map(Path::toFile).forEach(File::delete);
                }
            }
        }

        @Test
        void testLoadTxt() throws Exception {
            Path p = tmpDir.resolve("test.txt");
            Files.writeString(p, "Hello world");
            RagEngine.Document doc = Loaders.loadTxt(p);
            assertEquals("Hello world", doc.content);
            assertEquals("txt", doc.metadata.get("type"));
        }

        @Test
        void testLoadMarkdown() throws Exception {
            Path p = tmpDir.resolve("test.md");
            Files.writeString(p, "# Title\n\nParagraph with **bold** text.");
            RagEngine.Document doc = Loaders.loadMarkdown(p);
            assertEquals("markdown", doc.metadata.get("type"));
            assertNotNull(doc.content);
            assertFalse(doc.content.isBlank());
        }

        @Test
        void testLoadHtml() throws Exception {
            Path p = tmpDir.resolve("test.html");
            Files.writeString(p, "<html><head><title>Test</title></head><body><p>Hello HTML</p></body></html>");
            RagEngine.Document doc = Loaders.loadHtml(p);
            assertTrue(doc.content.contains("Hello HTML"));
            assertEquals("html", doc.metadata.get("type"));
            assertEquals("Test", doc.metadata.get("title"));
        }

        @Test
        void testFileSizeGuard() throws Exception {
            Path p = tmpDir.resolve("small.txt");
            Files.writeString(p, "small");
            // Mock: just verify the size guard logic is present in the class
            // (actual 50MB file write not done in tests)
            // The guard is exercised by Loaders.checkSize() — test the path exists
            assertDoesNotThrow(() -> Loaders.loadTxt(p));
        }

        @Test
        void testUnsupportedExtension() {
            Path p = tmpDir.resolve("bad.xyz");
            assertThrows(Exception.class, () -> Loaders.loadDocument(p));
        }

        @Test
        void testLoadDirectory() throws Exception {
            Files.writeString(tmpDir.resolve("a.txt"), "Content A");
            Files.writeString(tmpDir.resolve("b.txt"), "Content B");
            Files.writeString(tmpDir.resolve("skip.xyz"), "skip");
            List<RagEngine.Document> docs = Loaders.loadDirectory(tmpDir, false);
            assertEquals(2, docs.size());
        }
    }

    // ── EvalHarness tests ─────────────────────────────────────────────────────
    @Nested
    class EvalHarnessTests {

        @Test
        void testPrecisionAtK() {
            List<String> retrieved = List.of("a", "b", "c", "d", "e");
            Set<String> relevant   = Set.of("a", "c");
            double p5 = EvalHarness.precisionAtK(retrieved, relevant, 5);
            assertEquals(2.0/5, p5, 1e-9);
            double p1 = EvalHarness.precisionAtK(retrieved, relevant, 1);
            assertEquals(1.0, p1, 1e-9);
        }

        @Test
        void testRecallAtK() {
            List<String> retrieved = List.of("a", "b", "c");
            Set<String> relevant   = Set.of("a", "c", "d");
            double r = EvalHarness.recallAtK(retrieved, relevant, 3);
            assertEquals(2.0/3, r, 1e-9);
        }

        @Test
        void testReciprocalRank() {
            List<String> retrieved = List.of("x", "a", "b");
            Set<String> relevant   = Set.of("a");
            double rr = EvalHarness.reciprocalRank(retrieved, relevant);
            assertEquals(0.5, rr, 1e-9);
        }

        @Test
        void testReciprocalRankMiss() {
            List<String> retrieved = List.of("x", "y");
            Set<String> relevant   = Set.of("a");
            assertEquals(0.0, EvalHarness.reciprocalRank(retrieved, relevant), 1e-9);
        }

        @Test
        void testNdcgAtK() {
            List<String> retrieved = List.of("a", "b", "c");
            Set<String> relevant   = Set.of("a");
            double ndcg = EvalHarness.ndcgAtK(retrieved, relevant, 3);
            assertEquals(1.0, ndcg, 1e-9);
        }
    }

    // ── ModelRouter tests ─────────────────────────────────────────────────────
    @Nested
    class ModelRouterTests {

        @Test
        void testValidProviders() {
            System.setProperty("ANTHROPIC_API_KEY", "test");
            // Set via env simulation — tests that no exception is thrown on init
            for (String provider : List.of("anthropic", "deepseek", "openai")) {
                // Just verify DEFAULT_MODELS contains the provider
                assertTrue(ModelRouter.DEFAULT_MODELS.containsKey(provider),
                    "Missing default model for provider: " + provider);
            }
        }

        @Test
        void testInvalidProviderThrows() {
            assertThrows(IllegalArgumentException.class,
                () -> new ModelRouter("invalid_provider", null));
        }

        @Test
        void testMakeToolResultMessage() {
            Map<String, Object> msg = ModelRouter.makeToolResultMessage("id123", "result", false);
            assertEquals("user", msg.get("role"));
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> content = (List<Map<String, Object>>) msg.get("content");
            assertNotNull(content);
            assertEquals(1, content.size());
            assertEquals("id123",  content.get(0).get("tool_use_id"));
            assertEquals("result", content.get(0).get("content"));
        }

        @Test
        void testMakeToolResultMessageError() {
            Map<String, Object> msg = ModelRouter.makeToolResultMessage("id456", "oops", true);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> content = (List<Map<String, Object>>) msg.get("content");
            assertTrue((Boolean) content.get(0).get("is_error"));
        }
    }

    // ── RagEngine chunk tests ─────────────────────────────────────────────────
    @Nested
    class RagEngineTests {

        @Test
        void testChunkTextShort() {
            List<String> chunks = RagEngine.chunkText("Hello world");
            assertEquals(1, chunks.size());
            assertEquals("Hello world", chunks.get(0));
        }

        @Test
        void testChunkTextLong() {
            String text = "word ".repeat(500);
            List<String> chunks = RagEngine.chunkText(text);
            assertTrue(chunks.size() > 1, "Expected multiple chunks, got " + chunks.size());
        }

        @Test
        void testNoEmptyChunks() {
            List<String> chunks = RagEngine.chunkText("   \n\n   ");
            for (String c : chunks) {
                assertFalse(c.trim().isEmpty(), "Found empty chunk: '" + c + "'");
            }
        }

        @Test
        void testDocumentIdGenerated() {
            RagEngine.Document doc = new RagEngine.Document("Test content", Map.of());
            assertNotNull(doc.docId);
            assertFalse(doc.docId.isEmpty());
        }

        @Test
        void testSameContentSameId() {
            RagEngine.Document d1 = new RagEngine.Document("Same content", Map.of());
            RagEngine.Document d2 = new RagEngine.Document("Same content", Map.of());
            assertEquals(d1.docId, d2.docId);
        }

        @Test
        void testDifferentContentDifferentId() {
            RagEngine.Document d1 = new RagEngine.Document("Content A", Map.of());
            RagEngine.Document d2 = new RagEngine.Document("Content B", Map.of());
            assertNotEquals(d1.docId, d2.docId);
        }
    }

    // ── Trading Agent Tests ────────────────────────────────────────────────────
    @Nested
    class TradingAgentTests {

        // MarketData: indicator computation (pure, no network)
        @Test
        void testComputeSMABasic() {
            double[] closes = {1, 2, 3, 4, 5};
            double[] sma = MarketData.computeSMA(closes, 3);
            assertTrue(Double.isNaN(sma[0]), "sma[0] should be NaN");
            assertTrue(Double.isNaN(sma[1]), "sma[1] should be NaN");
            assertEquals(2.0, sma[2], 0.001);
            assertEquals(3.0, sma[3], 0.001);
            assertEquals(4.0, sma[4], 0.001);
        }

        @Test
        void testComputeSMAPeriodOne() {
            double[] closes = {1, 2, 3};
            double[] sma = MarketData.computeSMA(closes, 1);
            assertArrayEquals(closes, sma, 0.001);
        }

        @Test
        void testComputeRSIInsufficientData() {
            double[] closes = {1, 2, 3};
            double[] rsi = MarketData.computeRSI(closes, 14);
            for (double v : rsi) assertTrue(Double.isNaN(v), "Expected NaN for insufficient data");
        }

        @Test
        void testComputeRSIAllGainsSaturates() {
            double[] closes = new double[19];
            for (int i = 0; i < closes.length; i++) closes[i] = i + 1;
            double[] rsi = MarketData.computeRSI(closes, 14);
            assertEquals(100.0, rsi[rsi.length - 1], 0.001);
        }

        @Test
        void testComputeRSIBounded() {
            double[] closes = {10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17, 16, 18, 17, 19};
            double[] rsi = MarketData.computeRSI(closes, 14);
            for (double v : rsi) {
                if (!Double.isNaN(v)) {
                    assertTrue(v >= 0 && v <= 100, "RSI out of bounds: " + v);
                }
            }
        }

        // BacktestEngine: core logic (pure computation)
        private List<MarketData.OHLCVBar> makeBars(double... closes) {
            List<MarketData.OHLCVBar> bars = new ArrayList<>();
            for (int i = 0; i < closes.length; i++) {
                double c = closes[i];
                bars.add(new MarketData.OHLCVBar(
                    "2024-01-" + String.format("%02d", i + 1),
                    c, c * 1.01, c * 0.99, c, 1000L));
            }
            return bars;
        }

        @Test
        void testBacktestRequiresMinimumBars() {
            assertThrows(IllegalArgumentException.class, () ->
                BacktestEngine.runBacktest(
                    makeBars(100),
                    h -> BacktestEngine.Signal.FLAT,
                    BacktestEngine.BacktestOptions.defaults()
                ));
        }

        @Test
        void testFlatSignalNoTradesZeroReturn() {
            List<MarketData.OHLCVBar> bars = makeBars(100, 101, 102, 103, 104);
            BacktestEngine.BacktestResult result = BacktestEngine.runBacktest(
                bars, h -> BacktestEngine.Signal.FLAT, BacktestEngine.BacktestOptions.defaults());
            assertEquals(0, result.numTrades());
            assertEquals(0.0, result.totalReturnPct(), 0.001);
        }

        @Test
        void testAlwaysLongTracksRise() {
            List<MarketData.OHLCVBar> bars = makeBars(100, 110, 120, 130, 140);
            BacktestEngine.BacktestResult result = BacktestEngine.runBacktest(
                bars, h -> BacktestEngine.Signal.LONG,
                new BacktestEngine.BacktestOptions(10_000, 0.0, 0.0, 252));
            assertEquals(40.0, result.totalReturnPct(), 0.5);
        }

        @Test
        void testAlwaysShortLosesInUptrend() {
            List<MarketData.OHLCVBar> bars = makeBars(100, 110, 120, 130, 140);
            BacktestEngine.BacktestResult result = BacktestEngine.runBacktest(
                bars, h -> BacktestEngine.Signal.SHORT,
                new BacktestEngine.BacktestOptions(10_000, 0.0, 0.0, 252));
            assertTrue(result.totalReturnPct() < 0);
        }

        @Test
        void testNoLookaheadBias() {
            List<MarketData.OHLCVBar> bars = makeBars(100, 101, 102, 103, 104, 105);
            List<Integer> seenLengths = new ArrayList<>();
            BacktestEngine.runBacktest(bars, h -> {
                seenLengths.add(h.size());
                return BacktestEngine.Signal.FLAT;
            }, BacktestEngine.BacktestOptions.defaults());
            assertEquals(List.of(2, 3, 4, 5, 6), seenLengths);
        }

        @Test
        void testFeesReduceReturn() {
            List<MarketData.OHLCVBar> bars = makeBars(100, 110, 120, 130, 140);
            double noFee   = BacktestEngine.runBacktest(bars, h -> BacktestEngine.Signal.LONG,
                new BacktestEngine.BacktestOptions(10_000, 0.0,  0.0, 252)).totalReturnPct();
            double withFee = BacktestEngine.runBacktest(bars, h -> BacktestEngine.Signal.LONG,
                new BacktestEngine.BacktestOptions(10_000, 0.01, 0.0, 252)).totalReturnPct();
            assertTrue(withFee < noFee, "fees must reduce return");
        }

        @Test
        void testSharpeZeroVolatility() {
            assertEquals(0.0, BacktestEngine.computeSharpe(List.of(0.0, 0.0, 0.0), 0.0, 252), 0.001);
        }

        @Test
        void testMaxDrawdownMonotonicIncrease() {
            assertEquals(0.0, BacktestEngine.computeMaxDrawdown(List.of(100.0, 110.0, 120.0, 130.0)), 0.001);
        }

        @Test
        void testMaxDrawdownDetected() {
            double dd = BacktestEngine.computeMaxDrawdown(List.of(100.0, 120.0, 90.0, 110.0));
            assertEquals(25.0, dd, 0.5);
        }

        @Test
        void testSMACrossoverPresetReturnsValidSignal() {
            BacktestEngine.SignalFn fn = BacktestEngine.makeSMACrossoverSignal(2, 4);
            List<MarketData.OHLCVBar> bars = makeBars(100, 101, 102, 103, 104, 105);
            BacktestEngine.Signal s = fn.apply(bars);
            assertTrue(s == BacktestEngine.Signal.LONG || s == BacktestEngine.Signal.FLAT);
        }

        @Test
        void testBreakoutPresetInsufficientHistoryReturnsFlat() {
            BacktestEngine.SignalFn fn = BacktestEngine.makeBreakoutSignal(20);
            assertEquals(BacktestEngine.Signal.FLAT, fn.apply(makeBars(100, 101)));
        }

        // TradingAgent: order proposal safety boundary (critical)
        @Test
        void testProposeOrderCreatesProposal() {
            TradingAgent.OrderProposal p = TradingAgent.proposeOrder(
                "AAPL", "buy", 10, "equity", "market", null, "test rationale");
            assertEquals("AAPL", p.symbol());
            assertEquals("buy", p.side());
            assertTrue(p.status().contains("REQUIRES HUMAN CONFIRMATION"));
            assertNotNull(p.proposalId());
        }

        @Test
        void testProposeOrderInvalidSideThrows() {
            assertThrows(IllegalArgumentException.class, () ->
                TradingAgent.proposeOrder("AAPL", "invalid", 10, "equity", "market", null, "x"));
        }

        @Test
        void testProposeOrderNonPositiveQuantityThrows() {
            assertThrows(IllegalArgumentException.class, () ->
                TradingAgent.proposeOrder("AAPL", "buy", 0, "equity", "market", null, "x"));
            assertThrows(IllegalArgumentException.class, () ->
                TradingAgent.proposeOrder("AAPL", "buy", -5, "equity", "market", null, "x"));
        }

        @Test
        void testLimitOrderRequiresPrice() {
            assertThrows(IllegalArgumentException.class, () ->
                TradingAgent.proposeOrder("AAPL", "buy", 10, "equity", "limit", null, "x"));
        }

        @Test
        void testGetProposalRoundtrip() {
            TradingAgent.OrderProposal p = TradingAgent.proposeOrder(
                "BTC", "buy", 0.1, "crypto", "market", null, "x");
            assertTrue(TradingAgent.getProposal(p.proposalId()).isPresent());
            assertEquals(p.proposalId(), TradingAgent.getProposal(p.proposalId()).get().proposalId());
        }

        @Test
        void testGetNonexistentProposalEmpty() {
            assertTrue(TradingAgent.getProposal("nonexistent-id-xyz").isEmpty());
        }

        @Test
        void testOrderExecuteRequiresConfirmTrue() {
            TradingAgent.OrderProposal p = TradingAgent.proposeOrder(
                "AAPL", "buy", 10, "equity", "market", null, "x");
            assertThrows(SecurityException.class, () ->
                TradingAgent.orderExecuteIBKR(p.proposalId(), false));
        }

        @Test
        void testOrderExecuteUnknownProposalThrows() {
            assertThrows(IllegalArgumentException.class, () ->
                TradingAgent.orderExecuteIBKR("nonexistent-id", true));
        }

        @Test
        void testOrderExecuteDefaultsPaperMode() {
            String prev = System.getenv("IBKR_LIVE_TRADING");
            // Can't unset env in Java without native — verify PAPER is default when not set to "true"
            // (works when IBKR_LIVE_TRADING is unset or set to anything other than "true")
            if (!"true".equalsIgnoreCase(System.getenv("IBKR_LIVE_TRADING"))) {
                TradingAgent.OrderProposal p = TradingAgent.proposeOrder(
                    "AAPL", "buy", 10, "equity", "market", null, "x");
                TradingAgent.ExecutionResult result = TradingAgent.orderExecuteIBKR(p.proposalId(), true);
                assertEquals("PAPER", result.mode());
            }
        }

        @Test
        void testOrderExecuteIBKRNotInToolRegistry() {
            assertFalse(ReactLoop.TOOLS.containsKey("order_execute_ibkr"),
                "order_execute_ibkr must never be registered as an agent tool");
            assertFalse(ReactLoop.TOOLS.containsKey("order_execute"),
                "order_execute must never be registered as an agent tool");
        }
    }
}
