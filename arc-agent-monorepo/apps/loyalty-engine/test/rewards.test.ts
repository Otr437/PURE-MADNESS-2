import { describe, it, expect } from 'vitest';
import type { SupportedChain } from '@arc-agents/shared-types';

// Reward claim heuristics — pure functions extracted for unit testing

const BRIDGE_COSTS: Record<string, number> = {
  'Arc_Testnet-Arc_Testnet': 0,
  'Arc_Testnet-Base': 0,           // CCTPv2: zero protocol fee
  'Arc_Testnet-Ethereum': 0,       // CCTPv2: zero protocol fee
  'Base-Arc_Testnet': 0,
  'Base-Ethereum': 0,
  'Ethereum-Arc_Testnet': 0,
  'Ethereum-Base': 0,
};

function estimateBridgeCost(fromChain: SupportedChain, toChain: SupportedChain): number {
  return BRIDGE_COSTS[`${fromChain}-${toChain}`] ?? 0.5; // Unknown routes: conservative $0.50
}

function isRewardWorthClaiming(
  rewardAmountUSDC: number,
  fromChain: SupportedChain,
  toChain: SupportedChain,
  gasCostUSDC = 0
): { shouldClaim: boolean; netGain: number; reason: string } {
  const bridgeCost = estimateBridgeCost(fromChain, toChain);
  const totalCost = bridgeCost + gasCostUSDC;
  const netGain = rewardAmountUSDC - totalCost;

  if (netGain <= 0) {
    return {
      shouldClaim: false,
      netGain,
      reason: `Bridge/gas cost ($${totalCost.toFixed(6)}) exceeds reward ($${rewardAmountUSDC})`,
    };
  }

  // Minimum threshold: reward must cover costs with 10% buffer
  const isWorthIt = netGain > totalCost * 0.1 || rewardAmountUSDC > 0.01;
  return {
    shouldClaim: isWorthIt,
    netGain,
    reason: isWorthIt
      ? `Net gain: $${netGain.toFixed(6)} after $${totalCost.toFixed(6)} costs`
      : `Marginal gain insufficient`,
  };
}

function recommendConsolidationChain(
  balances: Array<{ chain: SupportedChain; balance: number }>
): SupportedChain {
  // Prefer Arc_Testnet for zero-gas operations
  const arcBalance = balances.find((b) => b.chain === 'Arc_Testnet');
  if (arcBalance && arcBalance.balance > 0) return 'Arc_Testnet';

  // Then Base for low gas
  const baseBalance = balances.find((b) => b.chain === 'Base');
  if (baseBalance && baseBalance.balance > 0) return 'Base';

  // Fallback to chain with highest balance
  const sorted = [...balances].sort((a, b) => b.balance - a.balance);
  return sorted[0]?.chain ?? 'Arc_Testnet';
}

describe('Reward claim heuristics', () => {
  describe('estimateBridgeCost', () => {
    it('returns zero for Arc_Testnet → Base (CCTPv2 protocol fee is zero)', () => {
      expect(estimateBridgeCost('Arc_Testnet', 'Base')).toBe(0);
    });

    it('returns zero for same-chain', () => {
      expect(estimateBridgeCost('Arc_Testnet', 'Arc_Testnet')).toBe(0);
    });

    it('returns conservative estimate for unknown route', () => {
      expect(estimateBridgeCost('Arc_Testnet', 'Solana')).toBe(0.5);
    });
  });

  describe('isRewardWorthClaiming', () => {
    it('claims $1 reward on Arc with no bridge cost', () => {
      const result = isRewardWorthClaiming(1.0, 'Arc_Testnet', 'Arc_Testnet');
      expect(result.shouldClaim).toBe(true);
      expect(result.netGain).toBe(1.0);
    });

    it('claims $0.01 reward (above minimum threshold)', () => {
      const result = isRewardWorthClaiming(0.01, 'Arc_Testnet', 'Base');
      expect(result.shouldClaim).toBe(true);
    });

    it('does not claim when bridge cost exceeds reward', () => {
      // $0.001 reward, but unknown route costs $0.50
      const result = isRewardWorthClaiming(0.001, 'Arc_Testnet', 'Solana');
      expect(result.shouldClaim).toBe(false);
      expect(result.netGain).toBeLessThan(0);
    });

    it('defers sub-threshold nanopayment reward on expensive route', () => {
      const result = isRewardWorthClaiming(0.0001, 'Arc_Testnet', 'Solana');
      expect(result.shouldClaim).toBe(false);
    });

    it('claims $0.000001 nanopayment reward on Arc (zero gas)', () => {
      const result = isRewardWorthClaiming(0.000001, 'Arc_Testnet', 'Arc_Testnet', 0);
      expect(result.shouldClaim).toBe(true);
      expect(result.netGain).toBe(0.000001);
    });

    it('accounts for gas cost separately from bridge cost', () => {
      // $0.005 reward, CCTPv2 bridge (free), but Ethereum gas = $1.00
      const result = isRewardWorthClaiming(0.005, 'Arc_Testnet', 'Ethereum', 1.0);
      expect(result.shouldClaim).toBe(false);
    });
  });

  describe('recommendConsolidationChain', () => {
    it('prefers Arc_Testnet for zero-gas ops', () => {
      const balances = [
        { chain: 'Arc_Testnet' as SupportedChain, balance: 10 },
        { chain: 'Base' as SupportedChain, balance: 50 },
        { chain: 'Ethereum' as SupportedChain, balance: 100 },
      ];
      expect(recommendConsolidationChain(balances)).toBe('Arc_Testnet');
    });

    it('falls back to Base when no Arc balance', () => {
      const balances = [
        { chain: 'Arc_Testnet' as SupportedChain, balance: 0 },
        { chain: 'Base' as SupportedChain, balance: 50 },
        { chain: 'Ethereum' as SupportedChain, balance: 10 },
      ];
      expect(recommendConsolidationChain(balances)).toBe('Base');
    });

    it('falls back to highest balance chain when no Arc/Base', () => {
      const balances = [
        { chain: 'Arc_Testnet' as SupportedChain, balance: 0 },
        { chain: 'Base' as SupportedChain, balance: 0 },
        { chain: 'Ethereum' as SupportedChain, balance: 100 },
        { chain: 'Arbitrum' as SupportedChain, balance: 50 },
      ];
      expect(recommendConsolidationChain(balances)).toBe('Ethereum');
    });

    it('defaults to Arc_Testnet with empty balances', () => {
      expect(recommendConsolidationChain([])).toBe('Arc_Testnet');
    });
  });
});
