import Fastify from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, toUSDCString } from '@arc-agents/config';
import { NanopayClient, withPaywall } from '@arc-agents/nanopay';
import { AgentWalletManager } from '@arc-agents/wallet-client';
import { createLogger } from '@arc-agents/observability';
import type { InferencePayment } from '@arc-agents/shared-types';

const logger = createLogger('inference-pay');

// ─── Pricing (USDC per 1k tokens) ────────────────────────────────────────
// Prices denominated in USDC — agents pay per actual usage

const INFERENCE_PRICING = {
  'claude-sonnet-4-20250514': { inputPer1k: 0.003, outputPer1k: 0.015 },
  'claude-haiku-4-5': { inputPer1k: 0.00025, outputPer1k: 0.00125 },
  'gpt-4o': { inputPer1k: 0.005, outputPer1k: 0.015 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
} as const;

type ModelId = keyof typeof INFERENCE_PRICING;

function calculateCost(model: ModelId, inputTokens: number, outputTokens: number): number {
  const pricing = INFERENCE_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens / 1000) * pricing.inputPer1k + (outputTokens / 1000) * pricing.outputPer1k;
}

// ─── Inference Store ──────────────────────────────────────────────────────

const inferencePayments = new Map<string, InferencePayment>();

// ─── HTTP Server ──────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get('/health', async () => ({ status: 'ok', service: 'inference-pay' }));

/**
 * Pay-per-inference endpoint.
 * The agent wallet is charged via nanopayment for each model response.
 *
 * Flow:
 * 1. Request arrives with walletId + prompt
 * 2. Estimate cost based on prompt length
 * 3. Check wallet has sufficient balance
 * 4. Execute inference
 * 5. Charge exact cost via nanopayment (post-pay)
 */
app.post('/inference', async (req, reply) => {
  const body = req.body as {
    walletId: string;
    walletAddress: string;
    model: string;
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    provider?: 'anthropic' | 'openai';
  };

  const config = getConfig();
  const model = body.model as ModelId;
  const provider = body.provider ?? (body.model.includes('claude') ? 'anthropic' : 'openai');
  const requestId = uuidv4();

  // Estimate cost (using input tokens as proxy before response)
  const inputText = body.messages.map((m) => m.content).join(' ');
  const estimatedInputTokens = Math.ceil(inputText.length / 4);
  const estimatedMaxOutput = body.maxTokens ?? 1000;
  const estimatedCost = calculateCost(model, estimatedInputTokens, estimatedMaxOutput);

  // Check balance before inference
  const walletManager = new AgentWalletManager();
  const balance = await walletManager.getWalletBalance(body.walletId);
  if (balance.usdc < estimatedCost) {
    return reply.code(402).send({
      success: false,
      error: 'Insufficient USDC balance for inference',
      required: estimatedCost,
      available: balance.usdc,
    });
  }

  let responseText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  // Execute inference
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY! });
    const response = await client.messages.create({
      model: body.model,
      max_tokens: body.maxTokens ?? 1024,
      messages: body.messages as Anthropic.MessageParam[],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );
    responseText = textBlock?.text ?? '';
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
  } else {
    const client = new OpenAI({ apiKey: config.OPENAI_API_KEY! });
    const response = await client.chat.completions.create({
      model: body.model,
      max_tokens: body.maxTokens ?? 1024,
      messages: body.messages as any,
    });
    responseText = response.choices[0]?.message?.content ?? '';
    inputTokens = response.usage?.prompt_tokens ?? 0;
    outputTokens = response.usage?.completion_tokens ?? 0;
  }

  // Calculate exact cost from actual token usage
  const exactCost = calculateCost(model, inputTokens, outputTokens);

  // Charge via nanopayment — sub-cent, gas-free on Arc
  const nanopayClient = new NanopayClient({
    walletId: body.walletId,
    walletAddress: body.walletAddress,
    privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    chain: 'Arc_Testnet',
  });

  // Nanopayments go to the inference-pay service treasury wallet
  const INFERENCE_TREASURY = process.env['INFERENCE_TREASURY_ADDRESS'] ?? '0x0000000000000000000000000000000000000099';

  const inferencePayment: InferencePayment = {
    id: uuidv4(),
    agentId: body.walletId,
    modelProvider: provider,
    modelId: body.model,
    inputTokens,
    outputTokens,
    costUSDC: toUSDCString(exactCost),
    requestId,
    createdAt: new Date(),
  };

  // Post-pay via nanopayment after successful inference
  if (exactCost > 0) {
    try {
      await walletManager.transferUSDC({
        walletId: body.walletId,
        destinationAddress: INFERENCE_TREASURY,
        amountUSDC: exactCost,
        chain: 'Arc_Testnet',
        metadata: { type: 'inference', requestId, model: body.model },
      });
      inferencePayment.nanopaymentId = requestId;
    } catch (err) {
      logger.warn('Inference payment failed — service may pause', { error: String(err) });
    }
  }

  inferencePayments.set(inferencePayment.id, inferencePayment);

  logger.info('Inference completed', {
    requestId,
    model: body.model,
    inputTokens,
    outputTokens,
    costUSDC: exactCost,
  });

  return {
    success: true,
    data: {
      requestId,
      content: responseText,
      usage: { inputTokens, outputTokens },
      cost: {
        usdc: exactCost,
        breakdown: {
          inputCost: (inputTokens / 1000) * (INFERENCE_PRICING[model]?.inputPer1k ?? 0),
          outputCost: (outputTokens / 1000) * (INFERENCE_PRICING[model]?.outputPer1k ?? 0),
        },
      },
      payment: inferencePayment,
    },
  };
});

/**
 * Paywalled inference endpoint — requires x402 payment header.
 * External clients must pay before each request.
 */
const INFERENCE_SELLER_ADDRESS = process.env['INFERENCE_SELLER_ADDRESS'] ?? '0x0000000000000000000000000000000000000099';

app.get(
  '/inference/paywalled',
  { preHandler: withPaywall('$0.001', INFERENCE_SELLER_ADDRESS) as any },
  async (req) => {
    return {
      success: true,
      data: {
        message: 'Payment verified. Inference access granted.',
        endpoint: 'POST /inference',
        pricing: INFERENCE_PRICING,
      },
    };
  }
);

app.get('/inference/pricing', async () => ({
  success: true,
  data: { pricing: INFERENCE_PRICING, currency: 'USDC', decimals: 6 },
}));

app.get('/inference/history', async () => ({
  success: true,
  data: [...inferencePayments.values()].slice(-100),
}));

const PORT = parseInt(process.env['PORT'] ?? '3004');
app.listen({ port: PORT, host: '0.0.0.0' }, () => {
  logger.info('inference-pay running', { port: PORT });
});
