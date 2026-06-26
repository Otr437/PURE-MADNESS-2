// src/agent.ts
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { deepseek } from "@ai-sdk/deepseek";
import type { AgentConfig, AgentTask, AgentResult } from "./types.js";

function getModel(config: AgentConfig) {
  switch (config.provider) {
    case "claude":
      return anthropic(config.model);
    case "openai":
      return openai(config.model);
    case "groq":
      return groq(config.model);
    case "deepseek":
      return deepseek(config.model);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export async function runAgent(
  config: AgentConfig,
  task: AgentTask
): Promise<AgentResult> {
  const start = Date.now();

  try {
    const model = getModel(config);

    const { text, usage } = await generateText({
      model,
      system: config.systemPrompt ?? task.systemPrompt,
      prompt: task.prompt,
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 2048,
    });

    return {
      agentId: config.id,
      provider: config.provider,
      model: config.model,
      task,
      text,
      durationMs: Date.now() - start,
      tokensUsed: usage
        ? {
            prompt: usage.promptTokens,
            completion: usage.completionTokens,
            total: usage.totalTokens,
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
