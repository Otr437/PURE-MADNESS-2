/**
 * Plug-and-play Agentic Loop — TypeScript
 * Multi-provider via ModelRouter (Claude / DeepSeek / OpenAI).
 * All tools are real implementations from toolRegistry — no stubs.
 *
 * export MODEL_PROVIDER=anthropic|deepseek|openai
 * export ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
 * npx ts-node src/agent_loop.ts
 */

import * as process from "process";
import { ModelRouter, TextBlock, ToolUseBlock, makeToolResultMessage } from "./model_router";
import { toolRegistry, toolSchemas } from "./react_loop";

/**
 * Minimal single-shot agentic loop using ModelRouter + toolRegistry.
 * For multi-step ReAct behaviour with Thought/Act/Observe, use runReact() instead.
 */
export async function agentLoop(
  userMessage: string,
  maxIterations = 10,
  system?: string,
): Promise<string> {
  const router  = new ModelRouter();
  const messages: object[] = [{ role: "user", content: userMessage }];

  process.stderr.write(`[agent_loop] provider=${router.provider} model=${router.model}\n`);

  for (let i = 0; i < maxIterations; i++) {
    process.stderr.write(`[agent_loop] iteration ${i + 1}\n`);

    const resp = await router.create(messages, {
      tools:     toolSchemas as object[],
      system,
      maxTokens: 4096,
    });

    messages.push(router.toAssistantMessage(resp));

    if (resp.stopReason === "end_turn") {
      for (const block of resp.content) {
        if (block.type === "text") {
          const t = (block as TextBlock).text.trim();
          if (t) return t;
        }
      }
    }

    if (resp.stopReason === "tool_use") {
      const contentBlocks: object[] = [];

      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        const tb = block as ToolUseBlock;

        // finish tool — return answer immediately
        if (tb.name === "finish") {
          return String((tb.input as any).answer ?? "");
        }

        const inputStr = JSON.stringify(tb.input).slice(0, 120);
        process.stderr.write(`[agent_loop] ⚡ ${tb.name}(${inputStr})\n`);

        let result: string;
        let isError = false;
        const fn = toolRegistry.get(tb.name);
        if (!fn) {
          result  = `Tool '${tb.name}' is not registered`;
          isError = true;
        } else {
          try {
            result = String(await Promise.resolve(fn(tb.input as any)));
          } catch (e) {
            result  = `Tool error (${tb.name}): ${e}`;
            isError = true;
          }
        }

        process.stderr.write(`[agent_loop] 👁 ${result.slice(0, 120)}\n`);
        const msg = makeToolResultMessage(tb.id, result, isError) as any;
        contentBlocks.push(...(msg.content as object[]));
      }

      messages.push({ role: "user", content: contentBlocks });
      continue;
    }

    process.stderr.write(`[agent_loop] unexpected stopReason=${resp.stopReason}\n`);
    break;
  }

  throw new Error(`AgentLoop did not finish within ${maxIterations} iterations`);
}

// ── CLI demo ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const task = process.argv.slice(2).join(" ") || "Use bash to find the current date and time, then report it.";
  process.stderr.write(`[agent_loop_demo] task: ${task}\n`);
  agentLoop(task, 10, "You are a helpful assistant. Use provided tools to complete tasks.")
    .then((answer) => process.stdout.write(answer + "\n"))
    .catch((err) => {
      process.stderr.write(`[agent_loop_demo] ERROR: ${err}\n`);
      process.exit(1);
    });
}
