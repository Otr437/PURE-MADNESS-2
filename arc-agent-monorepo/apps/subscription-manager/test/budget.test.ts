import { describe, it, expect, vi } from 'vitest';

// Subscription budget logic extracted for unit testing
function calculateMonthlyCommitment(
  subscriptions: Array<{ amount: string; periodDays: number; status: string }>
): number {
  return subscriptions
    .filter((s) => s.status === 'active')
    .reduce((sum, s) => sum + (parseInt(s.amount) / 1e6) * (30 / s.periodDays), 0);
}

function wouldExceedBudget(
  existingCommitmentUSDC: number,
  newAmountUSDC: number,
  newPeriodDays: number,
  budgetCapUSDC: number
): boolean {
  const newMonthlyContrib = newAmountUSDC * (30 / newPeriodDays);
  return existingCommitmentUSDC + newMonthlyContrib > budgetCapUSDC;
}

function getNextRenewalDate(periodDays: number, fromDate = new Date()): Date {
  const next = new Date(fromDate);
  next.setDate(next.getDate() + periodDays);
  return next;
}

function calculateRunway(
  balanceUSDC: number,
  monthlyCommitmentUSDC: number
): number {
  if (monthlyCommitmentUSDC === 0) return Infinity;
  return balanceUSDC / monthlyCommitmentUSDC;
}

describe('Subscription budget calculations', () => {
  describe('calculateMonthlyCommitment', () => {
    it('calculates zero for no subscriptions', () => {
      expect(calculateMonthlyCommitment([])).toBe(0);
    });

    it('calculates zero for all cancelled subscriptions', () => {
      const subs = [
        { amount: '10000000', periodDays: 30, status: 'cancelled' },
        { amount: '5000000', periodDays: 30, status: 'expired' },
      ];
      expect(calculateMonthlyCommitment(subs)).toBe(0);
    });

    it('calculates monthly commitment for monthly subscription', () => {
      const subs = [{ amount: '10000000', periodDays: 30, status: 'active' }]; // $10/month
      expect(calculateMonthlyCommitment(subs)).toBeCloseTo(10.0);
    });

    it('calculates monthly commitment for weekly subscription', () => {
      const subs = [{ amount: '2000000', periodDays: 7, status: 'active' }]; // $2/week = ~$8.57/month
      expect(calculateMonthlyCommitment(subs)).toBeCloseTo(8.57, 1);
    });

    it('calculates monthly commitment for annual subscription', () => {
      const subs = [{ amount: '120000000', periodDays: 365, status: 'active' }]; // $120/year = $9.86/month
      expect(calculateMonthlyCommitment(subs)).toBeCloseTo(9.86, 1);
    });

    it('sums multiple active subscriptions', () => {
      const subs = [
        { amount: '10000000', periodDays: 30, status: 'active' },  // $10/mo
        { amount: '5000000', periodDays: 30, status: 'active' },   // $5/mo
        { amount: '20000000', periodDays: 30, status: 'cancelled' }, // excluded
      ];
      expect(calculateMonthlyCommitment(subs)).toBeCloseTo(15.0);
    });
  });

  describe('wouldExceedBudget', () => {
    it('returns false when new subscription fits within budget', () => {
      expect(wouldExceedBudget(20, 10, 30, 50)).toBe(false); // $20 existing + $10 new = $30 < $50
    });

    it('returns true when new subscription exceeds budget', () => {
      expect(wouldExceedBudget(45, 10, 30, 50)).toBe(true); // $45 existing + $10 new = $55 > $50
    });

    it('returns false at exact budget limit', () => {
      expect(wouldExceedBudget(40, 10, 30, 50)).toBe(false); // $40 + $10 = $50 = limit (not exceeded)
    });

    it('correctly pro-rates weekly subscriptions', () => {
      // $5/week = ~$21.43/month
      expect(wouldExceedBudget(30, 5, 7, 50)).toBe(true); // $30 + $21.43 > $50
      expect(wouldExceedBudget(10, 5, 7, 50)).toBe(false); // $10 + $21.43 < $50
    });
  });

  describe('getNextRenewalDate', () => {
    it('calculates next renewal for 30-day subscription', () => {
      const base = new Date('2026-05-19T00:00:00Z');
      const next = getNextRenewalDate(30, base);
      expect(next.getDate()).toBe(18); // May 19 + 30 = June 18
      expect(next.getMonth()).toBe(5); // June = 5 (0-indexed)
    });

    it('calculates next renewal for 7-day subscription', () => {
      const base = new Date('2026-05-19T00:00:00Z');
      const next = getNextRenewalDate(7, base);
      expect(next.getDate()).toBe(26);
      expect(next.getMonth()).toBe(4); // May = 4
    });

    it('defaults to now when no fromDate provided', () => {
      const before = Date.now();
      const next = getNextRenewalDate(30);
      const after = Date.now();
      const nextMs = next.getTime();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      expect(nextMs).toBeGreaterThanOrEqual(before + thirtyDays);
      expect(nextMs).toBeLessThanOrEqual(after + thirtyDays);
    });
  });

  describe('calculateRunway', () => {
    it('calculates months of runway', () => {
      expect(calculateRunway(150, 30)).toBe(5); // $150 / $30/mo = 5 months
    });

    it('returns Infinity for zero monthly commitment', () => {
      expect(calculateRunway(100, 0)).toBe(Infinity);
    });

    it('returns less than 1 when balance < monthly commitment', () => {
      const runway = calculateRunway(15, 30); // $15 / $30/mo = 0.5
      expect(runway).toBe(0.5);
    });
  });
});
