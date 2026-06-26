// src/fallback-chain.ts
// Provider fallback chain.
// If the primary provider fails (error or circuit open), automatically retries
// with the next provider in the chain using the same task.
// Useful for production reliability: never drop a task because one provider is down.

import { runAgent } from "./agent.js";
import { circuitBreakers } from "./resilience.js";
import type { AgentConfig, AgentTask, AgentResult } from "./types.js";

export interface FallbackChainConfig {
  // Ordered list of agents to try. First one is primary, rest are fallbacks.
  chain: AgentConfig[];
  // If true, logs which fallback was used
  verbose?: boolean;
}

export async function runWithFallback(
  config: FallbackChainConfig,
  task: AgentTask
): Promise<AgentResult> {
  const { chain, verbose = true } = config;

  if (chain.length === 0) {
    throw new Error("[fallback-chain] Chain is empty.");
  }

  let lastResult: AgentResult | null = null;

  for (let i = 0; i < chain.length; i++) {
    const agent = chain[i];
    const isFallback = i > 0;

    // Check circuit breaker before attempting
    if (circuitBreakers.isOpen(agent.provider)) {
      if (verbose) {
        console.warn(
          `  [fallback] ${agent.provider}/${agent.model} circuit is OPEN. Skipping.`
        );
      }
      continue;
    }

    if (isFallback && verbose) {
      console.warn(
        `  [fallback] Falling back to ${agent.provider}/${agent.model} (attempt ${i + 1}/${chain.length})`
      );
    }

    const result = await runAgent(agent, task);

    if (!result.error) {
      circuitBreakers.recordSuccess(agent.provider);
      if (isFallback && verbose) {
        console.log(
          `  [fallback] Succeeded on fallback ${i + 1}: ${agent.provider}/${agent.model}`
        );
      }
      return result;
    }

    // Record failure and try next
    circuitBreakers.recordFailure(agent.provider);
    lastResult = result;

    if (verbose) {
      console.warn(
        `  [fallback] ${agent.provider}/${agent.model} failed: ${result.error}`
      );
    }
  }

  // All providers failed — return the last error result
  console.error("[fallback] All providers in chain failed.");
  return lastResult ?? {
    agentId: "fallback-chain",
    provider: "none",
    model: "none",
    task,
    text: "",
    durationMs: 0,
    error: "All providers in fallback chain failed.",
  };
}

// ── Convenience: build a fallback chain from a priority order of providers ──
export function buildFallbackChain(
  primaryProvider: AgentConfig["provider"],
  model: string,
  fallbackOrder: Array<{ provider: AgentConfig["provider"]; model: string }>,
  baseConfig: Partial<AgentConfig> = {}
): FallbackChainConfig {
  const chain: AgentConfig[] = [
    {
      id: `primary-${primaryProvider}`,
      provider: primaryProvider,
      model,
      ...baseConfig,
    },
    ...fallbackOrder.map((f, i) => ({
      id: `fallback-${i + 1}-${f.provider}`,
      provider: f.provider,
      model: f.model,
      ...baseConfig,
    })),
  ];

  return { chain, verbose: true };
}
