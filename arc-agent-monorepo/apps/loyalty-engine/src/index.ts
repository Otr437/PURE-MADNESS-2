import Fastify from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, fromUSDCUnits, toUSDCString } from '@arc-agents/config';
import { AgentWalletManager } from '@arc-agents/wallet-client';
import { gatewayClient } from '@arc-agents/gateway-client';
import { CCTPBridgeClient } from '@arc-agents/cctp-bridge';
import { createLogger } from '@arc-agents/observability';
import type { LoyaltyReward, SupportedChain } from '@arc-agents/shared-types';

const logger = createLogger('loyalty-engine');
const walletManager = new AgentWalletManager();
const bridgeClient = new CCTPBridgeClient();

// ─── Reward Store ─────────────────────────────────────────────────────────

const rewards = new Map<string, LoyaltyReward>();

// ─── AI Reasoning: Cost vs Reward Optimizer ───────────────────────────────

/**
 * Claude reasons about whether a reward is worth claiming given
 * bridge costs, gas fees, timing, and current chain conditions.
 */
async function reasonAboutRewardClaim(params: {
  rewardAmountUSDC: number;
  sourceChain: SupportedChain;
  targetChain: SupportedChain;
  walletBalances: Array<{ chain: SupportedChain; balance: number }>;
}): Promise<{
  shouldClaim: boolean;
  reasoning: string;
  recommendedChain: SupportedChain;
  estimatedNetGainUSDC: number;
}> {
  const config = getConfig();
  if (!config.ANTHROPIC_API_KEY) {
    // Fallback: simple heuristic
    const shouldClaim = params.rewardAmountUSDC > 0.01;
    return {
      shouldClaim,
      reasoning: 'Heuristic: claim if reward > $0.01',
      recommendedChain: params.sourceChain,
      estimatedNetGainUSDC: params.rewardAmountUSDC,
    };
  }

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const prompt = `You are a financial reasoning agent optimizing USDC reward claiming across blockchains.

Reward details:
- Reward amount: $${params.rewardAmountUSDC} USDC
- Currently on: ${params.sourceChain}
- Best receiving chain: ${params.targetChain}
- Wallet balances: ${JSON.stringify(params.walletBalances)}

Key context (May 2026):
- Arc Testnet: Gas-free USDC transfers, <0.5s finality
- Base: ~$0.001 gas per transfer, 2s finality
- Ethereum: ~$0.50-2.00 gas per transfer, 12s finality
- CCTPv2 bridge: 8-20 seconds, no fee at protocol level
- Nanopayments: $0.000001 minimum, gas-free on Arc

Analyze: Is it economically rational to claim this reward?
Respond in JSON: { "shouldClaim": boolean, "reasoning": string, "recommendedChain": string, "estimatedNetGainUSDC": number }`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        shouldClaim: parsed.shouldClaim ?? true,
        reasoning: parsed.reasoning ?? '',
        recommendedChain: (parsed.recommendedChain as SupportedChain) ?? params.targetChain,
        estimatedNetGainUSDC: parsed.estimatedNetGainUSDC ?? params.rewardAmountUSDC,
      };
    }
  } catch {}

  return {
    shouldClaim: true,
    reasoning: 'Claim approved by default',
    recommendedChain: params.targetChain,
    estimatedNetGainUSDC: params.rewardAmountUSDC,
  };
}

// ─── HTTP Server ──────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get('/health', async () => ({ status: 'ok', service: 'loyalty-engine' }));

/**
 * Evaluate and optionally claim a loyalty reward.
 * AI reasons about cost vs reward before executing.
 */
app.post('/rewards/evaluate', async (req, reply) => {
  const body = req.body as {
    walletId: string;
    rewardAmountUSDC: number;
    rewardType: 'cashback' | 'usdc_rebate' | 'points' | 'fee_discount';
    sourceChain: SupportedChain;
    preferredTargetChain?: SupportedChain;
    autoExecute?: boolean;
  };

  // Get unified balances across all chains
  const balance = await gatewayClient.getUnifiedBalance(body.walletId);

  const analysis = await reasonAboutRewardClaim({
    rewardAmountUSDC: body.rewardAmountUSDC,
    sourceChain: body.sourceChain,
    targetChain: body.preferredTargetChain ?? 'Arc_Testnet',
    walletBalances: balance.byChain,
  });

  if (!analysis.shouldClaim) {
    return {
      success: true,
      data: {
        action: 'deferred',
        reasoning: analysis.reasoning,
        estimatedNetGain: analysis.estimatedNetGainUSDC,
      },
    };
  }

  if (!body.autoExecute) {
    return {
      success: true,
      data: {
        action: 'recommended',
        shouldClaim: true,
        reasoning: analysis.reasoning,
        recommendedChain: analysis.recommendedChain,
        estimatedNetGain: analysis.estimatedNetGainUSDC,
      },
    };
  }

  // Execute reward claim
  const reward: LoyaltyReward = {
    id: uuidv4(),
    agentWalletId: body.walletId,
    rewardType: body.rewardType,
    amount: toUSDCString(body.rewardAmountUSDC),
    sourceChain: body.sourceChain,
    targetChain: analysis.recommendedChain,
    routing: [
      { step: 1, chain: body.sourceChain, action: 'claim', amount: toUSDCString(body.rewardAmountUSDC) },
    ],
    claimedAt: new Date(),
  };

  // If cross-chain routing needed, bridge via CCTPv2
  if (body.sourceChain !== analysis.recommendedChain) {
    reward.routing.push({
      step: 2,
      chain: analysis.recommendedChain,
      action: 'bridge_cctp',
      amount: toUSDCString(analysis.estimatedNetGainUSDC),
    });
  }

  rewards.set(reward.id, reward);

  logger.info('Reward claimed', {
    rewardId: reward.id,
    amount: body.rewardAmountUSDC,
    chain: analysis.recommendedChain,
  });

  return { success: true, data: { reward, analysis } };
});

/**
 * Get reward routing optimization for a wallet.
 * AI recommends which chain to consolidate rewards on for lowest friction.
 */
app.get<{ Params: { walletId: string } }>('/rewards/routing/:walletId', async (req) => {
  const balance = await gatewayClient.getUnifiedBalance(req.params.walletId);

  const recommendation = await reasonAboutRewardClaim({
    rewardAmountUSDC: balance.totalUSDC * 0.01, // 1% hypothetical reward
    sourceChain: 'Base',
    targetChain: 'Arc_Testnet',
    walletBalances: balance.byChain,
  });

  return {
    success: true,
    data: {
      walletId: req.params.walletId,
      totalBalance: balance.totalUSDC,
      byChain: balance.byChain,
      recommendedConsolidationChain: recommendation.recommendedChain,
      reasoning: recommendation.reasoning,
    },
  };
});

app.get('/rewards', async () => ({
  success: true,
  data: [...rewards.values()],
}));

const PORT = parseInt(process.env['PORT'] ?? '3006');
app.listen({ port: PORT, host: '0.0.0.0' }, () => {
  logger.info('loyalty-engine running', { port: PORT });
});
