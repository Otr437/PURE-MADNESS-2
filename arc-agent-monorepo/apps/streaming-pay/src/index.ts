import Fastify from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getConfig, toUSDCString, fromUSDCUnits, toUSDCUnits } from '@arc-agents/config';
import { AgentWalletManager } from '@arc-agents/wallet-client';
import { arcClient } from '@arc-agents/arc-contracts';
import { NanopayClient } from '@arc-agents/nanopay';
import { createLogger } from '@arc-agents/observability';
import type { Stream, SupportedChain } from '@arc-agents/shared-types';

const logger = createLogger('streaming-pay');
const walletManager = new AgentWalletManager();

// ─── Stream Store ─────────────────────────────────────────────────────────

const streams = new Map<string, Stream>();
const streamTimers = new Map<string, ReturnType<typeof setInterval>>();

// ─── Stream Engine ────────────────────────────────────────────────────────

/**
 * Time-based streaming: charges receiver per second.
 * Uses nanopayments for sub-cent per-second rates.
 */
function startStreamMeter(stream: Stream, nanopayClient: NanopayClient) {
  const streamId = stream.id;
  let accumulated = BigInt(0);

  const timer = setInterval(async () => {
    const currentStream = streams.get(streamId);
    if (!currentStream || currentStream.status !== 'active') {
      clearInterval(timer);
      streamTimers.delete(streamId);
      return;
    }

    // Check deposit hasn't run dry
    const deposited = BigInt(currentStream.totalDeposited);
    const withdrawn = BigInt(currentStream.totalWithdrawn);
    const available = deposited - withdrawn;

    const ratePerSecond = BigInt(currentStream.ratePerSecond);

    if (available < ratePerSecond) {
      logger.warn('Stream deposit depleted — pausing', { streamId });
      streams.set(streamId, { ...currentStream, status: 'paused' });
      clearInterval(timer);
      streamTimers.delete(streamId);
      return;
    }

    accumulated += ratePerSecond;

    // Batch: flush accumulated every 30s or when batch threshold hit
    const batchThresholdUnits = BigInt(30) * ratePerSecond; // 30s of accumulation
    if (accumulated >= batchThresholdUnits) {
      const amountUSDC = fromUSDCUnits(accumulated);

      await walletManager.transferUSDC({
        walletId: currentStream.senderWalletId,
        destinationAddress: currentStream.receiverAddress,
        amountUSDC,
        chain: currentStream.chain,
        metadata: { streamId, type: 'stream_payment' },
      }).catch((err) => logger.error('Stream payment failed', { streamId, error: String(err) }));

      // Update totals
      const newWithdrawn = (BigInt(currentStream.totalWithdrawn) + accumulated).toString();
      streams.set(streamId, {
        ...currentStream,
        totalWithdrawn: newWithdrawn,
      });

      accumulated = BigInt(0);
    }
  }, 1000); // tick every second

  streamTimers.set(streamId, timer);
}

// ─── HTTP Server ──────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

app.get('/health', async () => ({ status: 'ok', service: 'streaming-pay' }));

/**
 * Create a new streaming payment (time-based or event-based).
 */
app.post('/streams', async (req, reply) => {
  const body = req.body as {
    senderWalletId: string;
    receiverAddress: string;
    chain?: SupportedChain;
    ratePerSecondUSDC: number;    // e.g., 0.0001 = $0.0001/s = $8.64/day
    depositUSDC: number;          // Upfront deposit to fund stream
    streamType?: 'time_based' | 'event_based' | 'hybrid';
    privateKey: string;           // For Arc contract interaction
  };

  const chain = body.chain ?? 'Arc_Testnet';
  const ratePerSecondUnits = toUSDCUnits(body.ratePerSecondUSDC);
  const depositUnits = toUSDCUnits(body.depositUSDC);

  // Check sender has sufficient balance
  const balance = await walletManager.getWalletBalance(body.senderWalletId);
  if (balance.usdc < body.depositUSDC) {
    return reply.code(402).send({
      success: false,
      error: `Insufficient balance. Required: $${body.depositUSDC}, Available: $${balance.usdc}`,
    });
  }

  const streamId = uuidv4();

  // Create stream on Arc smart contract
  let arcStreamId = streamId;
  if (body.privateKey && body.privateKey !== 'mock') {
    try {
      const { txHash } = await arcClient.createStream({
        privateKey: body.privateKey as `0x${string}`,
        receiverAddress: body.receiverAddress as `0x${string}`,
        ratePerSecondUSDC: ratePerSecondUnits,
        depositUSDC: depositUnits,
      });
      arcStreamId = txHash;
    } catch (err) {
      logger.warn('Arc contract stream creation failed, using off-chain stream', { error: String(err) });
    }
  }

  const stream: Stream = {
    id: streamId,
    senderWalletId: body.senderWalletId,
    receiverAddress: body.receiverAddress,
    chain,
    ratePerSecond: ratePerSecondUnits.toString(),
    totalDeposited: depositUnits.toString(),
    totalWithdrawn: '0',
    streamType: body.streamType ?? 'time_based',
    status: 'active',
    startedAt: new Date(),
    contractAddress: arcStreamId,
  };

  streams.set(streamId, stream);

  // Start the stream meter
  const nanopayClient = new NanopayClient({
    walletId: body.senderWalletId,
    walletAddress: '0x0000000000000000000000000000000000000000',
    privateKey: (body.privateKey as `0x${string}`) ?? '0x0',
    chain,
  });

  startStreamMeter(stream, nanopayClient);

  logger.info('Stream started', {
    streamId,
    ratePerSecondUSDC: body.ratePerSecondUSDC,
    depositUSDC: body.depositUSDC,
  });

  return reply.code(201).send({
    success: true,
    data: stream,
    durationEstimateSeconds: body.depositUSDC / body.ratePerSecondUSDC,
  });
});

/**
 * Emit a payment event (event-based streaming).
 */
app.post<{ Params: { id: string } }>('/streams/:id/event', async (req, reply) => {
  const stream = streams.get(req.params.id);
  if (!stream) return reply.code(404).send({ success: false, error: 'Stream not found' });
  if (stream.status !== 'active') {
    return reply.code(400).send({ success: false, error: `Stream is ${stream.status}` });
  }
  if (stream.streamType === 'time_based') {
    return reply.code(400).send({ success: false, error: 'Time-based stream does not accept events' });
  }

  const { eventValue } = req.body as { eventValue?: number };
  const paymentAmount = eventValue
    ? toUSDCUnits(eventValue)
    : BigInt(stream.ratePerSecond); // default: one rate-unit per event

  await walletManager.transferUSDC({
    walletId: stream.senderWalletId,
    destinationAddress: stream.receiverAddress,
    amountUSDC: fromUSDCUnits(paymentAmount),
    chain: stream.chain,
    metadata: { streamId: stream.id, type: 'event_payment' },
  });

  const updated: Stream = {
    ...stream,
    totalWithdrawn: (BigInt(stream.totalWithdrawn) + paymentAmount).toString(),
  };
  streams.set(stream.id, updated);

  return { success: true, data: { eventProcessed: true, amountPaid: fromUSDCUnits(paymentAmount) } };
});

app.patch<{ Params: { id: string } }>('/streams/:id/pause', async (req, reply) => {
  const stream = streams.get(req.params.id);
  if (!stream) return reply.code(404).send({ success: false, error: 'Not found' });
  streams.set(stream.id, { ...stream, status: 'paused' });
  return { success: true };
});

app.patch<{ Params: { id: string } }>('/streams/:id/cancel', async (req, reply) => {
  const stream = streams.get(req.params.id);
  if (!stream) return reply.code(404).send({ success: false, error: 'Not found' });

  const timer = streamTimers.get(stream.id);
  if (timer) { clearInterval(timer); streamTimers.delete(stream.id); }

  streams.set(stream.id, { ...stream, status: 'cancelled', endedAt: new Date() });
  return { success: true };
});

app.get('/streams', async () => ({
  success: true,
  data: [...streams.values()],
}));

app.get<{ Params: { id: string } }>('/streams/:id', async (req, reply) => {
  const stream = streams.get(req.params.id);
  if (!stream) return reply.code(404).send({ success: false, error: 'Not found' });

  const elapsed = (Date.now() - stream.startedAt.getTime()) / 1000;
  const earned = Math.min(
    fromUSDCUnits(BigInt(stream.ratePerSecond)) * elapsed,
    fromUSDCUnits(stream.totalDeposited)
  );

  return {
    success: true,
    data: {
      ...stream,
      currentEarnedUSDC: earned,
      remainingDepositUSDC: fromUSDCUnits(stream.totalDeposited) - fromUSDCUnits(stream.totalWithdrawn),
      elapsedSeconds: elapsed,
    },
  };
});

const PORT = parseInt(process.env['PORT'] ?? '3005');
app.listen({ port: PORT, host: '0.0.0.0' }, () => {
  logger.info('streaming-pay running', { port: PORT });
});
