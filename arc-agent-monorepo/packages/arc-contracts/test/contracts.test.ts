import { describe, it, expect } from 'vitest';
import {
  PURCHASE_CONTRACT_ABI,
  SUBSCRIPTION_CONTRACT_ABI,
  SETTLEMENT_CONTRACT_ABI,
  STREAM_CONTRACT_ABI,
  ARC_CONTRACT_ADDRESSES,
} from '../src/index.js';

describe('Arc Contract ABIs', () => {
  describe('PURCHASE_CONTRACT_ABI', () => {
    it('contains purchase function', () => {
      const fn = PURCHASE_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'purchase'
      );
      expect(fn).toBeDefined();
    });

    it('purchase function has correct inputs', () => {
      const fn = PURCHASE_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'purchase'
      ) as any;
      expect(fn.inputs).toHaveLength(4);
      const inputNames = fn.inputs.map((i: any) => i.name);
      expect(inputNames).toContain('token');
      expect(inputNames).toContain('amount');
      expect(inputNames).toContain('merchant');
      expect(inputNames).toContain('orderId');
    });

    it('contains PurchaseExecuted event', () => {
      const event = PURCHASE_CONTRACT_ABI.find(
        (item) => item.type === 'event' && item.name === 'PurchaseExecuted'
      );
      expect(event).toBeDefined();
    });

    it('contains settlePurchase function', () => {
      const fn = PURCHASE_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'settlePurchase'
      );
      expect(fn).toBeDefined();
    });
  });

  describe('SUBSCRIPTION_CONTRACT_ABI', () => {
    it('contains createSubscription function', () => {
      const fn = SUBSCRIPTION_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'createSubscription'
      );
      expect(fn).toBeDefined();
    });

    it('contains renewSubscription function', () => {
      const fn = SUBSCRIPTION_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'renewSubscription'
      );
      expect(fn).toBeDefined();
    });

    it('contains cancelSubscription function', () => {
      const fn = SUBSCRIPTION_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'cancelSubscription'
      );
      expect(fn).toBeDefined();
    });

    it('contains SubscriptionCreated and SubscriptionRenewed events', () => {
      const created = SUBSCRIPTION_CONTRACT_ABI.find(
        (item) => item.type === 'event' && item.name === 'SubscriptionCreated'
      );
      const renewed = SUBSCRIPTION_CONTRACT_ABI.find(
        (item) => item.type === 'event' && item.name === 'SubscriptionRenewed'
      );
      expect(created).toBeDefined();
      expect(renewed).toBeDefined();
    });
  });

  describe('STREAM_CONTRACT_ABI', () => {
    it('contains createStream function', () => {
      const fn = STREAM_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'createStream'
      );
      expect(fn).toBeDefined();
    });

    it('contains balanceOf function', () => {
      const fn = STREAM_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'balanceOf'
      );
      expect(fn).toBeDefined();
    });

    it('contains pauseStream and resumeStream', () => {
      const pause = STREAM_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'pauseStream'
      );
      const resume = STREAM_CONTRACT_ABI.find(
        (item) => item.type === 'function' && item.name === 'resumeStream'
      );
      expect(pause).toBeDefined();
      expect(resume).toBeDefined();
    });
  });

  describe('SETTLEMENT_CONTRACT_ABI', () => {
    it('contains initiateSettlement, approveSettlement, executeSettlement', () => {
      const fns = ['initiateSettlement', 'approveSettlement', 'executeSettlement'];
      for (const name of fns) {
        const fn = SETTLEMENT_CONTRACT_ABI.find(
          (item) => item.type === 'function' && item.name === name
        );
        expect(fn, `Missing function: ${name}`).toBeDefined();
      }
    });
  });

  describe('ARC_CONTRACT_ADDRESSES', () => {
    it('has testnet addresses defined', () => {
      expect(ARC_CONTRACT_ADDRESSES.testnet).toBeDefined();
      expect(ARC_CONTRACT_ADDRESSES.testnet.usdc).toBe(
        '0x3600000000000000000000000000000000000000'
      );
    });

    it('all addresses are valid hex format', () => {
      for (const [key, addr] of Object.entries(ARC_CONTRACT_ADDRESSES.testnet)) {
        expect(addr, `${key} should be a hex address`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    });
  });
});
