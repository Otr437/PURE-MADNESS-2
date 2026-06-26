/**
 * Model Router — Java
 * Unified multi-provider chat-completion client for Claude, DeepSeek, and OpenAI.
 * Uses OkHttp + Jackson. Algorithms pinned, no reflection-based deserialization exploits.
 *
 * export MODEL_PROVIDER=anthropic|deepseek|openai
 * export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
 */

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.*;
import okhttp3.*;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.TimeUnit;

public class ModelRouter {

    // ── Config ─────────────────────────────────────────────────────────────────
    static final Map<String, String> DEFAULT_MODELS = Map.of(
        "anthropic", "claude-opus-4-6",
        "deepseek",  "deepseek-v4-pro",
        "openai",    "gpt-5.5"
    );

    static final Map<String, String> BASE_URLS = Map.of(
        "anthropic", "https://api.anthropic.com",
        "deepseek",  "https://api.deepseek.com/anthropic",
        "openai",    "https://api.openai.com"
    );

    static final ObjectMapper JSON = new ObjectMapper();
    static final MediaType JSON_TYPE = MediaType.get("application/json; charset=utf-8");
    static final OkHttpClient HTTP = new OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build();

    // ── Types ──────────────────────────────────────────────────────────────────
    public enum BlockType { TEXT, TOOL_USE }

    public static class ContentBlock {
        public final BlockType type;
        public final String text;
        public final String id;
        public final String name;
        public final Map<String, Object> input;

        private ContentBlock(BlockType type, String text, String id, String name, Map<String, Object> input) {
            this.type = type; this.text = text; this.id = id; this.name = name; this.input = input;
        }

        public static ContentBlock text(String text) {
            return new ContentBlock(BlockType.TEXT, text, null, null, null);
        }

        public static ContentBlock toolUse(String id, String name, Map<String, Object> input) {
            return new ContentBlock(BlockType.TOOL_USE, null, id, name, input);
        }

        public Map<String, Object> toAssistantBlock() {
            Map<String, Object> m = new LinkedHashMap<>();
            if (type == BlockType.TEXT) {
                m.put("type", "text"); m.put("text", text);
            } else {
                m.put("type", "tool_use"); m.put("id", id); m.put("name", name); m.put("input", input);
            }
            return m;
        }
    }

    public static class UnifiedResponse {
        public final List<ContentBlock> content;
        public final String stopReason;
        public final int inputTokens;
        public final int outputTokens;

        UnifiedResponse(List<ContentBlock> content, String stopReason, int inputTokens, int outputTokens) {
            this.content = content; this.stopReason = stopReason;
            this.inputTokens = inputTokens; this.outputTokens = outputTokens;
        }

        public Map<String, Object> toAssistantMessage() {
            List<Map<String, Object>> blocks = new ArrayList<>();
            for (ContentBlock b : content) blocks.add(b.toAssistantBlock());
            return Map.of("role", "assistant", "content", blocks);
        }
    }

    // ── Instance ───────────────────────────────────────────────────────────────
    public final String provider;
    public final String model;
    private final String baseUrl;
    private final String apiKey;

    public ModelRouter() {
        this(null, null);
    }

    public ModelRouter(String provider, String model) {
        this.provider = Optional.ofNullable(provider)
            .or(() -> Optional.ofNullable(System.getenv("MODEL_PROVIDER")))
            .orElse("anthropic");

        if (!DEFAULT_MODELS.containsKey(this.provider)) {
            throw new IllegalArgumentException("Unknown MODEL_PROVIDER: " + this.provider);
        }
        this.model = Optional.ofNullable(model)
            .or(() -> Optional.ofNullable(System.getenv("MODEL_NAME")))
            .orElse(DEFAULT_MODELS.get(this.provider));
        this.baseUrl = BASE_URLS.get(this.provider);

        String key = switch (this.provider) {
            case "openai"    -> System.getenv("OPENAI_API_KEY");
            case "deepseek"  -> System.getenv("DEEPSEEK_API_KEY");
            default          -> System.getenv("ANTHROPIC_API_KEY");
        };
        if (key == null || key.isBlank()) throw new IllegalStateException("API key not set for provider: " + this.provider);
        this.apiKey = key;
    }

    // ── Main create() ──────────────────────────────────────────────────────────
    public UnifiedResponse create(
        List<Map<String, Object>> messages,
        List<Map<String, Object>> tools,
        String system,
        int maxTokens
    ) throws Exception {
        if (maxTokens <= 0) maxTokens = 4096;
        return switch (provider) {
            case "anthropic", "deepseek" -> createAnthropic(messages, tools, system, maxTokens);
            case "openai"                -> createOpenAI(messages, tools, system, maxTokens);
            default -> throw new IllegalStateException("Unsupported provider: " + provider);
        };
    }

    // ── Anthropic-format ───────────────────────────────────────────────────────
    private UnifiedResponse createAnthropic(
        List<Map<String, Object>> messages,
        List<Map<String, Object>> tools,
        String system, int maxTokens
    ) throws Exception {
        ObjectNode body = JSON.createObjectNode();
        body.put("model", model);
        body.put("max_tokens", maxTokens);
        body.set("messages", JSON.valueToTree(messages));
        if (system != null && !system.isBlank()) body.put("system", system);
        if (tools != null && !tools.isEmpty()) body.set("tools", JSON.valueToTree(tools));

        Request req = new Request.Builder()
            .url(baseUrl + "/v1/messages")
            .header("x-api-key", apiKey)
            .header("anthropic-version", "2023-06-01")
            .post(RequestBody.create(JSON.writeValueAsBytes(body), JSON_TYPE))
            .build();

        return executeAndParseAnthropic(req);
    }

    private UnifiedResponse executeAndParseAnthropic(Request req) throws Exception {
        try (Response resp = HTTP.newCall(req).execute()) {
            String bodyStr = resp.body().string();
            if (!resp.isSuccessful()) throw new IOException("Anthropic API " + resp.code() + ": " + bodyStr);
            JsonNode root = JSON.readTree(bodyStr);
            String stopReason = root.path("stop_reason").asText("end_turn");
            int inputTokens   = root.path("usage").path("input_tokens").asInt(0);
            int outputTokens  = root.path("usage").path("output_tokens").asInt(0);
            List<ContentBlock> content = new ArrayList<>();
            for (JsonNode b : root.path("content")) {
                String type = b.path("type").asText();
                if ("text".equals(type)) {
                    content.add(ContentBlock.text(b.path("text").asText()));
                } else if ("tool_use".equals(type)) {
                    Map<String, Object> input = JSON.convertValue(b.path("input"), Map.class);
                    content.add(ContentBlock.toolUse(b.path("id").asText(), b.path("name").asText(), input));
                }
            }
            return new UnifiedResponse(content, stopReason, inputTokens, outputTokens);
        }
    }

    // ── OpenAI-format ──────────────────────────────────────────────────────────
    private UnifiedResponse createOpenAI(
        List<Map<String, Object>> messages,
        List<Map<String, Object>> tools,
        String system, int maxTokens
    ) throws Exception {
        List<Map<String, Object>> oaMessages = new ArrayList<>();
        if (system != null && !system.isBlank()) oaMessages.add(Map.of("role", "system", "content", system));
        oaMessages.addAll(messages);

        ObjectNode body = JSON.createObjectNode();
        body.put("model", model);
        body.put("max_tokens", maxTokens);
        body.set("messages", JSON.valueToTree(oaMessages));

        if (tools != null && !tools.isEmpty()) {
            List<Map<String, Object>> oaTools = new ArrayList<>();
            for (Map<String, Object> t : tools) {
                oaTools.add(Map.of("type", "function", "function", Map.of(
                    "name",        t.get("name"),
                    "description", t.getOrDefault("description", ""),
                    "parameters",  t.getOrDefault("input_schema", Map.of("type", "object", "properties", Map.of()))
                )));
            }
            body.set("tools", JSON.valueToTree(oaTools));
            body.put("tool_choice", "auto");
        }

        Request req = new Request.Builder()
            .url(baseUrl + "/v1/chat/completions")
            .header("Authorization", "Bearer " + apiKey)
            .post(RequestBody.create(JSON.writeValueAsBytes(body), JSON_TYPE))
            .build();

        try (Response resp = HTTP.newCall(req).execute()) {
            String bodyStr = resp.body().string();
            if (!resp.isSuccessful()) throw new IOException("OpenAI API " + resp.code() + ": " + bodyStr);
            JsonNode root   = JSON.readTree(bodyStr);
            JsonNode choice = root.path("choices").path(0);
            JsonNode msg    = choice.path("message");
            int inputTokens  = root.path("usage").path("prompt_tokens").asInt(0);
            int outputTokens = root.path("usage").path("completion_tokens").asInt(0);

            List<ContentBlock> content = new ArrayList<>();
            String stopReason = "end_turn";
            String textContent = msg.path("content").asText(null);
            if (textContent != null && !textContent.isBlank()) content.add(ContentBlock.text(textContent));
            JsonNode toolCalls = msg.path("tool_calls");
            if (toolCalls.isArray() && toolCalls.size() > 0) {
                stopReason = "tool_use";
                for (JsonNode tc : toolCalls) {
                    String argsStr = tc.path("function").path("arguments").asText("{}");
                    Map<String, Object> input = JSON.readValue(argsStr, Map.class);
                    content.add(ContentBlock.toolUse(
                        tc.path("id").asText(),
                        tc.path("function").path("name").asText(),
                        input
                    ));
                }
            }
            return new UnifiedResponse(content, stopReason, inputTokens, outputTokens);
        }
    }

    // ── Tool result message ───────────────────────────────────────────────────
    public static Map<String, Object> makeToolResultMessage(String toolUseId, String content, boolean isError) {
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("type", "tool_result");
        block.put("tool_use_id", toolUseId);
        block.put("content", content);
        if (isError) block.put("is_error", true);
        return Map.of("role", "user", "content", List.of(block));
    }
}
