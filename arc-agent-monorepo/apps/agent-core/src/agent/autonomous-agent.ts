import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { AgentExecutor, createOpenAIFunctionsAgent } from 'langchain/agents';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, toUSDCUnits } from '@arc-agents/config';
import { AgentWalletManager, WalletPolicyManager } from '@arc-agents/wallet-client';
import { arcClient } from '@arc-agents/arc-contracts';
import { NanopayClient } from '@arc-agents/nanopay';
import { gatewayClient } from '@arc-agents/gateway-client';
import { createLogger } from '@arc-agents/observability';
import type {
  AgentAction,
  SupportedChain,
  X402Service,
} from '@arc-agents/shared-types';

const logger = createLogger('agent-core');

// ─── Agent Tools ──────────────────────────────────────────────────────────

/**
 * Tool: Discover x402 services from Circle's Agent Marketplace
 */
const discoverServiceTool = new DynamicStructuredTool({
  name: 'discover_service',
  description:
    'Search Circle Agent Marketplace for x402-compatible services that accept USDC payments. Returns service URL, price, and capabilities.',
  schema: z.object({
    query: z.string().describe('What service are you looking for?'),
    maxPriceUSDC: z.number().optional().describe('Maximum price per request in USDC'),
    chain: z.enum(['Arc_Testnet', 'Base', 'Ethereum']).optional(),
  }),
  func: async ({ query, maxPriceUSDC, chain }) => {
    logger.info('Discovering service', { query, maxPriceUSDC, chain });

    // Circle Agent Marketplace API
    const response = await fetch(
      `https://agents.circle.com/api/services/search?q=${encodeURIComponent(query)}&chain=${chain ?? 'Arc_Testnet'}`,
      { headers: { 'User-Agent': 'ArcAgent/0.1.0' } }
    ).catch(() => null);

    if (!response?.ok) {
      // Return mock data for testnet development
      const mockServices: X402Service[] = [
        {
          url: 'https://api.example.com/v1/data',
          price: '0.001',
          payTo: '0xMerchant1',
          network: (chain ?? 'Arc_Testnet') as SupportedChain,
          maxAmountRequired: '1000', // $0.001 in USDC units (6 decimals)
          description: `${query} - mock service`,
          version: 1,
        },
      ];
      return JSON.stringify({ services: mockServices, source: 'mock' });
    }

    const data = await response.json();
    const services = (data.services ?? []).filter(
      (s: X402Service) => !maxPriceUSDC || parseFloat(s.price) <= maxPriceUSDC
    );
    return JSON.stringify({ services, source: 'marketplace' });
  },
});

/**
 * Tool: Execute a USDC purchase via Arc smart contract
 */
const executePurchaseTool = new DynamicStructuredTool({
  name: 'execute_purchase',
  description:
    'Execute a stablecoin-settled purchase using an Arc smart contract. Transfers USDC from agent wallet to merchant.',
  schema: z.object({
    walletId: z.string().describe('Agent wallet ID to pay from'),
    merchantAddress: z.string().describe('Merchant wallet address'),
    amountUSDC: z.number().describe('Amount in USDC'),
    chain: z.enum(['Arc_Testnet', 'Base', 'Ethereum']).default('Arc_Testnet'),
    description: z.string().optional().describe('Purchase description for audit trail'),
  }),
  func: async ({ walletId, merchantAddress, amountUSDC, chain, description }) => {
    logger.info('Executing purchase', { walletId, merchantAddress, amountUSDC, chain });

    const walletManager = new AgentWalletManager();
    const policyManager = new WalletPolicyManager();

    // Validate against spending policy before any on-chain action
    const defaultPolicy = policyManager.buildDefaultPolicy(walletId);
    const validation = policyManager.validateSpend(
      defaultPolicy,
      amountUSDC,
      merchantAddress,
      chain as SupportedChain
    );

    if (!validation.allowed) {
      return JSON.stringify({ success: false, reason: validation.reason });
    }

    // Execute on Arc via Circle Wallet API
    const payment = await walletManager.transferUSDC({
      walletId,
      destinationAddress: merchantAddress,
      amountUSDC,
      chain: chain as SupportedChain,
      metadata: { description, type: 'purchase' },
    });

    return JSON.stringify({
      success: true,
      paymentId: payment.id,
      txHash: payment.txHash,
      amount: amountUSDC,
      status: payment.status,
    });
  },
});

/**
 * Tool: Check agent wallet balance
 */
const checkBalanceTool = new DynamicStructuredTool({
  name: 'check_wallet_balance',
  description: 'Check the USDC balance of an agent wallet across all chains.',
  schema: z.object({
    walletId: z.string().describe('Agent wallet ID'),
  }),
  func: async ({ walletId }) => {
    const walletManager = new AgentWalletManager();
    const [walletBalance, gatewayBalance] = await Promise.all([
      walletManager.getWalletBalance(walletId),
      gatewayClient.getUnifiedBalance(walletId).catch(() => null),
    ]);

    return JSON.stringify({
      walletId,
      usdc: walletBalance.usdc,
      unified: gatewayBalance,
    });
  },
});

/**
 * Tool: Make a nanopayment to an x402-gated API
 */
const nanopayTool = new DynamicStructuredTool({
  name: 'nanopay',
  description:
    'Make a sub-cent nanopayment to an x402-gated API endpoint. Gas-free, settles in batches. Use for pay-per-request access.',
  schema: z.object({
    endpoint: z.string().url().describe('x402-compatible API endpoint URL'),
    walletId: z.string().describe('Agent wallet ID'),
    walletAddress: z.string().describe('Agent wallet address'),
    expectedPriceUSDC: z.number().optional().describe('Expected price in USDC'),
  }),
  func: async ({ endpoint, walletId, walletAddress, expectedPriceUSDC }) => {
    const client = new NanopayClient({
      walletId,
      walletAddress,
      privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001', // In production: retrieved from Circle MPC
      chain: 'Arc_Testnet',
    });

    const { nanopayment, responseData } = await client.pay(endpoint, expectedPriceUSDC);

    return JSON.stringify({
      paid: true,
      amount: nanopayment.amount,
      paymentId: nanopayment.id,
      response: responseData,
    });
  },
});

// ─── Agent Reasoning Core ─────────────────────────────────────────────────

export class AutonomousPurchaseAgent {
  private readonly config = getConfig();
  private readonly tools = [
    discoverServiceTool,
    executePurchaseTool,
    checkBalanceTool,
    nanopayTool,
  ];

  /**
   * LangChain-based agent with OpenAI function calling + full tool access.
   * Supports switching between Anthropic Claude, OpenAI GPT, and Vercel AI SDK.
   */
  async runLangChain(task: string, walletId: string): Promise<AgentAction> {
    const actionId = uuidv4();
    logger.info('Starting LangChain agent run', { actionId, task });

    // Use Claude as default reasoning model; fallback to GPT-4o
    const model = this.config.ANTHROPIC_API_KEY
      ? new ChatAnthropic({
          apiKey: this.config.ANTHROPIC_API_KEY,
          model: 'claude-sonnet-4-20250514',
          temperature: 0,
        })
      : new ChatOpenAI({
          apiKey: this.config.OPENAI_API_KEY,
          model: 'gpt-4o',
          temperature: 0,
        });

    const prompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        `You are an autonomous payment agent with access to USDC wallets on Arc, Base, and Ethereum.
Your job is to autonomously discover services, evaluate pricing, and execute USDC-settled purchases.

Key rules:
- Always check wallet balance before purchasing
- Never exceed spending policies
- Prefer Arc_Testnet for lowest fees (gas denominated in USDC, <0.5s finality)
- Use nanopayments for sub-$0.01 transactions
- Log every payment action for audit trail

Current wallet ID: ${walletId}`,
      ],
      ['human', '{input}'],
      new MessagesPlaceholder('agent_scratchpad'),
    ]);

    const agent = await createOpenAIFunctionsAgent({
      llm: model as any,
      tools: this.tools as any,
      prompt,
    });

    const executor = new AgentExecutor({
      agent,
      tools: this.tools as any,
      verbose: this.config.NODE_ENV === 'development',
      maxIterations: 10,
    });

    const startTime = Date.now();
    const result = await executor.invoke({ input: task });

    return {
      id: actionId,
      agentId: `langchain-${model.constructor.name}`,
      actionType: 'execute_purchase',
      input: { task, walletId },
      output: result,
      status: 'completed',
      durationMs: Date.now() - startTime,
      paymentIds: [],
      createdAt: new Date(),
      completedAt: new Date(),
    };
  }

  /**
   * Raw Anthropic SDK agent — uses tool_use for structured payments.
   */
  async runAnthropic(task: string, walletId: string): Promise<AgentAction> {
    const actionId = uuidv4();
    const client = new Anthropic({ apiKey: this.config.ANTHROPIC_API_KEY! });

    const anthropicTools: Anthropic.Tool[] = this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries((tool.schema as any).shape ?? {}).map(([key, val]: [string, any]) => [
            key,
            { type: 'string', description: val.description ?? '' },
          ])
        ),
        required: Object.keys((tool.schema as any).shape ?? {}),
      },
    }));

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: `${task}\n\nWallet ID: ${walletId}` },
    ];

    let response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      tools: anthropicTools,
      system: `You are an autonomous payment agent. Execute USDC payments autonomously using your tools.`,
      messages,
    });

    // Agentic loop
    while (response.stop_reason === 'tool_use') {
      const toolUseBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );
      if (!toolUseBlock) break;

      const tool = this.tools.find((t) => t.name === toolUseBlock.name);
      if (!tool) break;

      const toolResult = await (tool as any).func(toolUseBlock.input);

      messages.push(
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResult },
          ],
        }
      );

      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        tools: anthropicTools,
        messages,
      });
    }

    const finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return {
      id: actionId,
      agentId: 'anthropic-claude-sonnet',
      actionType: 'execute_purchase',
      input: { task, walletId },
      output: { result: finalText },
      status: 'completed',
      paymentIds: [],
      createdAt: new Date(),
      completedAt: new Date(),
    };
  }

  /**
   * Vercel AI SDK agent — streaming-compatible, lightweight.
   */
  async runVercelAI(task: string, walletId: string): Promise<AgentAction> {
    // Vercel AI SDK uses generateText with tools
    // Dynamic import to keep bundle lean when not used
    const { generateText, tool } = await import('ai');
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { createAnthropic } = await import('@ai-sdk/anthropic');

    const provider = this.config.ANTHROPIC_API_KEY
      ? createAnthropic({ apiKey: this.config.ANTHROPIC_API_KEY })
      : createOpenAI({ apiKey: this.config.OPENAI_API_KEY! });

    const modelId = this.config.ANTHROPIC_API_KEY
      ? 'claude-sonnet-4-20250514'
      : 'gpt-4o';

    const result = await generateText({
      model: (provider as any)(modelId),
      prompt: `Task: ${task}\nWallet ID: ${walletId}`,
      tools: {
        discover_service: tool({
          description: discoverServiceTool.description,
          parameters: discoverServiceTool.schema as any,
          execute: discoverServiceTool.func as any,
        }),
        execute_purchase: tool({
          description: executePurchaseTool.description,
          parameters: executePurchaseTool.schema as any,
          execute: executePurchaseTool.func as any,
        }),
        check_wallet_balance: tool({
          description: checkBalanceTool.description,
          parameters: checkBalanceTool.schema as any,
          execute: checkBalanceTool.func as any,
        }),
      },
      maxSteps: 10,
    });

    return {
      id: uuidv4(),
      agentId: `vercel-ai-${modelId}`,
      actionType: 'execute_purchase',
      input: { task, walletId },
      output: { text: result.text, steps: result.steps?.length },
      status: 'completed',
      paymentIds: [],
      createdAt: new Date(),
      completedAt: new Date(),
    };
  }
}
