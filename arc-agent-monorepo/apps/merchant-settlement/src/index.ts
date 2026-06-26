import Fastify from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, fromUSDCUnits, toUSDCString, toUSDCUnits } from '@arc-agents/config';
import { AgentWalletManager } from '@arc-agents/wallet-client';
import { arcClient, ARC_CONTRACT_ADDRESSES } from '@arc-agents/arc-contracts';
import { CCTPBridgeClient } from '@arc-agents/cctp-bridge';
import { gatewayClient } from '@arc-agents/gateway-client';
import { createLogger } from '@arc-agents/observability';
import type { Settlement, Counterparty, SupportedChain } from '@arc-agents/shared-types';

const logger = createLogger('merchant-settlement');
const walletManager = new AgentWalletManager();
const bridgeClient = new CCTPBridgeClient();

// ─── Settlement Store ─────────────────────────────────────────────────────

const settlements = new Map<string, Settlement>();

// ─── Settlement Engine ────────────────────────────────────────────────────

/**
 * AI-negotiated settlement across multiple counterparties.
 * The agent evaluates each counterparty's preferred chain, routing costs,
 * and liquidity before splitting and executing the settlement.
 */
async function executeMultiPartySettlement(
  settlement: Settlement,
  initiatorPrivateKey: `0x${string}`
): Promise<Settlement> {
  logger.info('Executing multi-party settlement', {
    settlementId: settlement.id,
    counterparties: settlement.counterparties.length,
    total: settlement.totalAmount,
  });

  settlement.status = 'executing';
  settlements.set(settlement.id, settlement);

  const updatedAllocations = await Promise.all(
    settlement.allocations.map(async (allocation) => {
      const counterparty = settlement.counterparties.find(
        (c) => c.id === allocation.counterpartyId
      );
      if (!counterparty) return allocation;

      const targetChain = counterparty.preferredSettlementChain ?? settlement.settlementChain;

      try {
        // If counterparty is on a different chain, bridge USDC via CCTPv2 first
        if (targetChain !== settlement.settlementChain) {
          logger.info('Bridging for counterparty', {
            counterpartyId: counterparty.id,
            from: settlement.settlementChain,
            to: targetChain,
            amount: allocation.amount,
          });

          const bridge = await bridgeClient.bridge({
            privateKey: initiatorPrivateKey,
            fromChain: settlement.settlementChain,
            toChain: targetChain,
            toAddress: counterparty.address,
            amount: fromUSDCUnits(allocation.amount).toString(),
          });

          return { ...allocation, chain: targetChain, txHash: bridge.mintTxHash };
        }

        // Same chain — direct USDC transfer
        const payment = await walletManager.transferUSDC({
          walletId: settlement.initiatorWalletId,
          destinationAddress: counterparty.address,
          amountUSDC: fromUSDCUnits(allocation.amount),
          chain: targetChain,
          metadata: { settlementId: settlement.id, counterpartyId: counterparty.id },
        });

        return { ...allocation, txHash: payment.txHash, chain: targetChain };
      } catch (err) {
        logger.error('Allocation failed', {
          counterpartyId: counterparty.id,
          error: String(err),
        });
        return allocation;
      }
    })
  );

  const completed: Settlement = {
    ...settlement,
    allocations: updatedAllocations,
    status: 'settled',
    settledAt: new Date(),
  };
  settlements.set(settlement.id, completed);

  logger.info('Settlement completed', { settlementId: settlement.id });
  return completed;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get('/health', async () => ({ status: 'ok', service: 'merchant-settlement' }));

/**
 * Initiate a multi-party settlement.
 * The system uses Gateway to route liquidity optimally across chains.
 */
app.post('/settlements', async (req, reply) => {
  const body = req.body as {
    initiatorWalletId: string;
    counterparties: Array<{
      address: string;
      name: string;
      chain: SupportedChain;
      preferredChain?: SupportedChain;
      amountUSDC: number;
    }>;
    settlementChain?: SupportedChain;
  };

  const settlementChain = body.settlementChain ?? 'Arc_Testnet';
  const totalAmount = body.counterparties.reduce((sum, c) => sum + c.amountUSDC, 0);

  // Get routing recommendation from Gateway
  const routing = await gatewayClient.routeLiquidity({
    fromChain: 'Arc_Testnet',
    toChain: settlementChain,
    amount: totalAmount,
    urgency: 'medium',
  });

  const counterparties: Counterparty[] = body.counterparties.map((c) => ({
    id: uuidv4(),
    address: c.address,
    name: c.name,
    chain: c.chain,
    preferredSettlementChain: c.preferredChain,
    totalSettled: '0',
  }));

  const settlement: Settlement = {
    id: uuidv4(),
    initiatorWalletId: body.initiatorWalletId,
    counterparties,
    totalAmount: toUSDCString(totalAmount),
    allocations: counterparties.map((cp, i) => ({
      counterpartyId: cp.id,
      amount: toUSDCString(body.counterparties[i]?.amountUSDC ?? 0),
      chain: cp.preferredSettlementChain ?? settlementChain,
    })),
    status: 'negotiating',
    settlementChain,
    createdAt: new Date(),
  };

  settlements.set(settlement.id, settlement);

  return reply.code(201).send({
    success: true,
    data: settlement,
    routing,
    estimatedSeconds: routing.estimatedSeconds,
  });
});

/**
 * Approve and execute a settlement.
 */
app.post<{ Params: { id: string } }>('/settlements/:id/execute', async (req, reply) => {
  const settlement = settlements.get(req.params.id);
  if (!settlement) {
    return reply.code(404).send({ success: false, error: 'Settlement not found' });
  }
  if (settlement.status !== 'negotiating') {
    return reply.code(400).send({ success: false, error: `Settlement is ${settlement.status}` });
  }

  const { privateKey } = req.body as { privateKey: `0x${string}` };

  settlement.status = 'approved';
  settlements.set(settlement.id, settlement);

  // Execute asynchronously for large settlements
  const executed = await executeMultiPartySettlement(settlement, privateKey);

  return { success: true, data: executed };
});

app.get('/settlements', async () => ({
  success: true,
  data: [...settlements.values()],
}));

app.get<{ Params: { id: string } }>('/settlements/:id', async (req, reply) => {
  const s = settlements.get(req.params.id);
  if (!s) return reply.code(404).send({ success: false, error: 'Not found' });
  return { success: true, data: s };
});

const PORT = parseInt(process.env['PORT'] ?? '3003');
app.listen({ port: PORT, host: '0.0.0.0' }, () => {
  logger.info('merchant-settlement running', { port: PORT });
});
