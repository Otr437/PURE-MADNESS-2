/**
 * Production ReAct Loop — Java
 * Reason → Act → Observe, repeat until finish() called.
 *
 * pom.xml dependencies:
 *   com.squareup.okhttp3:okhttp:4.12.0
 *   com.fasterxml.jackson.core:jackson-databind:2.17.0
 *
 * export ANTHROPIC_API_KEY=sk-ant-...
 * javac -cp okhttp*.jar:jackson*.jar ReactLoop.java
 * java  -cp .:okhttp*.jar:jackson*.jar ReactLoop "your task here"
 */

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.*;
import okhttp3.*;

import java.io.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.regex.Pattern;

public class ReactLoop {

    // ── Constants ─────────────────────────────────────────────────────────────
    static final String API_URL    = "https://api.anthropic.com/v1/messages";
    static final String MODEL      = "claude-opus-4-6";
    static final ObjectMapper JSON = new ObjectMapper();

    static final OkHttpClient HTTP = new OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build();

    static final String REACT_SYSTEM =
        "You are an autonomous agent operating in a ReAct loop (Reason + Act + Observe).\n\n" +
        "For every task:\n" +
        "1. Use the think tool to reason about what to do next before acting.\n" +
        "2. Call the appropriate tool to act.\n" +
        "3. Observe the result and reason again.\n" +
        "4. Repeat until you have a complete, verified answer.\n" +
        "5. Call finish with your final answer when done.\n\n" +
        "Rules:\n" +
        "- Always think before acting. Never skip the think step.\n" +
        "- If a tool errors, reason about why and try a different approach.\n" +
        "- Do not guess. If unsure, search or fetch.\n" +
        "- Be thorough. Do not call finish until the task is fully complete.";

    // ── Trace types ───────────────────────────────────────────────────────────
    record TraceStep(String type, String content, String tool,
                     JsonNode input, boolean error) {
        static TraceStep thought(String content) {
            return new TraceStep("thought", content, null, null, false);
        }
        static TraceStep action(String tool, JsonNode input) {
            return new TraceStep("action", null, tool, input, false);
        }
        static TraceStep observation(String content, boolean error) {
            return new TraceStep("observation", content, null, null, error);
        }
        static TraceStep answer(String content) {
            return new TraceStep("answer", content, null, null, false);
        }
        ObjectNode toJson() {
            ObjectNode n = JSON.createObjectNode();
            n.put("type", type);
            if (content != null) n.put("content", content);
            if (tool != null)    n.put("tool", tool);
            if (input != null)   n.set("input", input);
            if (error)           n.put("error", true);
            return n;
        }
    }

    static class Trace {
        List<TraceStep> steps       = new ArrayList<>();
        long            totalTokens = 0;
        int             iterations  = 0;
        long            elapsedMs   = 0;
    }

    // ── Tool registry ─────────────────────────────────────────────────────────
    interface ToolFn extends Function<JsonNode, String> {}

    record ToolDef(String name, String description, JsonNode schema, ToolFn fn) {}

    static final Map<String, ToolDef> TOOLS = new LinkedHashMap<>();

    static void registerTool(String name, String description, JsonNode schema, ToolFn fn) {
        TOOLS.put(name, new ToolDef(name, description, schema, fn));
    }

    static ArrayNode toolSchemas() {
        ArrayNode arr = JSON.createArrayNode();
        for (ToolDef t : TOOLS.values()) {
            ObjectNode n = JSON.createObjectNode();
            n.put("name", t.name());
            n.put("description", t.description());
            n.set("input_schema", t.schema());
            arr.add(n);
        }
        return arr;
    }

    // ── Built-in tools ────────────────────────────────────────────────────────
    static {
        // think
        registerTool("think",
            "Reason step by step before acting. Does not call external systems.",
            schema("object", Map.of("reasoning", Map.of("type", "string")), List.of("reasoning")),
            input -> "OK"
        );

        // search
        registerTool("search",
            "Search the web for current information.",
            schema("object", Map.of("query", Map.of("type", "string")), List.of("query")),
            input -> {
                // Replace with Brave, Tavily, SerpAPI, etc.
                throw new RuntimeException("Search not wired up. query: " + input.path("query").asText());
            }
        );

        // fetch_url
        registerTool("fetch_url",
            "Fetch the text content of a URL.",
            schema("object", Map.of("url", Map.of("type", "string")), List.of("url")),
            input -> {
                String url = input.path("url").asText();
                Request req = new Request.Builder().url(url).build();
                try (Response resp = HTTP.newCall(req).execute()) {
                    String body = resp.body() != null ? resp.body().string() : "";
                    // Strip HTML tags
                    String clean = body.replaceAll("<[^>]+>", " ").replaceAll("\\s+", " ").trim();
                    return clean.length() > 8000 ? clean.substring(0, 8000) : clean;
                } catch (IOException e) {
                    throw new RuntimeException("fetch_url failed: " + e.getMessage(), e);
                }
            }
        );

        // run_bash
        registerTool("run_bash",
            "Execute a bash command. Returns stdout/stderr. Timeout 15s.",
            schema("object", Map.of("command", Map.of("type", "string")), List.of("command")),
            input -> {
                String command = input.path("command").asText();
                try {
                    ProcessBuilder pb = new ProcessBuilder("bash", "-c", command);
                    pb.redirectErrorStream(true);
                    Process proc = pb.start();
                    boolean finished = proc.waitFor(15, TimeUnit.SECONDS);
                    if (!finished) {
                        proc.destroyForcibly();
                        return "Command timed out after 15s";
                    }
                    String out = new String(proc.getInputStream().readAllBytes()).trim();
                    if (out.isEmpty()) return "(no output)";
                    return out.length() > 8000 ? out.substring(0, 8000) : out;
                } catch (Exception e) {
                    throw new RuntimeException("run_bash failed: " + e.getMessage(), e);
                }
            }
        );

        // read_file
        registerTool("read_file",
            "Read a file from disk.",
            schema("object", Map.of("path", Map.of("type", "string")), List.of("path")),
            input -> {
                try {
                    return Files.readString(Path.of(input.path("path").asText()));
                } catch (IOException e) {
                    throw new RuntimeException("read_file failed: " + e.getMessage(), e);
                }
            }
        );

        // write_file
        registerTool("write_file",
            "Write content to a file on disk.",
            schema("object",
                Map.of("path", Map.of("type", "string"), "content", Map.of("type", "string")),
                List.of("path", "content")),
            input -> {
                String path    = input.path("path").asText();
                String content = input.path("content").asText();
                try {
                    Files.writeString(Path.of(path), content);
                    return "Written " + content.length() + " bytes to " + path;
                } catch (IOException e) {
                    throw new RuntimeException("write_file failed: " + e.getMessage(), e);
                }
            }
        );

        // finish
        registerTool("finish",
            "Call when you have the final answer. Ends the loop.",
            schema("object", Map.of("answer", Map.of("type", "string")), List.of("answer")),
            input -> input.path("answer").asText()
        );
    }

    // ── Schema helper ─────────────────────────────────────────────────────────
    static JsonNode schema(String type, Map<String, Object> props, List<String> required) {
        try {
            ObjectNode n = JSON.createObjectNode();
            n.put("type", type);
            n.set("properties", JSON.valueToTree(props));
            ArrayNode req = JSON.createArrayNode();
            required.forEach(req::add);
            n.set("required", req);
            return n;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // ── API call via ModelRouter (Claude / DeepSeek / OpenAI) ─────────────────
    static ModelRouter _router = null;

    static ModelRouter getRouter() {
        if (_router == null) _router = new ModelRouter();
        return _router;
    }

    /**
     * Calls the model via ModelRouter and converts the UnifiedResponse to a JsonNode
     * in Anthropic messages-API format so the existing loop logic works unchanged
     * regardless of which provider (Claude / DeepSeek / OpenAI) is active.
     */
    static JsonNode callApi(List<Map<String, Object>> messages, String system) throws Exception {
        ModelRouter.UnifiedResponse resp = getRouter().create(messages, buildToolSchemas(), system, 4096);

        // Build a JsonNode in the same shape the loop expects:
        // { "stop_reason": "...", "usage": { "input_tokens": N, "output_tokens": N }, "content": [...] }
        ObjectNode root    = JSON.createObjectNode();
        ObjectNode usage   = JSON.createObjectNode();
        ArrayNode  content = JSON.createArrayNode();

        root.put("stop_reason", resp.stopReason);
        usage.put("input_tokens",  resp.inputTokens);
        usage.put("output_tokens", resp.outputTokens);
        root.set("usage", usage);

        for (ModelRouter.ContentBlock block : resp.content) {
            ObjectNode b = JSON.createObjectNode();
            if (block.type == ModelRouter.BlockType.TEXT) {
                b.put("type", "text");
                b.put("text", block.text != null ? block.text : "");
            } else {
                b.put("type", "tool_use");
                b.put("id",   block.id   != null ? block.id   : "");
                b.put("name", block.name != null ? block.name : "");
                if (block.input != null) {
                    b.set("input", JSON.valueToTree(block.input));
                } else {
                    b.set("input", JSON.createObjectNode());
                }
            }
            content.add(b);
        }
        root.set("content", content);
        return root;
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> buildToolSchemas() {
        List<Map<String, Object>> schemas = new ArrayList<>();
        for (ToolDef t : TOOLS.values()) {
            schemas.add(Map.of(
                "name",         t.name(),
                "description",  t.description(),
                "input_schema", t.schema()
            ));
        }
        return schemas;
    }

    // ── Core ReAct engine ─────────────────────────────────────────────────────
    static class ReactResult {
        String answer;
        Trace  trace;
        ReactResult(String answer, Trace trace) {
            this.answer = answer;
            this.trace  = trace;
        }
    }

    static ReactResult runReact(
        String task,
        String systemExtra,
        int maxIterations,
        Consumer<TraceStep> onStep
    ) throws Exception {

        String system = systemExtra == null || systemExtra.isBlank()
            ? REACT_SYSTEM
            : REACT_SYSTEM + "\n\n" + systemExtra;

        ArrayNode messages = JSON.createArrayNode();
        ObjectNode firstMsg = JSON.createObjectNode();
        firstMsg.put("role", "user");
        firstMsg.put("content", task);
        messages.add(firstMsg);

        Trace trace = new Trace();
        long startMs = System.currentTimeMillis();

        System.err.printf("[react] START: %s%n", truncate(task, 120));

        for (int i = 0; i < maxIterations; i++) {
            trace.iterations = i + 1;
            System.err.printf("[react] iteration %d%n", i + 1);

            JsonNode response = callApi(messages, system);

            long inputTokens  = response.path("usage").path("input_tokens").asLong();
            long outputTokens = response.path("usage").path("output_tokens").asLong();
            trace.totalTokens += inputTokens + outputTokens;

            JsonNode content    = response.path("content");
            String   stopReason = response.path("stop_reason").asText();

            // Append assistant turn
            ObjectNode assistantMsg = JSON.createObjectNode();
            assistantMsg.put("role", "assistant");
            assistantMsg.set("content", content);
            messages.add(assistantMsg);

            // end_turn — model responded with text
            if ("end_turn".equals(stopReason)) {
                for (JsonNode block : content) {
                    if ("text".equals(block.path("type").asText())) {
                        String answer = block.path("text").asText().trim();
                        if (!answer.isEmpty()) {
                            trace.steps.add(TraceStep.answer(answer));
                            trace.elapsedMs = System.currentTimeMillis() - startMs;
                            return new ReactResult(answer, trace);
                        }
                    }
                }
            }

            // tool_use
            if ("tool_use".equals(stopReason)) {
                ArrayNode toolResults = JSON.createArrayNode();

                for (JsonNode block : content) {
                    if (!"tool_use".equals(block.path("type").asText())) continue;

                    String   name  = block.path("name").asText();
                    String   id    = block.path("id").asText();
                    JsonNode input = block.path("input");

                    // Think
                    if ("think".equals(name)) {
                        String reasoning = input.path("reasoning").asText();
                        TraceStep step = TraceStep.thought(reasoning);
                        trace.steps.add(step);
                        if (onStep != null) onStep.accept(step);
                        System.err.printf("[react] 💭 %s%n", truncate(reasoning, 200));
                        ObjectNode tr = JSON.createObjectNode();
                        tr.put("type", "tool_result");
                        tr.put("tool_use_id", id);
                        tr.put("content", "OK");
                        toolResults.add(tr);
                        continue;
                    }

                    // Finish
                    if ("finish".equals(name)) {
                        String answer = input.path("answer").asText();
                        trace.steps.add(TraceStep.answer(answer));
                        trace.elapsedMs = System.currentTimeMillis() - startMs;
                        System.err.printf("[react] DONE — %d iters, %d tokens, %dms%n",
                            trace.iterations, trace.totalTokens, trace.elapsedMs);
                        return new ReactResult(answer, trace);
                    }

                    // Regular action
                    TraceStep actionStep = TraceStep.action(name, input);
                    trace.steps.add(actionStep);
                    if (onStep != null) onStep.accept(actionStep);
                    System.err.printf("[react] ⚡ %s(%s)%n", name, truncate(input.toString(), 200));

                    String  result  = null;
                    boolean isError = false;
                    ToolDef toolDef = TOOLS.get(name);

                    if (toolDef == null) {
                        result  = "Tool '" + name + "' not registered";
                        isError = true;
                    } else {
                        try {
                            result = toolDef.fn().apply(input);
                        } catch (Exception e) {
                            result  = "Tool error: " + e.getMessage();
                            isError = true;
                            System.err.printf("[react] ❌ %s: %s%n", name, result);
                        }
                    }

                    TraceStep obs = TraceStep.observation(result, isError);
                    trace.steps.add(obs);
                    if (onStep != null) onStep.accept(obs);
                    System.err.printf("[react] 👁 %s%n", truncate(result, 200));

                    ObjectNode tr = JSON.createObjectNode();
                    tr.put("type", "tool_result");
                    tr.put("tool_use_id", id);
                    tr.put("content", result);
                    tr.put("is_error", isError);
                    toolResults.add(tr);
                }

                ObjectNode userMsg = JSON.createObjectNode();
                userMsg.put("role", "user");
                userMsg.set("content", toolResults);
                messages.add(userMsg);
                continue;
            }

            System.err.printf("[react] unexpected stop_reason: %s%n", stopReason);
            break;
        }

        trace.elapsedMs = System.currentTimeMillis() - startMs;
        throw new RuntimeException(String.format(
            "ReAct loop did not finish within %d iterations (tokens: %d)",
            maxIterations, trace.totalTokens));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    static String truncate(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n) + "...";
    }

    // ── CLI entry point ───────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        String task = args.length > 0
            ? String.join(" ", args)
            : "Calculate the 47th Fibonacci number using bash, then explain the result.";

        ReactResult result = runReact(task, null, 30, step -> {
            switch (step.type()) {
                case "thought"     -> System.out.printf("%n💭 THOUGHT: %s%n",
                                            truncate(step.content(), 300));
                case "action"      -> System.out.printf("%n⚡ ACTION: %s(%s)%n",
                                            step.tool(),
                                            truncate(step.input() != null ? step.input().toString() : "", 200));
                case "observation" -> System.out.printf("%n%s OBSERVE: %s%n",
                                            step.error() ? "❌" : "👁",
                                            truncate(step.content(), 300));
            }
        });

        System.out.println("\n" + "=".repeat(60));
        System.out.println("FINAL ANSWER:");
        System.out.println(result.answer);
        System.out.println("=".repeat(60));
        System.out.printf("Iterations: %d | Tokens: %d | Time: %dms%n",
            result.trace.iterations, result.trace.totalTokens, result.trace.elapsedMs);

        System.out.println("\nFull trace:");
        ArrayNode traceJson = JSON.createArrayNode();
        result.trace.steps.forEach(s -> traceJson.add(s.toJson()));
        System.out.println(JSON.writerWithDefaultPrettyPrinter().writeValueAsString(traceJson));
    }
}
