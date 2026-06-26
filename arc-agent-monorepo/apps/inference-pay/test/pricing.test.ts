import { describe, it, expect } from 'vitest';

// Inference pricing (USDC per 1k tokens) — sourced from May 2026 rates
const INFERENCE_PRICING = {
  'claude-sonnet-4-20250514': { inputPer1k: 0.003, outputPer1k: 0.015 },
  'claude-haiku-4-5': { inputPer1k: 0.00025, outputPer1k: 0.00125 },
  'gpt-4o': { inputPer1k: 0.005, outputPer1k: 0.015 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
} as const;

type ModelId = keyof typeof INFERENCE_PRICING;

function calculateCost(model: ModelId, inputTokens: number, outputTokens: number): number {
  const pricing = INFERENCE_PRICING[model];
  return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
}

function isNanopayable(costUSDC: number): boolean {
  return costUSDC >= 0.000001; // $0.000001 = minimum nanopayment unit
}

describe('Inference cost calculations', () => {
  describe('calculateCost', () => {
    it('calculates Claude Haiku cost for short inference', () => {
      // 100 input + 50 output tokens
      const cost = calculateCost('claude-haiku-4-5', 100, 50);
      const expected = (100 / 1000) * 0.00025 + (50 / 1000) * 0.00125;
      expect(cost).toBeCloseTo(expected, 8);
    });

    it('calculates Claude Sonnet cost for medium inference', () => {
      // 1000 input + 500 output
      const cost = calculateCost('claude-sonnet-4-20250514', 1000, 500);
      const expected = (1000 / 1000) * 0.003 + (500 / 1000) * 0.015;
      expect(cost).toBeCloseTo(expected, 8); // $0.003 + $0.0075 = $0.0105
    });

    it('calculates GPT-4o cost for large inference', () => {
      const cost = calculateCost('gpt-4o', 4000, 1000);
      const expected = (4000 / 1000) * 0.005 + (1000 / 1000) * 0.015;
      expect(cost).toBeCloseTo(expected, 6); // $0.02 + $0.015 = $0.035
    });

    it('calculates GPT-4o-mini as cheapest option', () => {
      const miniCost = calculateCost('gpt-4o-mini', 1000, 1000);
      const sonnetCost = calculateCost('claude-sonnet-4-20250514', 1000, 1000);
      const haikuCost = calculateCost('claude-haiku-4-5', 1000, 1000);
      const gptCost = calculateCost('gpt-4o', 1000, 1000);

      expect(miniCost).toBeLessThan(haikuCost);
      expect(miniCost).toBeLessThan(sonnetCost);
      expect(miniCost).toBeLessThan(gptCost);
    });

    it('Haiku is cheaper than Sonnet', () => {
      const haikuCost = calculateCost('claude-haiku-4-5', 1000, 1000);
      const sonnetCost = calculateCost('claude-sonnet-4-20250514', 1000, 1000);
      expect(haikuCost).toBeLessThan(sonnetCost);
    });

    it('cost is zero for zero tokens', () => {
      expect(calculateCost('claude-haiku-4-5', 0, 0)).toBe(0);
    });

    it('short Haiku inference is a nanopayment (sub-cent)', () => {
      // 10 input + 5 output tokens
      const cost = calculateCost('claude-haiku-4-5', 10, 5);
      expect(cost).toBeLessThan(0.01); // sub-cent
      expect(cost).toBeGreaterThan(0); // but positive
    });
  });

  describe('isNanopayable', () => {
    it('$0.000001 is nanopayable (minimum)', () => {
      expect(isNanopayable(0.000001)).toBe(true);
    });

    it('$0.001 is nanopayable', () => {
      expect(isNanopayable(0.001)).toBe(true);
    });

    it('$1.00 is nanopayable', () => {
      expect(isNanopayable(1.0)).toBe(true);
    });

    it('$0.0000009 is below minimum nanopayment', () => {
      expect(isNanopayable(0.0000009)).toBe(false);
    });
  });

  describe('INFERENCE_PRICING constants', () => {
    it('all models have input and output pricing defined', () => {
      for (const [model, pricing] of Object.entries(INFERENCE_PRICING)) {
        expect(pricing.inputPer1k).toBeGreaterThan(0);
        expect(pricing.outputPer1k).toBeGreaterThan(0);
        expect(pricing.outputPer1k).toBeGreaterThanOrEqual(pricing.inputPer1k);
      }
    });

    it('output tokens are more expensive than input tokens for all models', () => {
      for (const pricing of Object.values(INFERENCE_PRICING)) {
        expect(pricing.outputPer1k).toBeGreaterThan(pricing.inputPer1k);
      }
    });
  });
});
