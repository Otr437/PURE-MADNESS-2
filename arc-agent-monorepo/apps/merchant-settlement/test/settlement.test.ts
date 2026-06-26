import { describe, it, expect } from 'vitest';
import type { SupportedChain } from '@arc-agents/shared-types';

// Settlement allocation logic for unit testing
interface AllocationInput {
  counterpartyId: string;
  address: string;
  chain: SupportedChain;
  preferredChain?: SupportedChain;
  amountUSDC: number;
}

function buildAllocations(
  counterparties: AllocationInput[],
  defaultChain: SupportedChain
) {
  return counterparties.map((cp) => ({
    counterpartyId: cp.counterpartyId,
    amount: String(Math.round(cp.amountUSDC * 1e6)),
    chain: cp.preferredChain ?? defaultChain,
    requiresBridge: (cp.preferredChain ?? defaultChain) !== defaultChain,
  }));
}

function validateAllocationSum(
  allocations: Array<{ amount: string }>,
  totalExpectedUSDC: number
): boolean {
  const total = allocations.reduce((sum, a) => sum + parseInt(a.amount), 0);
  const expected = Math.round(totalExpectedUSDC * 1e6);
  return total === expected;
}

function requiresBridging(
  fromChain: SupportedChain,
  toChain: SupportedChain
): boolean {
  return fromChain !== toChain;
}

describe('Settlement allocation logic', () => {
  describe('buildAllocations', () => {
    it('builds allocations with correct amounts', () => {
      const counterparties: AllocationInput[] = [
        { counterpartyId: 'cp-1', address: '0x1', chain: 'Arc_Testnet', amountUSDC: 50 },
        { counterpartyId: 'cp-2', address: '0x2', chain: 'Base', amountUSDC: 30 },
        { counterpartyId: 'cp-3', address: '0x3', chain: 'Ethereum', amountUSDC: 20 },
      ];

      const allocations = buildAllocations(counterparties, 'Arc_Testnet');

      expect(allocations).toHaveLength(3);
      expect(allocations[0]?.amount).toBe('50000000');
      expect(allocations[1]?.amount).toBe('30000000');
      expect(allocations[2]?.amount).toBe('20000000');
    });

    it('marks cross-chain allocations as requiring bridge', () => {
      const counterparties: AllocationInput[] = [
        { counterpartyId: 'cp-1', address: '0x1', chain: 'Arc_Testnet', amountUSDC: 50 },
        {
          counterpartyId: 'cp-2',
          address: '0x2',
          chain: 'Base',
          preferredChain: 'Base',
          amountUSDC: 30,
        },
      ];

      const allocations = buildAllocations(counterparties, 'Arc_Testnet');

      expect(allocations[0]?.requiresBridge).toBe(false); // same chain
      expect(allocations[1]?.requiresBridge).toBe(true);  // Arc → Base
    });

    it('uses default chain when no preferred chain set', () => {
      const counterparties: AllocationInput[] = [
        { counterpartyId: 'cp-1', address: '0x1', chain: 'Base', amountUSDC: 100 },
      ];

      const allocations = buildAllocations(counterparties, 'Arc_Testnet');
      expect(allocations[0]?.chain).toBe('Arc_Testnet');
      expect(allocations[0]?.requiresBridge).toBe(false);
    });

    it('uses preferred chain when set', () => {
      const counterparties: AllocationInput[] = [
        {
          counterpartyId: 'cp-1',
          address: '0x1',
          chain: 'Arc_Testnet',
          preferredChain: 'Ethereum',
          amountUSDC: 100,
        },
      ];

      const allocations = buildAllocations(counterparties, 'Arc_Testnet');
      expect(allocations[0]?.chain).toBe('Ethereum');
      expect(allocations[0]?.requiresBridge).toBe(true);
    });
  });

  describe('validateAllocationSum', () => {
    it('validates correct sum', () => {
      const allocations = [
        { amount: '50000000' },  // $50
        { amount: '30000000' },  // $30
        { amount: '20000000' },  // $20
      ];
      expect(validateAllocationSum(allocations, 100)).toBe(true);
    });

    it('rejects incorrect sum', () => {
      const allocations = [
        { amount: '50000000' },
        { amount: '30000000' },
      ];
      expect(validateAllocationSum(allocations, 100)).toBe(false); // $80 ≠ $100
    });

    it('validates single allocation', () => {
      expect(validateAllocationSum([{ amount: '1000000' }], 1.0)).toBe(true);
    });

    it('validates nanopayment-sized allocation ($0.000001)', () => {
      expect(validateAllocationSum([{ amount: '1' }], 0.000001)).toBe(true);
    });
  });

  describe('requiresBridging', () => {
    it('Arc_Testnet → Base requires bridging', () => {
      expect(requiresBridging('Arc_Testnet', 'Base')).toBe(true);
    });

    it('Arc_Testnet → Ethereum requires bridging', () => {
      expect(requiresBridging('Arc_Testnet', 'Ethereum')).toBe(true);
    });

    it('same chain does not require bridging', () => {
      expect(requiresBridging('Arc_Testnet', 'Arc_Testnet')).toBe(false);
      expect(requiresBridging('Base', 'Base')).toBe(false);
      expect(requiresBridging('Ethereum', 'Ethereum')).toBe(false);
    });
  });
});
