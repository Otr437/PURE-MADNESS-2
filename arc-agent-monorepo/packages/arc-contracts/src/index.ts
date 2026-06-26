import { createPublicClient, createWalletClient, http, parseAbi, type Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getConfig } from '@arc-agents/config';

// ─── Arc Testnet Chain ────────────────────────────────────────────────────

export const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Arc', symbol: 'ARC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network/'] }, public: { http: ['https://rpc.testnet.arc.network/'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
} as const;

// ─── Contract ABIs ────────────────────────────────────────────────────────

/**
 * Arc Purchase Contract ABI — executes stablecoin-settled purchases
 * Source: Circle Arc smart contract library (arc.io/contracts)
 */
export const PURCHASE_CONTRACT_ABI = parseAbi([
  'function purchase(address token, uint256 amount, address merchant, bytes32 orderId) returns (bool)',
  'function getPurchase(bytes32 orderId) view returns (address buyer, address merchant, uint256 amount, uint256 timestamp, bool settled)',
  'function settlePurchase(bytes32 orderId) returns (bool)',
  'event PurchaseExecuted(bytes32 indexed orderId, address indexed buyer, address indexed merchant, uint256 amount)',
  'event PurchaseSettled(bytes32 indexed orderId)',
]);

/**
 * Arc Subscription Contract ABI — manages recurring USDC payments
 */
export const SUBSCRIPTION_CONTRACT_ABI = parseAbi([
  'function createSubscription(address token, address merchant, uint256 amount, uint256 periodSeconds) returns (bytes32)',
  'function cancelSubscription(bytes32 subscriptionId) returns (bool)',
  'function renewSubscription(bytes32 subscriptionId) returns (bool)',
  'function getSubscription(bytes32 subscriptionId) view returns (address subscriber, address merchant, uint256 amount, uint256 nextPaymentAt, bool active)',
  'event SubscriptionCreated(bytes32 indexed subscriptionId, address indexed subscriber, address indexed merchant)',
  'event SubscriptionRenewed(bytes32 indexed subscriptionId, uint256 nextPaymentAt)',
  'event SubscriptionCancelled(bytes32 indexed subscriptionId)',
]);

/**
 * Arc Settlement Contract ABI — multi-party USDC settlement
 */
export const SETTLEMENT_CONTRACT_ABI = parseAbi([
  'function initiateSettlement(address token, address[] calldata counterparties, uint256[] calldata amounts) returns (bytes32)',
  'function approveSettlement(bytes32 settlementId) returns (bool)',
  'function executeSettlement(bytes32 settlementId) returns (bool)',
  'function getSettlement(bytes32 settlementId) view returns (bytes32 id, address initiator, uint256 totalAmount, bool executed)',
  'event SettlementInitiated(bytes32 indexed settlementId, address indexed initiator)',
  'event SettlementExecuted(bytes32 indexed settlementId)',
]);

/**
 * Arc Stream Contract ABI — streaming payment flows per second/event
 */
export const STREAM_CONTRACT_ABI = parseAbi([
  'function createStream(address token, address receiver, uint256 ratePerSecond, uint256 deposit) returns (bytes32)',
  'function pauseStream(bytes32 streamId) returns (bool)',
  'function resumeStream(bytes32 streamId) returns (bool)',
  'function cancelStream(bytes32 streamId) returns (bool)',
  'function withdraw(bytes32 streamId) returns (uint256)',
  'function balanceOf(bytes32 streamId, address who) view returns (uint256)',
  'event StreamCreated(bytes32 indexed streamId, address indexed sender, address indexed receiver, uint256 ratePerSecond)',
  'event StreamWithdrawn(bytes32 indexed streamId, address indexed receiver, uint256 amount)',
]);

// ─── Contract Addresses (Arc Testnet) ────────────────────────────────────

export const ARC_CONTRACT_ADDRESSES = {
  testnet: {
    purchase: '0x0000000000000000000000000000000000000001' as `0x${string}`, // Deploy via scripts/deploy-contracts.ts
    subscription: '0x0000000000000000000000000000000000000002' as `0x${string}`,
    settlement: '0x0000000000000000000000000000000000000003' as `0x${string}`,
    stream: '0x0000000000000000000000000000000000000004' as `0x${string}`,
    usdc: '0x3600000000000000000000000000000000000000' as `0x${string}`,
  },
} as const;

// ─── Arc Contract Client ──────────────────────────────────────────────────

export class ArcContractClient {
  private readonly config = getConfig();

  private getPublicClient() {
    return createPublicClient({
      chain: arcTestnet as any,
      transport: http(this.config.ARC_RPC_URL),
    });
  }

  private getWalletClient(privateKey: `0x${string}`) {
    return createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain: arcTestnet as any,
      transport: http(this.config.ARC_RPC_URL),
    });
  }

  /**
   * Execute a purchase on Arc using the Arc Purchase smart contract.
   */
  async executePurchase(params: {
    privateKey: `0x${string}`;
    merchantAddress: `0x${string}`;
    amountUSDC: bigint;
    orderId: `0x${string}`;
  }): Promise<{ txHash: `0x${string}`; orderId: string }> {
    const walletClient = this.getWalletClient(params.privateKey);
    const contractAddress = ARC_CONTRACT_ADDRESSES.testnet.purchase;

    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: PURCHASE_CONTRACT_ABI,
      functionName: 'purchase',
      args: [
        ARC_CONTRACT_ADDRESSES.testnet.usdc,
        params.amountUSDC,
        params.merchantAddress,
        params.orderId,
      ],
    });

    return { txHash, orderId: params.orderId };
  }

  /**
   * Create a recurring subscription on Arc.
   */
  async createSubscription(params: {
    privateKey: `0x${string}`;
    merchantAddress: `0x${string}`;
    amountUSDC: bigint;
    periodDays: number;
  }): Promise<{ txHash: `0x${string}`; subscriptionId: string }> {
    const walletClient = this.getWalletClient(params.privateKey);
    const periodSeconds = BigInt(params.periodDays * 24 * 60 * 60);

    const txHash = await walletClient.writeContract({
      address: ARC_CONTRACT_ADDRESSES.testnet.subscription,
      abi: SUBSCRIPTION_CONTRACT_ABI,
      functionName: 'createSubscription',
      args: [
        ARC_CONTRACT_ADDRESSES.testnet.usdc,
        params.merchantAddress,
        params.amountUSDC,
        periodSeconds,
      ],
    });

    return { txHash, subscriptionId: txHash };
  }

  /**
   * Initiate a multi-party settlement on Arc.
   */
  async initiateSettlement(params: {
    privateKey: `0x${string}`;
    counterparties: `0x${string}`[];
    amounts: bigint[];
  }): Promise<{ txHash: `0x${string}`; settlementId: string }> {
    const walletClient = this.getWalletClient(params.privateKey);

    const txHash = await walletClient.writeContract({
      address: ARC_CONTRACT_ADDRESSES.testnet.settlement,
      abi: SETTLEMENT_CONTRACT_ABI,
      functionName: 'initiateSettlement',
      args: [
        ARC_CONTRACT_ADDRESSES.testnet.usdc,
        params.counterparties,
        params.amounts,
      ],
    });

    return { txHash, settlementId: txHash };
  }

  /**
   * Create a streaming payment on Arc.
   */
  async createStream(params: {
    privateKey: `0x${string}`;
    receiverAddress: `0x${string}`;
    ratePerSecondUSDC: bigint;
    depositUSDC: bigint;
  }): Promise<{ txHash: `0x${string}`; streamId: string }> {
    const walletClient = this.getWalletClient(params.privateKey);

    const txHash = await walletClient.writeContract({
      address: ARC_CONTRACT_ADDRESSES.testnet.stream,
      abi: STREAM_CONTRACT_ABI,
      functionName: 'createStream',
      args: [
        ARC_CONTRACT_ADDRESSES.testnet.usdc,
        params.receiverAddress,
        params.ratePerSecondUSDC,
        params.depositUSDC,
      ],
    });

    return { txHash, streamId: txHash };
  }
}

export const arcClient = new ArcContractClient();
