import { BridgeKit } from '@circle-fin/bridge-kit';
import { CCTPV2BridgingProvider } from '@circle-fin/provider-cctp-v2';
import { ViemAdapter } from '@circle-fin/adapter-viem-v2';
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient as ViemWalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, mainnet, avalanche, arbitrum, optimism } from 'viem/chains';
import { getConfig } from '@arc-agents/config';
import type { BridgeTransfer, SupportedChain } from '@arc-agents/shared-types';
import { v4 as uuidv4 } from 'uuid';

// ─── Arc Testnet Chain Definition (not in viem core yet) ──────────────────

export const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Arc', symbol: 'ARC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network/'] },
    public: { http: ['https://rpc.testnet.arc.network/'] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
} as const;

// ─── Chain Config Map ─────────────────────────────────────────────────────

function getViemChain(chain: SupportedChain) {
  const map = {
    Arc_Testnet: arcTestnet,
    Arc_Mainnet: arcTestnet, // swap when mainnet ships
    Base: base,
    Ethereum: mainnet,
    Avalanche: avalanche,
    Arbitrum: arbitrum,
    Optimism: optimism,
  } as const;
  return map[chain as keyof typeof map] ?? arcTestnet;
}

function getRpcUrl(chain: SupportedChain): string {
  const config = getConfig();
  const map: Partial<Record<SupportedChain, string>> = {
    Arc_Testnet: config.ARC_RPC_URL,
    Arc_Mainnet: config.ARC_RPC_URL,
    Base: config.BASE_RPC_URL,
    Ethereum: config.ETH_RPC_URL,
  };
  return map[chain] ?? config.ARC_RPC_URL;
}

// ─── Bridge Client ────────────────────────────────────────────────────────

export class CCTPBridgeClient {
  /**
   * Transfer USDC cross-chain using CCTPv2 with Orbit relayer.
   * Orbit handles attestation + mint — no manual polling required.
   *
   * @param privateKey - Signing key for the source wallet
   * @param fromChain  - Source chain
   * @param toChain    - Destination chain
   * @param toAddress  - Recipient address on destination chain
   * @param amount     - USDC amount as string (e.g., "100.50")
   * @param speed      - FAST (8-20s) or STANDARD (13+ min on Ethereum)
   */
  async bridge(params: {
    privateKey: `0x${string}`;
    fromChain: SupportedChain;
    toChain: SupportedChain;
    toAddress: string;
    amount: string;
    speed?: 'FAST' | 'STANDARD';
  }): Promise<BridgeTransfer> {
    const account = privateKeyToAccount(params.privateKey);
    const fromViemChain = getViemChain(params.fromChain);
    const toViemChain = getViemChain(params.toChain);
    const fromRpc = getRpcUrl(params.fromChain);
    const toRpc = getRpcUrl(params.toChain);

    const sourceAdapter = new ViemAdapter({
      publicClient: createPublicClient({
        chain: fromViemChain as any,
        transport: http(fromRpc),
      }) as PublicClient,
      walletClient: createWalletClient({
        account,
        chain: fromViemChain as any,
        transport: http(fromRpc),
      }) as ViemWalletClient,
    });

    const destAdapter = new ViemAdapter({
      publicClient: createPublicClient({
        chain: toViemChain as any,
        transport: http(toRpc),
      }) as PublicClient,
      walletClient: createWalletClient({
        account,
        chain: toViemChain as any,
        transport: http(toRpc),
      }) as ViemWalletClient,
    });

    const provider = new CCTPV2BridgingProvider();
    const kit = new BridgeKit({ provider });

    const transferId = uuidv4();
    const bridgeTransfer: BridgeTransfer = {
      id: transferId,
      fromChain: params.fromChain,
      toChain: params.toChain,
      fromAddress: account.address,
      toAddress: params.toAddress,
      amount: params.amount,
      transferSpeed: params.speed ?? 'FAST',
      status: 'initiated',
      createdAt: new Date(),
    };

    const result = await kit.bridge({
      from: { adapter: sourceAdapter, chain: params.fromChain as any },
      to: {
        adapter: destAdapter,
        chain: params.toChain as any,
        useForwarder: true, // Circle Orbit relayer handles attestation + mint
      },
      amount: params.amount,
    });

    // Extract tx hashes from result steps
    const burnStep = (result as any).steps?.find((s: any) => s.name === 'burn');
    const mintStep = (result as any).steps?.find((s: any) => s.name === 'mint');

    return {
      ...bridgeTransfer,
      burnTxHash: burnStep?.txHash,
      mintTxHash: mintStep?.txHash,
      status: result.state === 'success' ? 'minted' : 'failed',
      completedAt: result.state === 'success' ? new Date() : undefined,
    };
  }

  /**
   * Get an estimate for a cross-chain bridge (fee + time estimate).
   */
  async estimate(params: {
    fromChain: SupportedChain;
    toChain: SupportedChain;
    amount: string;
  }): Promise<{
    estimatedSeconds: number;
    fee: string;
    netAmount: string;
    route: string;
  }> {
    const provider = new CCTPV2BridgingProvider();
    const isSupported = provider.supportsRoute(
      params.fromChain as any,
      params.toChain as any,
      'USDC'
    );

    if (!isSupported) {
      throw new Error(
        `CCTPv2 route not supported: ${params.fromChain} → ${params.toChain}`
      );
    }

    // Fast transfer = 8-20 seconds on CCTPv2
    // Standard = varies (13+ min on Ethereum L1)
    return {
      estimatedSeconds: 15,
      fee: '0',
      netAmount: params.amount,
      route: `${params.fromChain} → CCTP_V2 → ${params.toChain}`,
    };
  }

  /**
   * Check if a route is supported by CCTPv2.
   */
  isRouteSupported(fromChain: SupportedChain, toChain: SupportedChain): boolean {
    const provider = new CCTPV2BridgingProvider();
    try {
      return provider.supportsRoute(fromChain as any, toChain as any, 'USDC');
    } catch {
      return false;
    }
  }
}

export const bridgeClient = new CCTPBridgeClient();
