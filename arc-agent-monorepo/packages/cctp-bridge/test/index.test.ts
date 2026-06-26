import { describe, it, expect, vi } from 'vitest';
import { arcTestnet } from '../src/index.js';

// Mock the Circle SDK modules to avoid real network calls in unit tests
vi.mock('@circle-fin/provider-cctp-v2', () => ({
  CCTPV2BridgingProvider: vi.fn().mockImplementation(() => ({
    supportsRoute: vi.fn().mockImplementation((from, to, asset) => {
      // CCTPv2 supports Arc_Testnet ↔ Base ↔ Ethereum in May 2026
      const supported = ['Arc_Testnet', 'Base', 'Ethereum', 'Avalanche', 'Arbitrum'];
      return supported.includes(from) && supported.includes(to) && asset === 'USDC';
    }),
  })),
}));

vi.mock('@circle-fin/bridge-kit', () => ({
  BridgeKit: vi.fn(),
}));

vi.mock('@circle-fin/adapter-viem-v2', () => ({
  ViemAdapter: vi.fn(),
}));

vi.mock('@arc-agents/config', () => ({
  getConfig: vi.fn().mockReturnValue({
    ARC_RPC_URL: 'https://rpc.testnet.arc.network/',
    BASE_RPC_URL: 'https://mainnet.base.org',
    ETH_RPC_URL: 'https://eth.llamarpc.com',
  }),
}));

describe('arcTestnet chain definition', () => {
  it('has correct chain ID for Arc Testnet', () => {
    expect(arcTestnet.id).toBe(5042002);
  });

  it('has correct RPC URL', () => {
    expect(arcTestnet.rpcUrls.default.http[0]).toBe('https://rpc.testnet.arc.network/');
  });

  it('is marked as testnet', () => {
    expect(arcTestnet.testnet).toBe(true);
  });

  it('uses ARC as native currency symbol', () => {
    expect(arcTestnet.nativeCurrency.symbol).toBe('ARC');
  });

  it('has ArcScan as block explorer', () => {
    expect(arcTestnet.blockExplorers.default.url).toBe('https://testnet.arcscan.app');
  });
});

describe('CCTPBridgeClient.isRouteSupported', () => {
  it('returns true for Arc_Testnet → Base (CCTPv2 supported)', async () => {
    const { CCTPBridgeClient } = await import('../src/index.js');
    const client = new CCTPBridgeClient();
    expect(client.isRouteSupported('Arc_Testnet', 'Base')).toBe(true);
  });

  it('returns true for Ethereum → Arc_Testnet', async () => {
    const { CCTPBridgeClient } = await import('../src/index.js');
    const client = new CCTPBridgeClient();
    expect(client.isRouteSupported('Ethereum', 'Arc_Testnet')).toBe(true);
  });

  it('returns false for Solana → Arc_Testnet (not in mock supported list)', async () => {
    const { CCTPBridgeClient } = await import('../src/index.js');
    const client = new CCTPBridgeClient();
    expect(client.isRouteSupported('Solana', 'Arc_Testnet')).toBe(false);
  });
});

describe('CCTPBridgeClient.estimate', () => {
  it('returns FAST transfer estimate of ~15 seconds', async () => {
    const { CCTPBridgeClient } = await import('../src/index.js');
    const client = new CCTPBridgeClient();
    const estimate = await client.estimate({
      fromChain: 'Arc_Testnet',
      toChain: 'Base',
      amount: '100.00',
    });

    expect(estimate.estimatedSeconds).toBe(15);
    expect(estimate.fee).toBe('0'); // CCTPv2 protocol fee is zero
    expect(estimate.netAmount).toBe('100.00');
    expect(estimate.route).toContain('CCTP_V2');
  });

  it('throws for unsupported route', async () => {
    // Override mock for this test
    vi.mock('@circle-fin/provider-cctp-v2', () => ({
      CCTPV2BridgingProvider: vi.fn().mockImplementation(() => ({
        supportsRoute: vi.fn().mockReturnValue(false),
      })),
    }));

    const { CCTPBridgeClient } = await import('../src/index.js');
    const client = new CCTPBridgeClient();

    await expect(
      client.estimate({ fromChain: 'Solana', toChain: 'Arc_Testnet', amount: '10' })
    ).rejects.toThrow('CCTPv2 route not supported');
  });
});
