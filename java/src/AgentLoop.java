/**
 * Plug-and-play Agentic Loop — Java
 * Multi-provider via ModelRouter (Claude / DeepSeek / OpenAI).
 * All tools are real implementations from ReactLoop.TOOL_REGISTRY — no stubs.
 *
 * export MODEL_PROVIDER=anthropic|deepseek|openai
 * export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
 * java -cp target/rag-ai-java-1.0.0.jar AgentLoop "your task"
 */

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.*;

import java.util.*;

public class AgentLoop {

    static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Minimal single-shot agentic loop using ModelRouter + ReactLoop.TOOL_REGISTRY.
     * For multi-step ReAct behaviour with Thought/Act/Observe, use ReactLoop.runReact() instead.
     */
    @SuppressWarnings("unchecked")
    public static String agentLoop(
        String userMessage,
        int maxIterations,
        String systemPrompt
    ) throws Exception {
        ModelRouter router = new ModelRouter();
        System.err.printf("[agent_loop] provider=%s model=%s%n", router.provider, router.model);

        List<Map<String, Object>> messages = new ArrayList<>();
        messages.add(Map.of("role", "user", "content", userMessage));

        for (int i = 0; i < maxIterations; i++) {
            System.err.printf("[agent_loop] iteration %d%n", i + 1);

            ModelRouter.UnifiedResponse resp = router.create(
                messages,
                ReactLoop.buildToolSchemas(),
                systemPrompt,
                4096
            );

            messages.add(resp.toAssistantMessage());

            if ("end_turn".equals(resp.stopReason)) {
                for (ModelRouter.ContentBlock block : resp.content) {
                    if (block.type == ModelRouter.BlockType.TEXT && block.text != null && !block.text.isBlank()) {
                        return block.text.trim();
                    }
                }
            }

            if ("tool_use".equals(resp.stopReason)) {
                List<Map<String, Object>> toolResultBlocks = new ArrayList<>();
                for (ModelRouter.ContentBlock block : resp.content) {
                    if (block.type != ModelRouter.BlockType.TOOL_USE) continue;

                    // finish tool — return answer immediately
                    if ("finish".equals(block.name)) {
                        Object answer = block.input != null ? block.input.get("answer") : null;
                        return answer != null ? answer.toString() : "";
                    }

                    String inputStr = JSON.writeValueAsString(block.input);
                    System.err.printf("[agent_loop] ⚡ %s(%s)%n",
                        block.name, inputStr.length() > 120 ? inputStr.substring(0, 120) : inputStr);

                    String result;
                    boolean isError = false;
                    ReactLoop.ToolDef toolDef = ReactLoop.TOOLS.get(block.name);
                    ReactLoop.ToolFn fn = toolDef != null ? toolDef.fn() : null;
                    if (fn == null) {
                        result  = "Tool '" + block.name + "' is not registered";
                        isError = true;
                    } else {
                        try {
                            com.fasterxml.jackson.databind.JsonNode inputNode =
                                block.input != null
                                    ? JSON.valueToTree(block.input)
                                    : JSON.createObjectNode();
                            result = fn.apply(inputNode);
                        } catch (Exception e) {
                            result  = "Tool error (" + block.name + "): " + e.getMessage();
                            isError = true;
                        }
                    }

                    System.err.printf("[agent_loop] 👁 %s%n", result.length() > 120 ? result.substring(0, 120) : result);

                    Map<String, Object> tr = new LinkedHashMap<>();
                    tr.put("type", "tool_result");
                    tr.put("tool_use_id", block.id);
                    tr.put("content", result);
                    if (isError) tr.put("is_error", true);
                    toolResultBlocks.add(tr);
                }
                messages.add(Map.of("role", "user", "content", toolResultBlocks));
                continue;
            }

            System.err.printf("[agent_loop] unexpected stop_reason=%s%n", resp.stopReason);
            break;
        }

        throw new RuntimeException("AgentLoop did not finish within " + maxIterations + " iterations");
    }

    public static void main(String[] args) throws Exception {
        String task = args.length > 0
            ? String.join(" ", args)
            : "Use bash to find the current date and time, then report it.";
        System.err.printf("[agent_loop_demo] task: %s%n", task);
        String answer = agentLoop(task, 10, "You are a helpful assistant. Use provided tools to complete tasks.");
        System.out.println(answer);
    }
}
