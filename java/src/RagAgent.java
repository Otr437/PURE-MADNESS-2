/**
 * RAG Agent — Java
 * Wires RagEngine (hybrid search, reranking, citations) + document loaders
 * into the multi-provider ReAct loop.
 *
 * export MODEL_PROVIDER=anthropic|deepseek|openai
 * export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
 * export VOYAGE_API_KEY=... QDRANT_URL=http://localhost:6333
 *
 * java -cp target/rag-ai-java-1.0.0.jar RagAgent --task "your question"
 * java -cp target/rag-ai-java-1.0.0.jar RagAgent --dir ./docs --task "your question"
 */

import java.nio.file.Path;
import java.util.*;

public class RagAgent {

    static final String RAG_SYSTEM_PROMPT =
        "You have access to a 'rag_search' tool that searches a knowledge base of ingested documents " +
        "using hybrid retrieval with reranking. Results include citation markers. " +
        "Use rag_search to find relevant context before answering factual questions. " +
        "Always search first, reason second, then answer. Cite retrieved passages.";

    static List<RagEngine.Document> defaultDocs() {
        return Arrays.asList(
            new RagEngine.Document("Claude is an AI assistant made by Anthropic, designed to be helpful, harmless, and honest.", Map.of("source", "anthropic_docs")),
            new RagEngine.Document("RAG (Retrieval-Augmented Generation) combines retrieval with generation to ground LLM answers in real documents.", Map.of("source", "rag_survey")),
            new RagEngine.Document("Qdrant is a high-performance vector database written in Rust, supporting cosine, dot product, and Euclidean distance.", Map.of("source", "qdrant_docs"))
        );
    }

    public static ReactLoop.ReactResult ingestAndRun(
        List<RagEngine.Document> documents,
        String task,
        String systemExtra,
        int maxIterations,
        boolean verbose
    ) throws Exception {
        // Init RAG engine
        RagEngine engine = new RagEngine("default");

        if (documents != null && !documents.isEmpty()) {
            int count = engine.ingest(documents);
            System.err.printf("[rag-agent] Ingested %d docs → %d chunks%n", documents.size(), count);
        }

        // Register rag_search tool in ReactLoop
        if (!ReactLoop.TOOLS.containsKey("rag_search")) {
            ReactLoop.registerTool(
                "rag_search",
                "Search the knowledge base for context relevant to a query.",
                ReactLoop.JSON.createObjectNode()
                    .<com.fasterxml.jackson.databind.node.ObjectNode>put("type", "object")
                    .set("properties", ReactLoop.JSON.createObjectNode()
                        .set("query", ReactLoop.JSON.createObjectNode().put("type", "string"))
                        .set("top_k", ReactLoop.JSON.createObjectNode().put("type", "integer"))),
                inputNode -> {
                    String query = inputNode.path("query").asText("");
                    int topK     = inputNode.path("top_k").asInt(5);
                    try {
                        return engine.retrieveAsContext(query, topK);
                    } catch (Exception e) {
                        return "rag_search error: " + e.getMessage();
                    }
                }
            );
        }

        String combined = systemExtra == null || systemExtra.isBlank()
            ? RAG_SYSTEM_PROMPT
            : RAG_SYSTEM_PROMPT + "\n\n" + systemExtra;

        return ReactLoop.runReact(task, combined, maxIterations, verbose ? step -> {
            switch (step.type()) {
                case "thought"     -> System.out.printf("%n💭 THOUGHT%n%s%n", step.content() == null ? "" : step.content().substring(0, Math.min(300, step.content().length())));
                case "action"      -> System.out.printf("%n⚡ ACTION  %s%n%s%n", step.tool(), step.input());
                case "observation" -> System.out.printf("%n%s OBSERVE%n%s%n", step.error() ? "❌" : "👁", step.content() == null ? "" : step.content().substring(0, Math.min(300, step.content().length())));
            }
        } : null);
    }

    public static void main(String[] args) throws Exception {
        String task    = null;
        String dir     = null;
        int maxIter    = 30;
        boolean verbose = true;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--task", "-task" -> { if (i + 1 < args.length) task = args[++i]; }
                case "--dir",  "-dir"  -> { if (i + 1 < args.length) dir  = args[++i]; }
                case "--max-iterations" -> { if (i + 1 < args.length) maxIter = Integer.parseInt(args[++i]); }
                case "--quiet"          -> verbose = false;
            }
        }

        if (task == null) task = "Explain how the ReAct pattern works and how it relates to RAG.";

        List<RagEngine.Document> documents;
        if (dir != null) {
            documents = Loaders.loadDirectory(Path.of(dir), true);
            if (documents.isEmpty()) {
                System.err.println("[rag-agent] No supported documents found in " + dir);
            }
        } else {
            documents = defaultDocs();
        }

        ReactLoop.ReactResult result = ingestAndRun(documents, task, null, maxIter, verbose);

        System.out.println("\n" + "=".repeat(64));
        System.out.println("FINAL ANSWER");
        System.out.println("=".repeat(64));
        System.out.println(result.answer());
        System.out.println("=".repeat(64));
        System.out.printf("Iterations: %d | Tokens: %d | Time: %dms%n",
            result.trace().iterations(), result.trace().totalTokens(), result.trace().elapsedMs());
    }
}
