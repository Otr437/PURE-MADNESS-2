/**
 * RAG Engine — Java
 * Ingest documents, embed via Anthropic, store in Qdrant (REST API), retrieve context.
 *
 * pom.xml dependencies:
 *   com.squareup.okhttp3:okhttp:4.12.0
 *   com.fasterxml.jackson.core:jackson-databind:2.17.0
 *
 * export ANTHROPIC_API_KEY=sk-ant-...
 * export QDRANT_URL=http://localhost:6333
 *
 * javac -cp okhttp*.jar:jackson*.jar RagEngine.java
 * java  -cp .:okhttp*.jar:jackson*.jar RagEngine
 */

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.*;
import okhttp3.*;

import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

public class RagEngine {

    // ── Constants ─────────────────────────────────────────────────────────────
    static final String QDRANT_URL    = System.getenv().getOrDefault("QDRANT_URL", "http://localhost:6333");
    static final String ANTHROPIC_KEY = System.getenv("ANTHROPIC_API_KEY");
    static final String EMBED_URL     = "https://api.anthropic.com/v1/embeddings";
    static final String EMBED_MODEL   = "voyage-3";
    static final int    EMBEDDING_DIM = 1024;
    static final String COLLECTION_PREFIX = "rag_";
    static final int    DEFAULT_TOP_K = 5;
    static final int    CHUNK_SIZE    = 800;
    static final int    CHUNK_OVERLAP = 120;

    static final ObjectMapper JSON = new ObjectMapper();
    static final OkHttpClient HTTP = new OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build();
    static final MediaType JSON_MEDIA = MediaType.get("application/json; charset=utf-8");

    // ── Models ─────────────────────────────────────────────────────────────────
    public static class Document {
        public String content;
        public Map<String, String> metadata;
        public String docId;

        public Document(String content, Map<String, String> metadata) {
            this.content  = content;
            this.metadata = metadata;
            this.docId    = sha256Hex(content);
        }
    }

    public static class Chunk {
        String text;
        String docId;
        int chunkIdx;
        Map<String, String> metadata;
        String chunkId;

        Chunk(String text, String docId, int chunkIdx, Map<String, String> metadata) {
            this.text = text;
            this.docId = docId;
            this.chunkIdx = chunkIdx;
            this.metadata = metadata;
            this.chunkId = sha256Hex(docId + ":" + chunkIdx);
        }
    }

    public static class RetrievedChunk {
        public String text;
        public float score;
        public String docId;
        public int chunkIdx;
        public Map<String, String> metadata;

        RetrievedChunk(String text, float score, String docId, int chunkIdx, Map<String, String> metadata) {
            this.text = text;
            this.score = score;
            this.docId = docId;
            this.chunkIdx = chunkIdx;
            this.metadata = metadata;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    static String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.substring(0, 16);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static long sha256ToLong(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(s.getBytes("UTF-8"));
            long val = 0;
            for (int i = 0; i < 8; i++) {
                val = (val << 8) | (digest[i] & 0xFF);
            }
            return val & Long.MAX_VALUE;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static List<String> chunkText(String text) {
        List<String> chunks = new ArrayList<>();
        int start = 0;
        while (start < text.length()) {
            int end = Math.min(start + CHUNK_SIZE, text.length());
            String chunk = text.substring(start, end);
            int nextStart = end;
            if (end < text.length()) {
                for (String sep : new String[]{"\n\n", "\n", ". ", " "}) {
                    int pos = chunk.lastIndexOf(sep);
                    if (pos > CHUNK_SIZE / 2) {
                        chunk = text.substring(start, start + pos + sep.length());
                        nextStart = start + pos + sep.length();
                        break;
                    }
                }
            }
            String trimmed = chunk.trim();
            if (!trimmed.isEmpty()) chunks.add(trimmed);
            if (nextStart <= start) break;
            start = Math.max(nextStart - CHUNK_OVERLAP, nextStart == start ? start + 1 : start);
            start = nextStart - CHUNK_OVERLAP;
            if (start < 0) start = 0;
            if (nextStart >= text.length()) break;
        }
        return chunks;
    }

    /** Deterministic pseudo-embedding for offline testing. */
    static float[] pseudoEmbed(String text) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(text.getBytes("UTF-8"));
            float[] vec = new float[EMBEDDING_DIM];
            double norm = 0;
            for (int i = 0; i < EMBEDDING_DIM; i++) {
                float v = (digest[i % digest.length] & 0xFF) / 255.0f * 2 - 1;
                vec[i] = v;
                norm += v * v;
            }
            norm = Math.sqrt(norm);
            if (norm == 0) norm = 1;
            for (int i = 0; i < EMBEDDING_DIM; i++) vec[i] = (float) (vec[i] / norm);
            return vec;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Embed a batch of texts. Falls back to pseudo-embedding on API error. */
    static List<float[]> embedTexts(List<String> texts) throws Exception {
        if (ANTHROPIC_KEY == null || ANTHROPIC_KEY.isEmpty()) {
            return texts.stream().map(RagEngine::pseudoEmbed).collect(Collectors.toList());
        }
        ObjectNode body = JSON.createObjectNode();
        body.put("model", EMBED_MODEL);
        ArrayNode inputArr = JSON.createArrayNode();
        texts.forEach(inputArr::add);
        body.set("input", inputArr);

        Request request = new Request.Builder()
            .url(EMBED_URL)
            .header("x-api-key", ANTHROPIC_KEY)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "embeddings-2025-01-01")
            .header("content-type", "application/json")
            .post(RequestBody.create(JSON.writeValueAsBytes(body), JSON_MEDIA))
            .build();

        try (Response response = HTTP.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                return texts.stream().map(RagEngine::pseudoEmbed).collect(Collectors.toList());
            }
            JsonNode root = JSON.readTree(response.body().string());
            List<float[]> result = new ArrayList<>();
            for (JsonNode item : root.get("data")) {
                JsonNode embArr = item.get("embedding");
                float[] vec = new float[embArr.size()];
                for (int i = 0; i < embArr.size(); i++) vec[i] = (float) embArr.get(i).asDouble();
                result.add(vec);
            }
            return result;
        } catch (Exception e) {
            return texts.stream().map(RagEngine::pseudoEmbed).collect(Collectors.toList());
        }
    }

    // ── RAG Engine ────────────────────────────────────────────────────────────
    final String collectionName;

    public RagEngine(String name) throws Exception {
        this.collectionName = COLLECTION_PREFIX + name;
        ensureCollection();
    }

    void ensureCollection() throws Exception {
        // Check if collection exists
        Request getReq = new Request.Builder()
            .url(QDRANT_URL + "/collections/" + collectionName)
            .get().build();
        try (Response resp = HTTP.newCall(getReq).execute()) {
            if (resp.code() == 200) return;
        }
        // Create collection
        ObjectNode body = JSON.createObjectNode();
        ObjectNode vectors = JSON.createObjectNode();
        vectors.put("size", EMBEDDING_DIM);
        vectors.put("distance", "Cosine");
        body.set("vectors", vectors);

        Request putReq = new Request.Builder()
            .url(QDRANT_URL + "/collections/" + collectionName)
            .put(RequestBody.create(JSON.writeValueAsBytes(body), JSON_MEDIA))
            .build();
        try (Response resp = HTTP.newCall(putReq).execute()) {
            if (!resp.isSuccessful()) {
                throw new RuntimeException("Failed to create collection: " + resp.code() + " " + resp.body().string());
            }
            System.err.println("[rag] Collection created: " + collectionName);
        }
    }

    public int ingest(List<Document> documents) throws Exception {
        List<Chunk> allChunks = new ArrayList<>();
        for (Document doc : documents) {
            int idx = 0;
            for (String text : chunkText(doc.content)) {
                Map<String, String> meta = new HashMap<>(doc.metadata);
                meta.put("source_doc_id", doc.docId);
                allChunks.add(new Chunk(text, doc.docId, idx++, meta));
            }
        }

        int batchSize = 32;
        for (int start = 0; start < allChunks.size(); start += batchSize) {
            int end = Math.min(start + batchSize, allChunks.size());
            List<Chunk> batch = allChunks.subList(start, end);
            List<String> texts = batch.stream().map(c -> c.text).collect(Collectors.toList());
            List<float[]> vecs = embedTexts(texts);

            ArrayNode points = JSON.createArrayNode();
            for (int i = 0; i < batch.size(); i++) {
                Chunk c = batch.get(i);
                ObjectNode point = JSON.createObjectNode();
                point.put("id", sha256ToLong(c.chunkId));
                ArrayNode vecArr = JSON.createArrayNode();
                for (float v : vecs.get(i)) vecArr.add(v);
                point.set("vector", vecArr);

                ObjectNode payload = JSON.createObjectNode();
                payload.put("text", c.text);
                payload.put("doc_id", c.docId);
                payload.put("chunk_idx", c.chunkIdx);
                payload.put("metadata", JSON.writeValueAsString(c.metadata));
                point.set("payload", payload);
                points.add(point);
            }

            ObjectNode body = JSON.createObjectNode();
            body.set("points", points);

            Request req = new Request.Builder()
                .url(QDRANT_URL + "/collections/" + collectionName + "/points?wait=true")
                .put(RequestBody.create(JSON.writeValueAsBytes(body), JSON_MEDIA))
                .build();
            try (Response resp = HTTP.newCall(req).execute()) {
                if (!resp.isSuccessful()) {
                    throw new RuntimeException("Upsert failed: " + resp.code() + " " + resp.body().string());
                }
            }
        }
        return allChunks.size();
    }

    public List<RetrievedChunk> retrieve(String query, int topK) throws Exception {
        float[] vec = embedTexts(Collections.singletonList(query)).get(0);

        ObjectNode body = JSON.createObjectNode();
        ArrayNode vecArr = JSON.createArrayNode();
        for (float v : vec) vecArr.add(v);
        body.set("vector", vecArr);
        body.put("limit", topK);
        body.put("with_payload", true);

        Request req = new Request.Builder()
            .url(QDRANT_URL + "/collections/" + collectionName + "/points/search")
            .post(RequestBody.create(JSON.writeValueAsBytes(body), JSON_MEDIA))
            .build();

        List<RetrievedChunk> results = new ArrayList<>();
        try (Response resp = HTTP.newCall(req).execute()) {
            if (!resp.isSuccessful()) {
                throw new RuntimeException("Search failed: " + resp.code() + " " + resp.body().string());
            }
            JsonNode root = JSON.readTree(resp.body().string());
            for (JsonNode r : root.get("result")) {
                JsonNode payload = r.get("payload");
                Map<String, String> meta = new HashMap<>();
                if (payload.has("metadata")) {
                    JsonNode metaNode = JSON.readTree(payload.get("metadata").asText("{}"));
                    metaNode.fields().forEachRemaining(e -> meta.put(e.getKey(), e.getValue().asText()));
                }
                results.add(new RetrievedChunk(
                    payload.get("text").asText(),
                    (float) r.get("score").asDouble(),
                    payload.get("doc_id").asText(),
                    payload.get("chunk_idx").asInt(),
                    meta
                ));
            }
        }
        return results;
    }

    public String retrieveAsContext(String query, int topK) throws Exception {
        List<RetrievedChunk> chunks = retrieve(query, topK);
        if (chunks.isEmpty()) return "No relevant context found.";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < chunks.size(); i++) {
            RetrievedChunk c = chunks.get(i);
            sb.append(String.format("[%d] (score=%.3f) %s", i + 1, c.score, c.text));
            if (i < chunks.size() - 1) sb.append("\n\n");
        }
        return sb.toString();
    }

    // ── Tool factory for agent loops ─────────────────────────────────────────
    public interface RagToolFn {
        String search(String query, int topK) throws Exception;
    }

    public RagToolFn asTool() {
        return this::retrieveAsContext;
    }

    // ── Demo main ─────────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        RagEngine engine = new RagEngine("demo");

        List<Document> docs = Arrays.asList(
            new Document("Java is a class-based, object-oriented language designed for portability via the JVM.",
                Map.of("source", "java_docs")),
            new Document("RAG retrieves relevant chunks from a vector database and prepends them to the LLM prompt to ground answers in real data.",
                Map.of("source", "rag_survey")),
            new Document("Qdrant exposes both a gRPC and a REST API and supports cosine, dot, and Euclidean distance metrics.",
                Map.of("source", "qdrant_docs"))
        );

        int count = engine.ingest(docs);
        System.out.println("Ingested " + docs.size() + " docs → " + count + " chunks");

        String ctx = engine.retrieveAsContext("What is RAG?", DEFAULT_TOP_K);
        System.out.println("\nContext for 'What is RAG?':\n" + ctx);
    }
}
