import { describe, it, expect } from 'vitest';

// Stream math — extracted from streaming-pay for pure unit testing

const USDC_DECIMALS = 6;

function toUnits(usdc: number): bigint {
  return BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));
}

function fromUnits(units: bigint | string): number {
  return Number(BigInt(units)) / 10 ** USDC_DECIMALS;
}

function calculateStreamDuration(depositUSDC: number, ratePerSecondUSDC: number): number {
  if (ratePerSecondUSDC === 0) return Infinity;
  return depositUSDC / ratePerSecondUSDC;
}

function calculateEarned(
  ratePerSecond: string,
  startedAt: Date,
  now = new Date()
): number {
  const elapsedSeconds = (now.getTime() - startedAt.getTime()) / 1000;
  return fromUnits(BigInt(ratePerSecond)) * elapsedSeconds;
}

function calculateRemainingDeposit(
  totalDeposited: string,
  totalWithdrawn: string
): number {
  const deposited = BigInt(totalDeposited);
  const withdrawn = BigInt(totalWithdrawn);
  return fromUnits(deposited - withdrawn);
}

function isDepleted(ratePerSecond: string, available: string): boolean {
  return BigInt(available) < BigInt(ratePerSecond);
}

describe('Stream rate calculations', () => {
  describe('toUnits / fromUnits', () => {
    it('converts $0.0001/s to 100 units/s', () => {
      expect(toUnits(0.0001)).toBe(BigInt(100));
    });

    it('converts $0.000001 (nanopayment min) to 1 unit', () => {
      expect(toUnits(0.000001)).toBe(BigInt(1));
    });

    it('round-trips correctly', () => {
      const rates = [0.000001, 0.0001, 0.001, 0.01, 0.1, 1.0];
      for (const rate of rates) {
        expect(fromUnits(toUnits(rate))).toBeCloseTo(rate, 6);
      }
    });
  });

  describe('calculateStreamDuration', () => {
    it('calculates duration for $10 deposit at $0.0001/s', () => {
      const duration = calculateStreamDuration(10, 0.0001);
      expect(duration).toBe(100000); // 100,000 seconds ≈ 27.8 hours
    });

    it('calculates duration for $1 deposit at $0.001/s', () => {
      const duration = calculateStreamDuration(1, 0.001);
      expect(duration).toBe(1000); // ~16.7 minutes
    });

    it('returns Infinity for zero rate', () => {
      expect(calculateStreamDuration(10, 0)).toBe(Infinity);
    });

    it('calculates seconds to hours correctly ($8.64 deposit, $0.0001/s)', () => {
      // $0.0001/s = $8.64/day
      const duration = calculateStreamDuration(8.64, 0.0001);
      expect(duration).toBe(86400); // exactly 1 day in seconds
    });
  });

  describe('calculateEarned', () => {
    it('calculates zero earned at start', () => {
      const startedAt = new Date();
      const earned = calculateEarned(toUnits(0.0001).toString(), startedAt, startedAt);
      expect(earned).toBeCloseTo(0);
    });

    it('calculates earned after 10 seconds at $0.0001/s', () => {
      const startedAt = new Date(Date.now() - 10000); // 10 seconds ago
      const earned = calculateEarned(toUnits(0.0001).toString(), startedAt);
      expect(earned).toBeCloseTo(0.001, 4); // $0.0001 × 10s = $0.001
    });

    it('calculates earned after 1 hour at $0.0001/s', () => {
      const startedAt = new Date(Date.now() - 3600 * 1000); // 1 hour ago
      const earned = calculateEarned(toUnits(0.0001).toString(), startedAt);
      expect(earned).toBeCloseTo(0.36, 2); // $0.0001 × 3600s = $0.36
    });
  });

  describe('calculateRemainingDeposit', () => {
    it('returns full deposit when nothing withdrawn', () => {
      const remaining = calculateRemainingDeposit(
        toUnits(10).toString(),  // $10 deposit
        '0'
      );
      expect(remaining).toBeCloseTo(10.0);
    });

    it('returns zero when fully withdrawn', () => {
      const depositUnits = toUnits(10).toString();
      const remaining = calculateRemainingDeposit(depositUnits, depositUnits);
      expect(remaining).toBe(0);
    });

    it('returns partial amount', () => {
      const remaining = calculateRemainingDeposit(
        toUnits(10).toString(),
        toUnits(3).toString()
      );
      expect(remaining).toBeCloseTo(7.0);
    });
  });

  describe('isDepleted', () => {
    it('returns true when available < rate per second', () => {
      const rate = toUnits(0.0001); // 100 units/s
      const available = BigInt(50); // less than one second's worth
      expect(isDepleted(rate.toString(), available.toString())).toBe(true);
    });

    it('returns false when available >= rate per second', () => {
      const rate = toUnits(0.0001); // 100 units/s
      const available = toUnits(1); // $1 = 1,000,000 units — plenty
      expect(isDepleted(rate.toString(), available.toString())).toBe(false);
    });

    it('returns true when available equals exactly zero', () => {
      const rate = toUnits(0.0001);
      expect(isDepleted(rate.toString(), '0')).toBe(true);
    });
  });
});
