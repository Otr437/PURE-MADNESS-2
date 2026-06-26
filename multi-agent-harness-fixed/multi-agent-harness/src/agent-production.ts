// src/agent-production.ts
// Production-grade agent runner.
// Wraps runAgent with: rate limiting → circuit breaker → retry → cost tracking → tracing.
// Drop-in replacement for agent.ts in production contexts.

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { deepseek } from "@ai-sdk/deepseek";
import { withRetry, circuitBreakers, DEFAULT_RETRY } from "./resilience.js";
import { rateLimiter } from "./rate-limiter.js";
import { costTracker } from "./cost-tracker.js";
import { tracer } from "./observability.js";
import type { AgentConfig, AgentTask, AgentResult } from "./types.js";

function getModel(config: AgentConfig) {
  switch (config.provider) {
    case "claude":   return anthropic(config.model);
    case "openai":   return openai(config.model);
    case "groq":     return groq(config.model);
    case "deepseek": return deepseek(config.model);
    default: throw new Error(`Unknown provider: ${config.provider}`);
  }
}

// Determines if an error is retryable (network errors, 429s, 500s).
// Does NOT retry on 400 (bad request) or 401 (auth) — those won't self-heal.
function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit"))  return true;
    if (msg.includes("500") || msg.includes("502") || msg.includes("503")) return true;
    if (msg.includes("timeout") || msg.includes("econnreset")) return true;
    if (msg.includes("400") || msg.includes("401") || msg.includes("403")) return false;
  }
  return true; // retry on unknown errors
}

export async function runAgentProduction(
  config: AgentConfig,
  task: AgentTask
): Promise<AgentResult> {
  const label = `${config.provider}/${config.model}:${task.id}`;

  // ── 1. Acquire rate-limit token ───────────────────────────────────────────
  await rateLimiter.acquire(config.provider);

  // ── 2. Check circuit breaker ──────────────────────────────────────────────
  if (circuitBreakers.isOpen(config.provider)) {
    const err = `Circuit breaker OPEN for provider: ${config.provider}`;
    console.error(`  [production] ${err}`);
    return {
      agentId: config.id,
      provider: config.provider,
      model: config.model,
      task,
      text: "",
      durationMs: 0,
      error: err,
    };
  }

  // ── 3. Trace + retry wrapper ───────────────────────────────────────────────
  return tracer.trace(
    "agent.run",
    { provider: config.provider, model: config.model, taskId: task.id },
    async (span) => {
      const start = Date.now();

      try {
        const result = await withRetry(
          async () => {
            const model = getModel(config);

            const { text, usage } = await generateText({
              model,
              system: config.systemPrompt ?? task.systemPrompt,
              prompt: task.prompt,
              temperature: config.temperature ?? 0.7,
              maxTokens: config.maxTokens ?? 2048,
            });

            // ── 4. Track cost ───────────────────────────────────────────────
            if (usage) {
              const cost = costTracker.track(
                config.provider,
                config.model,
                usage.promptTokens,
                usage.completionTokens
              );
              span.attributes.estimatedUSD = cost.estimatedUSD;
              span.attributes.totalTokens = cost.totalTokens;
            }

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
          },
          { ...DEFAULT_RETRY, retryOn: isRetryable },
          label
        );

        circuitBreakers.recordSuccess(config.provider);
        return result;

      } catch (err) {
        circuitBreakers.recordFailure(config.provider);
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          agentId: config.id,
          provider: config.provider,
          model: config.model,
          task,
          text: "",
          durationMs: Date.now() - start,
          error: errorMsg,
        };
      }
    }
  );
}
