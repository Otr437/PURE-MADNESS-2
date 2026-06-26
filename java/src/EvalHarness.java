/**
 * Eval Harness — Java
 * Measures retrieval quality: Precision@K, Recall@K, MRR, NDCG@K.
 *
 * java -cp target/rag-ai-java-1.0.0.jar EvalHarness
 */

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;

public class EvalHarness {

    static final ObjectMapper JSON = new ObjectMapper();

    // ── Types ──────────────────────────────────────────────────────────────────
    public record EvalCase(String query, Set<String> relevantIds, String description) {}

    public record EvalResult(
        String query,
        double precisionAtK,
        double recallAtK,
        double reciprocalRank,
        double ndcgAtK,
        List<String> retrievedIds
    ) {}

    public record EvalReport(
        int topK,
        int numCases,
        double meanPrecision,
        double meanRecall,
        double meanMrr,
        double meanNdcg,
        List<EvalResult> perCase
    ) {}

    // ── Metrics ────────────────────────────────────────────────────────────────
    static double precisionAtK(List<String> retrieved, Set<String> relevant, int k) {
        if (k == 0) return 0;
        long hits = retrieved.stream().limit(k).filter(relevant::contains).count();
        return (double) hits / k;
    }

    static double recallAtK(List<String> retrieved, Set<String> relevant, int k) {
        if (relevant.isEmpty()) return 0;
        long hits = retrieved.stream().limit(k).filter(relevant::contains).count();
        return (double) hits / relevant.size();
    }

    static double reciprocalRank(List<String> retrieved, Set<String> relevant) {
        for (int i = 0; i < retrieved.size(); i++) {
            if (relevant.contains(retrieved.get(i))) return 1.0 / (i + 1);
        }
        return 0;
    }

    static double ndcgAtK(List<String> retrieved, Set<String> relevant, int k) {
        double dcg = 0;
        List<String> top = retrieved.subList(0, Math.min(k, retrieved.size()));
        for (int i = 0; i < top.size(); i++) {
            if (relevant.contains(top.get(i))) dcg += 1.0 / (Math.log(i + 2) / Math.log(2));
        }
        // Ideal DCG: all relevant docs at top
        double idcg = 0;
        int idealHits = Math.min(relevant.size(), k);
        for (int i = 0; i < idealHits; i++) {
            idcg += 1.0 / (Math.log(i + 2) / Math.log(2));
        }
        return idcg == 0 ? 0 : dcg / idcg;
    }

    // ── Evaluator ──────────────────────────────────────────────────────────────
    public static class RAGEvaluator {
        final RagEngine engine;
        final int topK;

        RAGEvaluator(RagEngine engine, int topK) {
            this.engine = engine;
            this.topK   = topK;
        }

        EvalResult evaluateCase(EvalCase c) throws Exception {
            List<RagEngine.RetrievedChunk> chunks = engine.retrieve(c.query(), topK);
            List<String> ids = chunks.stream().map(ch -> ch.docId()).toList();
            return new EvalResult(
                c.query(),
                precisionAtK(ids, c.relevantIds(), topK),
                recallAtK(ids, c.relevantIds(), topK),
                reciprocalRank(ids, c.relevantIds()),
                ndcgAtK(ids, c.relevantIds(), topK),
                ids
            );
        }

        EvalReport evaluate(List<EvalCase> cases) throws Exception {
            List<EvalResult> results = new ArrayList<>();
            for (EvalCase c : cases) results.add(evaluateCase(c));
            int n = results.size();
            if (n == 0) return new EvalReport(topK, 0, 0, 0, 0, 0, results);
            double sumP = 0, sumR = 0, sumM = 0, sumN = 0;
            for (EvalResult r : results) { sumP += r.precisionAtK(); sumR += r.recallAtK(); sumM += r.reciprocalRank(); sumN += r.ndcgAtK(); }
            return new EvalReport(topK, n, sumP/n, sumR/n, sumM/n, sumN/n, results);
        }
    }

    static void printReport(EvalReport report) {
        System.out.println("\n" + "=".repeat(50));
        System.out.printf("RAG Eval (Java)  top_k=%d  n=%d%n", report.topK(), report.numCases());
        System.out.println("=".repeat(50));
        System.out.printf("  Mean Precision@%d: %.4f%n", report.topK(), report.meanPrecision());
        System.out.printf("  Mean Recall@%d:    %.4f%n", report.topK(), report.meanRecall());
        System.out.printf("  Mean MRR:          %.4f%n", report.meanMrr());
        System.out.printf("  Mean NDCG@%d:      %.4f%n", report.topK(), report.meanNdcg());
        System.out.println();
        for (EvalResult r : report.perCase()) {
            String status = r.precisionAtK() > 0 ? "✅" : "❌";
            System.out.printf("  %s [P=%.2f R=%.2f MRR=%.2f]  %s%n",
                status, r.precisionAtK(), r.recallAtK(), r.reciprocalRank(),
                r.query().substring(0, Math.min(60, r.query().length())));
        }
    }

    // ── Demo data ──────────────────────────────────────────────────────────────
    static List<RagEngine.Document> demoDocs() {
        return Arrays.asList(
            new RagEngine.Document("Claude is an AI assistant made by Anthropic.", Map.of("source", "anthropic")),
            new RagEngine.Document("RAG combines retrieval with generation to ground LLM answers.", Map.of("source", "rag_paper")),
            new RagEngine.Document("Qdrant is a high-performance vector database written in Rust.", Map.of("source", "qdrant")),
            new RagEngine.Document("Voyage AI provides state-of-the-art embedding and reranking models.", Map.of("source", "voyage")),
            new RagEngine.Document("Java is a class-based, object-oriented language designed for portability.", Map.of("source", "java_docs"))
        );
    }

    // ── CLI ────────────────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        int topK = 5;
        RagEngine engine = new RagEngine("eval_java");
        List<RagEngine.Document> docs = demoDocs();
        engine.ingest(docs);

        List<EvalCase> cases = new ArrayList<>();
        for (RagEngine.Document doc : docs) {
            String source = doc.metadata.getOrDefault("source", "unknown");
            cases.add(new EvalCase("Tell me about " + source, Set.of(doc.docId), source));
        }

        RAGEvaluator evaluator = new RAGEvaluator(engine, topK);
        EvalReport report = evaluator.evaluate(cases);
        printReport(report);
        System.out.println(JSON.writerWithDefaultPrettyPrinter().writeValueAsString(report));
    }
}
