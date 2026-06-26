// src/cost-tracker.ts
// Tracks token usage and estimated USD cost per provider/model.
// Pricing as of May 2026 — update PRICING_TABLE if rates change.

export interface TokenCost {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedUSD: number;
}

// Prices in USD per 1M tokens (input / output)
// Sources (May 2026):
//   Claude:   https://www.anthropic.com/pricing
//   OpenAI:   https://openai.com/api/pricing
//   Groq:     https://console.groq.com/settings/billing
//   DeepSeek: https://platform.deepseek.com/usage
const PRICING_TABLE: Record<
  string,
  { inputPer1M: number; outputPer1M: number }
> = {
  // Anthropic
  "claude-opus-4-7":    { inputPer1M: 5.00,  outputPer1M: 25.00 },
  "claude-opus-4-6":    { inputPer1M: 5.00,  outputPer1M: 25.00 },
  "claude-sonnet-4-6":  { inputPer1M: 3.00,  outputPer1M: 15.00 },

  // OpenAI
  "gpt-5.5-2026-04-23": { inputPer1M: 10.00, outputPer1M: 30.00 },
  "chat-latest":        { inputPer1M: 2.50,  outputPer1M: 10.00 },

  // Groq (LPU inference — typically cheaper than direct provider)
  "openai/gpt-oss-120b":        { inputPer1M: 0.90,  outputPer1M: 0.90  },
  "deepseek-r1-distill-llama-70b": { inputPer1M: 0.75, outputPer1M: 0.99 },

  // DeepSeek
  "deepseek-v4-pro":   { inputPer1M: 0.27,  outputPer1M: 1.10  }, // promo until 2026-05-31; full: $2.19/$8.19
  "deepseek-v4-flash": { inputPer1M: 0.07,  outputPer1M: 0.28  },
};

function getPricing(model: string) {
  if (PRICING_TABLE[model]) return PRICING_TABLE[model];
  // Partial match fallback (e.g. "claude-opus-4-7-20260501" → "claude-opus-4-7")
  for (const [key, price] of Object.entries(PRICING_TABLE)) {
    if (model.startsWith(key)) return price;
  }
  return null;
}

function estimateUSD(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = getPricing(model);
  if (!pricing) return 0;
  return (
    (promptTokens / 1_000_000) * pricing.inputPer1M +
    (completionTokens / 1_000_000) * pricing.outputPer1M
  );
}

interface UsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedUSD: number;
  timestamp: number;
}

export class CostTracker {
  private records: UsageRecord[] = [];
  private ceilUSD: number | null = null;

  // Optionally set a hard ceiling. runAgent will throw if exceeded.
  setCostCeiling(usd: number): void {
    this.ceilUSD = usd;
  }

  track(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number
  ): TokenCost {
    const totalTokens = promptTokens + completionTokens;
    const estimatedUSD = estimateUSD(model, promptTokens, completionTokens);

    this.records.push({
      provider,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedUSD,
      timestamp: Date.now(),
    });

    const runningTotal = this.totalUSD();
    if (this.ceilUSD !== null && runningTotal > this.ceilUSD) {
      throw new Error(
        `[cost-tracker] CEILING EXCEEDED: $${runningTotal.toFixed(4)} > $${this.ceilUSD.toFixed(4)}. Halting.`
      );
    }

    return { promptTokens, completionTokens, totalTokens, estimatedUSD };
  }

  totalUSD(): number {
    return this.records.reduce((sum, r) => sum + r.estimatedUSD, 0);
  }

  totalTokens(): number {
    return this.records.reduce((sum, r) => sum + r.totalTokens, 0);
  }

  byProvider(): Record<
    string,
    { calls: number; totalTokens: number; totalUSD: number }
  > {
    const out: Record<
      string,
      { calls: number; totalTokens: number; totalUSD: number }
    > = {};
    for (const r of this.records) {
      if (!out[r.provider]) {
        out[r.provider] = { calls: 0, totalTokens: 0, totalUSD: 0 };
      }
      out[r.provider].calls++;
      out[r.provider].totalTokens += r.totalTokens;
      out[r.provider].totalUSD += r.estimatedUSD;
    }
    return out;
  }

  printSummary(): void {
    console.log("\n[cost-tracker] ─────────────────────────────");
    console.log(`  Total tokens : ${this.totalTokens().toLocaleString()}`);
    console.log(`  Estimated USD: $${this.totalUSD().toFixed(4)}`);
    if (this.ceilUSD !== null) {
      console.log(`  Ceiling      : $${this.ceilUSD.toFixed(4)}`);
    }
    console.log("  By provider  :");
    for (const [provider, stats] of Object.entries(this.byProvider())) {
      console.log(
        `    ${provider.padEnd(12)} calls=${stats.calls}  tokens=${stats.totalTokens.toLocaleString()}  est=$${stats.totalUSD.toFixed(4)}`
      );
    }
    console.log("[cost-tracker] ─────────────────────────────\n");
  }

  reset(): void {
    this.records = [];
  }
}

// Singleton used across the harness
export const costTracker = new CostTracker();
