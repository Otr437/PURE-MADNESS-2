import Fastify from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, toUSDCString, fromUSDCUnits } from '@arc-agents/config';
import { AgentWalletManager } from '@arc-agents/wallet-client';
import { arcClient } from '@arc-agents/arc-contracts';
import { createLogger } from '@arc-agents/observability';
import { createQueue, createWorker, QUEUE_NAMES } from '@arc-agents/queue';
import type { Subscription, SubscriptionStatus } from '@arc-agents/shared-types';

const logger = createLogger('subscription-manager');
const walletManager = new AgentWalletManager();

// ─── In-memory store (replace with Postgres in production) ────────────────

const subscriptions = new Map<string, Subscription>();

// ─── Renewal Worker ───────────────────────────────────────────────────────

const renewalWorker = createWorker<{
  subscriptionId: string;
  walletId: string;
  merchantAddress: string;
  amountUSDC: number;
  chain: string;
}>(
  QUEUE_NAMES.SUBSCRIPTION_RENEWAL,
  async (job) => {
    const { subscriptionId, walletId, merchantAddress, amountUSDC, chain } = job.data;
    const sub = subscriptions.get(subscriptionId);

    if (!sub) {
      logger.warn('Subscription not found for renewal', { subscriptionId });
      return;
    }

    if (sub.status !== 'active') {
      logger.info('Skipping renewal — subscription not active', { subscriptionId, status: sub.status });
      return;
    }

    logger.info('Processing renewal', { subscriptionId, amountUSDC, merchantAddress });

    // Check wallet has sufficient balance
    const balance = await walletManager.getWalletBalance(walletId);
    if (balance.usdc < amountUSDC) {
      logger.warn('Insufficient balance for renewal', {
        subscriptionId,
        balance: balance.usdc,
        required: amountUSDC,
      });
      sub.status = 'past_due';
      subscriptions.set(subscriptionId, sub);
      return;
    }

    // Execute payment via Circle Wallet
    const payment = await walletManager.transferUSDC({
      walletId,
      destinationAddress: merchantAddress,
      amountUSDC,
      chain: chain as any,
      metadata: { subscriptionId, type: 'renewal' },
    });

    // Update subscription
    const nextRenewalAt = new Date();
    nextRenewalAt.setDate(nextRenewalAt.getDate() + sub.periodDays);

    const updated: Subscription = {
      ...sub,
      status: 'active',
      lastPaidAt: new Date(),
      nextRenewalAt,
    };
    subscriptions.set(subscriptionId, updated);

    // Schedule next renewal
    await scheduleRenewal(updated);

    logger.info('Renewal completed', {
      subscriptionId,
      txHash: payment.txHash,
      nextRenewalAt,
    });
  },
  2 // max 2 concurrent renewals
);

// ─── Helpers ──────────────────────────────────────────────────────────────

async function scheduleRenewal(sub: Subscription) {
  if (!sub.autoRenew) return;
  const queue = createQueue(QUEUE_NAMES.SUBSCRIPTION_RENEWAL);
  const delayMs = sub.nextRenewalAt.getTime() - Date.now();

  await queue.add(
    `renew:${sub.id}`,
    {
      subscriptionId: sub.id,
      walletId: sub.agentWalletId,
      merchantAddress: sub.merchantAddress,
      amountUSDC: fromUSDCUnits(sub.amount),
      chain: sub.chain,
    },
    { delay: Math.max(delayMs, 0), jobId: `renewal-${sub.id}-${sub.nextRenewalAt.getTime()}` }
  );
}

// ─── HTTP Server ──────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get('/health', async () => ({ status: 'ok', service: 'subscription-manager' }));

/**
 * Create a new subscription with auto-renewal scheduling.
 */
app.post('/subscriptions', async (req, reply) => {
  const body = req.body as {
    walletId: string;
    merchantAddress: string;
    merchantName: string;
    amountUSDC: number;
    chain?: string;
    periodDays: number;
    budgetCapUSDC?: number;
    autoRenew?: boolean;
  };

  // Check budget cap if set
  const existingSpend = [...subscriptions.values()]
    .filter((s) => s.agentWalletId === body.walletId && s.status === 'active')
    .reduce((sum, s) => sum + fromUSDCUnits(s.amount) * (30 / s.periodDays), 0);

  if (body.budgetCapUSDC && existingSpend + body.amountUSDC * (30 / body.periodDays) > body.budgetCapUSDC) {
    return reply.code(400).send({
      success: false,
      error: `Monthly subscription budget cap of $${body.budgetCapUSDC} would be exceeded`,
    });
  }

  const nextRenewalAt = new Date();
  nextRenewalAt.setDate(nextRenewalAt.getDate() + body.periodDays);

  const sub: Subscription = {
    id: uuidv4(),
    agentWalletId: body.walletId,
    merchantAddress: body.merchantAddress,
    merchantName: body.merchantName,
    amount: toUSDCString(body.amountUSDC),
    chain: (body.chain ?? 'Arc_Testnet') as any,
    periodDays: body.periodDays,
    status: 'active',
    nextRenewalAt,
    autoRenew: body.autoRenew ?? true,
    budgetCapUSDC: body.budgetCapUSDC ? toUSDCString(body.budgetCapUSDC) : undefined,
    createdAt: new Date(),
  };

  subscriptions.set(sub.id, sub);

  // Execute first payment immediately
  await walletManager.transferUSDC({
    walletId: body.walletId,
    destinationAddress: body.merchantAddress,
    amountUSDC: body.amountUSDC,
    chain: sub.chain,
    metadata: { subscriptionId: sub.id, type: 'initial' },
  });

  // Schedule recurring renewals
  if (sub.autoRenew) await scheduleRenewal(sub);

  logger.info('Subscription created', { subscriptionId: sub.id });
  return reply.code(201).send({ success: true, data: sub });
});

app.get('/subscriptions', async () => ({
  success: true,
  data: [...subscriptions.values()],
}));

app.get<{ Params: { id: string } }>('/subscriptions/:id', async (req, reply) => {
  const sub = subscriptions.get(req.params.id);
  if (!sub) return reply.code(404).send({ success: false, error: 'Not found' });
  return { success: true, data: sub };
});

app.patch<{ Params: { id: string } }>('/subscriptions/:id/cancel', async (req, reply) => {
  const sub = subscriptions.get(req.params.id);
  if (!sub) return reply.code(404).send({ success: false, error: 'Not found' });
  subscriptions.set(sub.id, { ...sub, status: 'cancelled', autoRenew: false });
  return { success: true, data: { cancelled: true } };
});

/**
 * Get budget analysis for a wallet — how much is committed monthly.
 */
app.get<{ Params: { walletId: string } }>('/subscriptions/budget/:walletId', async (req) => {
  const walletSubs = [...subscriptions.values()].filter(
    (s) => s.agentWalletId === req.params.walletId && s.status === 'active'
  );

  const monthlyCommitment = walletSubs.reduce(
    (sum, s) => sum + fromUSDCUnits(s.amount) * (30 / s.periodDays),
    0
  );

  const balance = await walletManager.getWalletBalance(req.params.walletId);

  return {
    success: true,
    data: {
      walletId: req.params.walletId,
      currentBalance: balance.usdc,
      monthlyCommitmentUSDC: monthlyCommitment,
      activeSubscriptions: walletSubs.length,
      monthsOfRunway: balance.usdc / (monthlyCommitment || 1),
      subscriptions: walletSubs,
    },
  };
});

const PORT = parseInt(process.env['PORT'] ?? '3002');
app.listen({ port: PORT, host: '0.0.0.0' }, () => {
  logger.info('subscription-manager running', { port: PORT });
});
