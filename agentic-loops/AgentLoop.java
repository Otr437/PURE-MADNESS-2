// Plug-and-play Agentic Loop — Java
// Requires: Java 11+, add to pom.xml or gradle:
//   com.squareup.okhttp3:okhttp:4.12.0
//   com.fasterxml.jackson.core:jackson-databind:2.17.0
// Set: ANTHROPIC_API_KEY env var

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import okhttp3.*;

import java.util.ArrayList;
import java.util.List;

public class AgentLoop {

    static final String API_URL = "https://api.anthropic.com/v1/messages";
    static final String MODEL = "claude-opus-4-6";
    static final OkHttpClient HTTP = new OkHttpClient();
    static final ObjectMapper MAPPER = new ObjectMapper();

    // ── Execute tools here ────────────────────────────────────────────────────
    static String executeTool(String name, JsonNode input) {
        if ("get_weather".equals(name)) {
            String city = input.path("city").asText("unknown");
            return "The weather in " + city + " is 72°F and sunny."; // stub
        }
        return "Unknown tool";
    }

    // ── The loop ──────────────────────────────────────────────────────────────
    static String runAgent(String userMessage, int maxIterations) throws Exception {
        String apiKey = System.getenv("ANTHROPIC_API_KEY");

        // Build tools definition
        ArrayNode tools = MAPPER.createArrayNode();
        ObjectNode tool = MAPPER.createObjectNode();
        tool.put("name", "get_weather");
        tool.put("description", "Get the current weather for a city.");
        ObjectNode schema = MAPPER.createObjectNode();
        schema.put("type", "object");
        ObjectNode props = MAPPER.createObjectNode();
        ObjectNode cityProp = MAPPER.createObjectNode();
        cityProp.put("type", "string");
        cityProp.put("description", "City name");
        props.set("city", cityProp);
        schema.set("properties", props);
        ArrayNode required = MAPPER.createArrayNode();
        required.add("city");
        schema.set("required", required);
        tool.set("input_schema", schema);
        tools.add(tool);

        // Message history
        List<ObjectNode> messages = new ArrayList<>();
        ObjectNode userMsg = MAPPER.createObjectNode();
        userMsg.put("role", "user");
        userMsg.put("content", userMessage);
        messages.add(userMsg);

        for (int i = 0; i < maxIterations; i++) {
            // Build request body
            ObjectNode body = MAPPER.createObjectNode();
            body.put("model", MODEL);
            body.put("max_tokens", 1024);
            body.set("tools", tools);
            ArrayNode msgArray = MAPPER.createArrayNode();
            messages.forEach(msgArray::add);
            body.set("messages", msgArray);

            Request request = new Request.Builder()
                .url(API_URL)
                .header("x-api-key", apiKey)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .post(RequestBody.create(MAPPER.writeValueAsBytes(body),
                    MediaType.get("application/json")))
                .build();

            JsonNode resp;
            try (Response response = HTTP.newCall(request).execute()) {
                resp = MAPPER.readTree(response.body().string());
            }

            String stopReason = resp.path("stop_reason").asText();
            JsonNode content = resp.path("content");

            // Append assistant message
            ObjectNode assistantMsg = MAPPER.createObjectNode();
            assistantMsg.put("role", "assistant");
            assistantMsg.set("content", content);
            messages.add(assistantMsg);

            if ("end_turn".equals(stopReason)) {
                for (JsonNode block : content) {
                    if ("text".equals(block.path("type").asText())) {
                        return block.path("text").asText();
                    }
                }
            }

            if ("tool_use".equals(stopReason)) {
                ArrayNode toolResults = MAPPER.createArrayNode();
                for (JsonNode block : content) {
                    if ("tool_use".equals(block.path("type").asText())) {
                        String name = block.path("name").asText();
                        JsonNode input = block.path("input");
                        String result = executeTool(name, input);
                        System.out.printf("[Tool] %s → %s%n", name, result);
                        ObjectNode tr = MAPPER.createObjectNode();
                        tr.put("type", "tool_result");
                        tr.put("tool_use_id", block.path("id").asText());
                        tr.put("content", result);
                        toolResults.add(tr);
                    }
                }
                ObjectNode toolMsg = MAPPER.createObjectNode();
                toolMsg.put("role", "user");
                toolMsg.set("content", toolResults);
                messages.add(toolMsg);
            }
        }

        return "Max iterations reached.";
    }

    public static void main(String[] args) throws Exception {
        System.out.println(runAgent("What's the weather like in Tokyo?", 10));
    }
}
