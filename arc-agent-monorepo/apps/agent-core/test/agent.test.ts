import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies for isolated unit testing
vi.mock('@arc-agents/wallet-client', () => ({
  AgentWalletManager: vi.fn().mockImplementation(() => ({
    getWalletBalance: vi.fn().mockResolvedValue({ usdc: 50.0, usdcRaw: '50000000' }),
    transferUSDC: vi.fn().mockResolvedValue({
      id: 'payment-001',
      txHash: '0xabc123',
      status: 'confirmed',
    }),
    createAgentWallet: vi.fn().mockResolvedValue({
      id: 'wallet-001',
      address: '0xnew',
      chain: 'Arc_Testnet',
    }),
    listWallets: vi.fn().mockResolvedValue([]),
  })),
  WalletPolicyManager: vi.fn().mockImplementation(() => ({
    validateSpend: vi.fn().mockReturnValue({ allowed: true }),
    buildDefaultPolicy: vi.fn().mockReturnValue({
      id: 'policy-001',
      walletId: 'wallet-001',
      maxAmountPerTx: '10000000',
      allowedChains: ['Arc_Testnet', 'Base', 'Ethereum'],
    }),
  })),
}));

vi.mock('@arc-agents/gateway-client', () => ({
  gatewayClient: {
    getUnifiedBalance: vi.fn().mockResolvedValue({
      totalUSDC: 50.0,
      byChain: [{ chain: 'Arc_Testnet', balance: 50.0, balanceRaw: '50000000' }],
    }),
  },
}));

vi.mock('@arc-agents/nanopay', () => ({
  NanopayClient: vi.fn().mockImplementation(() => ({
    pay: vi.fn().mockResolvedValue({
      nanopayment: { id: 'nano-001', amount: '1000', endpoint: 'https://test.com' },
      responseData: { result: 'success' },
    }),
  })),
}));

vi.mock('@arc-agents/config', () => ({
  getConfig: vi.fn().mockReturnValue({
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: 'test-key',
    NODE_ENV: 'test',
    AGENT_SPENDING_LIMIT_USDC_PER_TX: 10,
    AGENT_SPENDING_LIMIT_USDC_PER_HOUR: 100,
  }),
  toUSDCString: (n: number) => String(Math.round(n * 1e6)),
  fromUSDCUnits: (n: bigint | string) => Number(BigInt(n)) / 1e6,
}));

vi.mock('@arc-agents/observability', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  initTelemetry: vi.fn(),
}));

// Mock AI frameworks
vi.mock('langchain/agents', () => ({
  createOpenAIFunctionsAgent: vi.fn().mockResolvedValue({}),
  AgentExecutor: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      output: 'Task completed: Discovered service and executed purchase.',
    }),
  })),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@langchain/core/prompts', () => ({
  ChatPromptTemplate: {
    fromMessages: vi.fn().mockReturnValue({}),
  },
  MessagesPlaceholder: vi.fn(),
}));

describe('AutonomousPurchaseAgent', () => {
  it('runLangChain completes and returns an AgentAction', async () => {
    const { AutonomousPurchaseAgent } = await import('../src/agent/autonomous-agent.js');
    const agent = new AutonomousPurchaseAgent();

    const action = await agent.runLangChain(
      'Find a data API and purchase access for $0.001',
      'wallet-001'
    );

    expect(action.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(action.actionType).toBe('execute_purchase');
    expect(action.status).toBe('completed');
    expect(action.input.task).toBe('Find a data API and purchase access for $0.001');
    expect(action.input.walletId).toBe('wallet-001');
    expect(action.createdAt).toBeInstanceOf(Date);
    expect(action.completedAt).toBeInstanceOf(Date);
  });

  it('records duration in milliseconds', async () => {
    const { AutonomousPurchaseAgent } = await import('../src/agent/autonomous-agent.js');
    const agent = new AutonomousPurchaseAgent();

    const action = await agent.runLangChain('Test task', 'wallet-001');
    expect(typeof action.durationMs).toBe('number');
    expect(action.durationMs).toBeGreaterThanOrEqual(0);
  });
});
