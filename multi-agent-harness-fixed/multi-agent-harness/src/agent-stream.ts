// src/agent-stream.ts
// Streaming version of the agent runner.
// Each provider streams tokens to stdout as they arrive.
// Returns the same AgentResult shape as the non-streaming runner.

import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { deepseek } from "@ai-sdk/deepseek";
import type { AgentConfig, AgentTask, AgentResult } from "./types.js";

const PROVIDER_COLORS: Record<string, string> = {
  claude:   "\x1b[35m", // magenta
  openai:   "\x1b[32m", // green
  groq:     "\x1b[33m", // yellow
  deepseek: "\x1b[36m", // cyan
};
const RESET = "\x1b[0m";

function getModel(config: AgentConfig) {
  switch (config.provider) {
    case "claude":   return anthropic(config.model);
    case "openai":   return openai(config.model);
    case "groq":     return groq(config.model);
    case "deepseek": return deepseek(config.model);
    default: throw new Error(`Unknown provider: ${config.provider}`);
  }
}

// Streams a single agent + task. Prints tokens live to stdout with a provider prefix.
export async function runAgentStream(
  config: AgentConfig,
  task: AgentTask
): Promise<AgentResult> {
  const start = Date.now();
  const provColor = PROVIDER_COLORS[config.provider] ?? "";
  const prefix = `${provColor}[${config.provider}/${config.model}]${RESET} `;

  try {
    const model = getModel(config);
    let fullText = "";

    const { textStream, usage } = streamText({
      model,
      system: config.systemPrompt ?? task.systemPrompt,
      prompt: task.prompt,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 2048,
    });

    process.stdout.write(`\n${prefix}`);

    for await (const chunk of textStream) {
      process.stdout.write(chunk);
      fullText += chunk;
    }

    process.stdout.write("\n");

    const resolvedUsage = await usage;

    return {
      agentId: config.id,
      provider: config.provider,
      model: config.model,
      task,
      text: fullText,
      durationMs: Date.now() - start,
      tokensUsed: resolvedUsage
        ? {
            prompt: resolvedUsage.promptTokens,
            completion: resolvedUsage.completionTokens,
            total: resolvedUsage.totalTokens,
          }
        : undefined,
    };
  } catch (err) {
    return {
      agentId: config.id,
      provider: config.provider,
      model: config.model,
      task,
      text: "",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
