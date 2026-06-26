import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toUSDCUnits, fromUSDCUnits, toUSDCString, USDC_DECIMALS, USDC_DIVISOR } from '../src/index.js';

describe('USDC unit conversions', () => {
  it('converts $1.00 to 1,000,000 units', () => {
    expect(toUSDCUnits(1.0)).toBe(BigInt(1_000_000));
  });

  it('converts $0.001 to 1,000 units', () => {
    expect(toUSDCUnits(0.001)).toBe(BigInt(1_000));
  });

  it('converts $0.000001 (nanopayment min) to 1 unit', () => {
    expect(toUSDCUnits(0.000001)).toBe(BigInt(1));
  });

  it('converts $10.50 correctly', () => {
    expect(toUSDCUnits(10.50)).toBe(BigInt(10_500_000));
  });

  it('fromUSDCUnits: 1,000,000 units → $1.00', () => {
    expect(fromUSDCUnits(BigInt(1_000_000))).toBe(1.0);
  });

  it('fromUSDCUnits: accepts string input', () => {
    expect(fromUSDCUnits('1000000')).toBe(1.0);
  });

  it('toUSDCString returns BigInt string', () => {
    expect(toUSDCString(1.0)).toBe('1000000');
    expect(toUSDCString(0.000001)).toBe('1');
  });

  it('USDC_DECIMALS is 6', () => {
    expect(USDC_DECIMALS).toBe(6);
  });

  it('USDC_DIVISOR is 10^6', () => {
    expect(USDC_DIVISOR).toBe(BigInt(1_000_000));
  });

  it('round-trips: dollars → units → dollars', () => {
    const amounts = [0.000001, 0.001, 0.01, 0.1, 1.0, 10.0, 100.0, 1000.0];
    for (const amount of amounts) {
      const units = toUSDCUnits(amount);
      const back = fromUSDCUnits(units);
      expect(Math.abs(back - amount)).toBeLessThan(0.000001);
    }
  });
});

describe('getConfig', () => {
  it('throws when required env vars are missing', async () => {
    const originalEnv = { ...process.env };
    // Remove required vars
    delete process.env['CIRCLE_API_KEY'];
    delete process.env['CIRCLE_ENTITY_SECRET'];
    delete process.env['CIRCLE_WALLET_SET_ID'];
    delete process.env['DATABASE_URL'];

    // Re-import to bypass cache
    vi.resetModules();
    const { getConfig } = await import('../src/index.js');

    expect(() => getConfig()).toThrow('Invalid environment configuration');
    Object.assign(process.env, originalEnv);
  });
});
