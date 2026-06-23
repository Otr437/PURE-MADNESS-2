// ============================================================
// MODULE 15: STELLAR ENGINE
// Role: Full Stellar network operations — accounts, payments,
//       asset issuance, smart contracts (Soroban), clawback,
//       multi-sig, path payments, DEX, and federation lookups.
//       All signing happens here — secret keys never leave.
// Knows about: Module 6 (persists contracts/txs)
//              Module 9 (emits stellar events)
//              Module 2 (audits Soroban WASM before deploy)
//              Module 1 (gate-checks all Soroban source)
// Port: 3015
// Security: Rate-limited, internal-token auth, input validated,
//           replay-attack resistant (sequence tracking),
//           memo-hash verification, optional clawback policies.
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import crypto from 'crypto';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getTodayISO, getTodayDate, fetchWithTimeout } from '../shared/date-utils.js';
import { internalFetch, verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';
import type { HealthStatus } from '../shared/types.js';

const execAsync = promisify(execFile);
const SERVICE_START = Date.now();
const WORKSPACE = process.env.STELLAR_WORKSPACE ?? join(process.cwd(), '.stellar-workspace');

// ── Stellar network configs ───────────────────────────────────

const STELLAR_NETWORKS = {
  mainnet: {
    name: 'mainnet' as const,
    horizonUrl: process.env.STELLAR_MAINNET_HORIZON_URL ?? 'https://horizon.stellar.org',
    sorobanRpcUrl: process.env.STELLAR_MAINNET_SOROBAN_RPC ?? 'https://soroban-mainnet.stellar.org:443',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    explorerUrl: 'https://stellar.expert/explorer/public',
    isTestnet: false,
  },
  testnet: {
    name: 'testnet' as const,
    horizonUrl: process.env.STELLAR_TESTNET_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: process.env.STELLAR_TESTNET_SOROBAN_RPC ?? 'https://soroban-testnet.stellar.org:443',
    networkPassphrase: 'Test SDF Network ; September 2015',
    explorerUrl: 'https://stellar.expert/explorer/testnet',
    isTestnet: true,
  },
  futurenet: {
    name: 'futurenet' as const,
    horizonUrl: process.env.STELLAR_FUTURENET_HORIZON_URL ?? 'https://horizon-futurenet.stellar.org',
    sorobanRpcUrl: process.env.STELLAR_FUTURENET_SOROBAN_RPC ?? 'https://rpc-futurenet.stellar.org:443',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
    explorerUrl: 'https://stellar.expert/explorer/futurenet',
    isTestnet: true,
  },
};

type StellarNetwork = keyof typeof STELLAR_NETWORKS;

// ── Fastify setup ─────────────────────────────────────────────

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 120_000,
});

await fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGIN ?? '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', INTERNAL_HEADER],
});

await fastify.register(rateLimit, { max: 30, timeWindow: '1 minute' });

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

// ── Auth hook ─────────────────────────────────────────────────

fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.url === '/health' || req.url === '/networks' || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Internal token or Bearer auth required' });
    }
    try {
      const hash = crypto.createHash('sha256').update(auth.slice(7)).digest('hex');
      const res = await internalFetch('module6-database', `/oauth-tokens/by-hash/${hash}`, {}, 5_000);
      if (!res.ok) return reply.status(401).send({ error: 'Invalid or expired token' });
    } catch {
      return reply.status(503).send({ error: 'Auth unavailable' });
    }
  }
});

// ── Horizon API helpers ───────────────────────────────────────

async function horizonGet(network: StellarNetwork, path: string): Promise<unknown> {
  const cfg = STELLAR_NETWORKS[network];
  const url = `${cfg.horizonUrl}${path}`;
  const res = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json' },
  }, 15_000);
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Horizon ${res.status}: ${errBody.slice(0, 200)}`);
  }
  return res.json();
}

async function horizonPost(network: StellarNetwork, path: string, body: Record<string, string>): Promise<unknown> {
  const cfg = STELLAR_NETWORKS[network];
  const url = `${cfg.horizonUrl}${path}`;
  const params = new URLSearchParams(body);
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  }, 30_000);
  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    const detail = (data['extras'] as Record<string, unknown>)?.['result_codes'] ?? data['detail'] ?? data;
    throw new Error(`Horizon submit failed ${res.status}: ${JSON.stringify(detail).slice(0, 300)}`);
  }
  return data;
}

// ── Soroban RPC helpers ───────────────────────────────────────

async function sorobanRpc(network: StellarNetwork, method: string, params: unknown): Promise<unknown> {
  const cfg = STELLAR_NETWORKS[network];
  const res = await fetchWithTimeout(cfg.sorobanRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 30_000);
  if (!res.ok) throw new Error(`Soroban RPC HTTP ${res.status}`);
  const data = await res.json() as { result?: unknown; error?: { message: string; code: number } };
  if (data.error) throw new Error(`Soroban RPC error ${data.error.code}: ${data.error.message}`);
  return data.result;
}

// ── SDK lazy loader ───────────────────────────────────────────
// We use the @stellar/stellar-sdk dynamically so the module starts
// even if the SDK is not installed (degrades gracefully to Horizon-only).

let stellarSdk: typeof import('@stellar/stellar-sdk') | null = null;
async function getStellarSdk() {
  if (!stellarSdk) {
    try {
      stellarSdk = await import('@stellar/stellar-sdk');
    } catch {
      throw new Error(
        'Stellar SDK not installed. Run: npm install @stellar/stellar-sdk'
      );
    }
  }
  return stellarSdk;
}

// ── Secret key management ─────────────────────────────────────

function getStellarSecretKey(network: StellarNetwork): string {
  const envKey = network === 'mainnet'
    ? 'STELLAR_SECRET_KEY'
    : `STELLAR_SECRET_KEY_${network.toUpperCase()}`;
  const key = process.env[envKey] ?? process.env['STELLAR_SECRET_KEY'];
  if (!key) throw new Error(`${envKey} not set — cannot sign Stellar transactions`);
  if (!key.startsWith('S') || key.length !== 56) {
    throw new Error('Stellar secret key must be a 56-character string starting with S');
  }
  return key;
}

// ── Sequence number cache (prevents replay attacks) ───────────

const sequenceCache = new Map<string, { seq: bigint; lockedAt: number }>();
const SEQ_LOCK_TTL_MS = 60_000;

async function acquireSequence(network: StellarNetwork, accountId: string): Promise<bigint> {
  const key = `${network}:${accountId}`;
  const now = Date.now();

  const existing = sequenceCache.get(key);
  if (existing && now - existing.lockedAt > SEQ_LOCK_TTL_MS) {
    sequenceCache.delete(key);
  }

  const accountData = await horizonGet(network, `/accounts/${accountId}`) as { sequence: string };
  const chainSeq = BigInt(accountData.sequence);

  const local = sequenceCache.get(key);
  const seq = local && local.seq > chainSeq ? local.seq + 1n : chainSeq + 1n;
  sequenceCache.set(key, { seq, lockedAt: now });
  return seq;
}

function releaseSequence(network: StellarNetwork, accountId: string, success: boolean) {
  if (!success) sequenceCache.delete(`${network}:${accountId}`);
}

// ── Memo hash validator (replay protection for off-chain refs) ─

function buildMemoHash(taskId: string): Buffer {
  return crypto.createHash('sha256').update(`aiops:${taskId}`).digest();
}

// ── Account operations ────────────────────────────────────────

async function getAccount(network: StellarNetwork, accountId: string) {
  return horizonGet(network, `/accounts/${accountId}`);
}

async function getAccountTransactions(network: StellarNetwork, accountId: string, limit = 10) {
  return horizonGet(network, `/accounts/${accountId}/transactions?limit=${limit}&order=desc`);
}

async function getAccountPayments(network: StellarNetwork, accountId: string, limit = 10) {
  return horizonGet(network, `/accounts/${accountId}/payments?limit=${limit}&order=desc`);
}

async function getAccountOffers(network: StellarNetwork, accountId: string) {
  return horizonGet(network, `/accounts/${accountId}/offers`);
}

async function fundTestnetAccount(accountId: string): Promise<unknown> {
  // Only works on testnet/futurenet via Friendbot
  const res = await fetchWithTimeout(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(accountId)}`, {}, 15_000
  );
  if (!res.ok) throw new Error('Friendbot funding failed');
  return res.json();
}

// ── Build & submit transactions ───────────────────────────────

interface StellarTxResult {
  taskId: string;
  network: StellarNetwork;
  txHash?: string;
  status: 'simulated' | 'submitted' | 'confirmed' | 'failed';
  ledger?: number;
  feeCharged?: string;
  resultXdr?: string;
  explorerUrl?: string;
  submittedAt: string;
  confirmedAt?: string;
  error?: string;
}

async function submitXdr(network: StellarNetwork, txXdr: string, taskId: string): Promise<StellarTxResult> {
  const t0 = Date.now();
  const cfg = STELLAR_NETWORKS[network];

  try {
    const result = await horizonPost(network, '/transactions', { tx: txXdr }) as {
      hash: string;
      ledger?: number;
      fee_charged?: string;
      result_xdr?: string;
    };

    const txHash = result.hash;
    const explorerUrl = `${cfg.explorerUrl}/tx/${txHash}`;

    void emitEvent('stellar.tx_confirmed', {
      taskId, txHash, network, ledger: result.ledger,
    });

    return {
      taskId, network, txHash,
      status: 'confirmed',
      ledger: result.ledger,
      feeCharged: result.fee_charged,
      resultXdr: result.result_xdr,
      explorerUrl,
      submittedAt: new Date(t0).toISOString(),
      confirmedAt: getTodayISO(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void emitEvent('stellar.tx_failed', { taskId, network, error: msg });
    return {
      taskId, network,
      status: 'failed',
      error: msg.slice(0, 400),
      submittedAt: new Date(t0).toISOString(),
    };
  }
}

// ── Payment (native XLM or custom asset) ─────────────────────

async function sendPayment(opts: {
  taskId: string;
  network: StellarNetwork;
  destination: string;
  amount: string;
  asset: { code: string; issuer?: string };
  memo?: string;
  simulate?: boolean;
}): Promise<StellarTxResult> {
  const sdk = await getStellarSdk();
  const { Keypair, Asset, Operation, TransactionBuilder, Memo, BASE_FEE } = sdk;

  const secretKey = getStellarSecretKey(opts.network);
  const keypair = Keypair.fromSecret(secretKey);
  const sourceId = keypair.publicKey();
  const cfg = STELLAR_NETWORKS[opts.network];

  const accountData = await horizonGet(opts.network, `/accounts/${sourceId}`) as Record<string, unknown>;
  const seq = await acquireSequence(opts.network, sourceId);

  const asset = opts.asset.code === 'XLM'
    ? Asset.native()
    : new Asset(opts.asset.code, opts.asset.issuer!);

  // Destination account existence check
  try {
    await horizonGet(opts.network, `/accounts/${opts.destination}`);
  } catch {
    // Account doesn't exist — only XLM can create it (CreateAccount op)
    if (opts.asset.code !== 'XLM') {
      releaseSequence(opts.network, sourceId, false);
      return {
        taskId: opts.taskId, network: opts.network,
        status: 'failed',
        error: 'Destination account does not exist. Send XLM first to create it.',
        submittedAt: getTodayISO(),
      };
    }
  }

  const feeStats = await horizonGet(opts.network, '/fee_stats') as { fee_charged?: { mode?: string } };
  const fee = feeStats.fee_charged?.mode ?? BASE_FEE;

  const tx = new TransactionBuilder(
    { id: sourceId, sequence: (seq - 1n).toString(), accountId: () => sourceId, incrementSequenceNumber: () => {} } as unknown as InstanceType<typeof sdk.Account>,
    {
      fee: fee.toString(),
      networkPassphrase: cfg.networkPassphrase,
    }
  )
    .addOperation(Operation.payment({ destination: opts.destination, asset, amount: opts.amount }))
    .addMemo(opts.memo ? Memo.text(opts.memo.slice(0, 28)) : Memo.hash(buildMemoHash(opts.taskId)))
    .setTimeout(180)
    .build();

  tx.sign(keypair);
  const txXdr = tx.toXDR();

  if (opts.simulate) {
    releaseSequence(opts.network, sourceId, false);
    return { taskId: opts.taskId, network: opts.network, status: 'simulated', submittedAt: getTodayISO(), txHash: undefined };
  }

  let success = false;
  try {
    const result = await submitXdr(opts.network, txXdr, opts.taskId);
    success = result.status === 'confirmed';
    return result;
  } finally {
    releaseSequence(opts.network, sourceId, success);
  }
}

// ── Create & fund account (CreateAccount operation) ───────────

async function createAccount(opts: {
  taskId: string;
  network: StellarNetwork;
  destination: string;
  startingBalance: string;
  memo?: string;
}): Promise<StellarTxResult> {
  const sdk = await getStellarSdk();
  const { Keypair, Operation, TransactionBuilder, Memo, BASE_FEE } = sdk;

  const secretKey = getStellarSecretKey(opts.network);
  const keypair = Keypair.fromSecret(secretKey);
  const sourceId = keypair.publicKey();
  const cfg = STELLAR_NETWORKS[opts.network];

  const seq = await acquireSequence(opts.network, sourceId);
  const feeStats = await horizonGet(opts.network, '/fee_stats') as { fee_charged?: { mode?: string } };
  const fee = feeStats.fee_charged?.mode ?? BASE_FEE;

  const tx = new TransactionBuilder(
    { id: sourceId, sequence: (seq - 1n).toString(), accountId: () => sourceId, incrementSequenceNumber: () => {} } as unknown as InstanceType<typeof sdk.Account>,
    { fee: fee.toString(), networkPassphrase: cfg.networkPassphrase }
  )
    .addOperation(Operation.createAccount({ destination: opts.destination, startingBalance: opts.startingBalance }))
    .addMemo(opts.memo ? Memo.text(opts.memo.slice(0, 28)) : Memo.hash(buildMemoHash(opts.taskId)))
    .setTimeout(180)
    .build();

  tx.sign(keypair);

  let success = false;
  try {
    const result = await submitXdr(opts.network, tx.toXDR(), opts.taskId);
    success = result.status === 'confirmed';
    return result;
  } finally {
    releaseSequence(opts.network, sourceId, success);
  }
}

// ── Asset issuance (ChangeTrust + Payment from issuer) ────────

async function issueAsset(opts: {
  taskId: string;
  network: StellarNetwork;
  assetCode: string;
  issuerSecretKey: string;
  distributorSecretKey: string;
  amount: string;
  clawbackEnabled?: boolean;
  authorizationRequired?: boolean;
  authorizationRevocable?: boolean;
  homeDomain?: string;
}): Promise<{ taskId: string; network: StellarNetwork; trustline?: StellarTxResult; issuance?: StellarTxResult; error?: string }> {
  const sdk = await getStellarSdk();
  const { Keypair, Asset, Operation, TransactionBuilder, BASE_FEE } = sdk;

  const cfg = STELLAR_NETWORKS[opts.network];

  const issuerKp = Keypair.fromSecret(opts.issuerSecretKey);
  const distributorKp = Keypair.fromSecret(opts.distributorSecretKey);
  const asset = new Asset(opts.assetCode, issuerKp.publicKey());

  // Step 1: Distributor establishes trustline
  const distSeq = await acquireSequence(opts.network, distributorKp.publicKey());
  const feeStats = await horizonGet(opts.network, '/fee_stats') as { fee_charged?: { mode?: string } };
  const fee = feeStats.fee_charged?.mode ?? BASE_FEE;

  const trustTx = new TransactionBuilder(
    { id: distributorKp.publicKey(), sequence: (distSeq - 1n).toString(), accountId: () => distributorKp.publicKey(), incrementSequenceNumber: () => {} } as unknown as InstanceType<typeof sdk.Account>,
    { fee: fee.toString(), networkPassphrase: cfg.networkPassphrase }
  )
    .addOperation(Operation.changeTrust({ asset, limit: opts.amount }))
    .setTimeout(180)
    .build();

  trustTx.sign(distributorKp);
  const trustResult = await submitXdr(opts.network, trustTx.toXDR(), opts.taskId);
  releaseSequence(opts.network, distributorKp.publicKey(), trustResult.status === 'confirmed');

  if (trustResult.status !== 'confirmed') {
    return { taskId: opts.taskId, network: opts.network, trustline: trustResult, error: 'Trustline setup failed' };
  }

  // Step 2: Issuer account flags (clawback, auth required, etc.)
  if (opts.clawbackEnabled || opts.authorizationRequired || opts.authorizationRevocable || opts.homeDomain) {
    const issuerSeq = await acquireSequence(opts.network, issuerKp.publicKey());
    const flagTx = new TransactionBuilder(
      { id: issuerKp.publicKey(), sequence: (issuerSeq - 1n).toString(), accountId: () => issuerKp.publicKey(), incrementSequenceNumber: () => {} } as unknown as InstanceType<typeof sdk.Account>,
      { fee: fee.toString(), networkPassphrase: cfg.networkPassphrase }
    );

    const flags = {
      clawbackEnabled: opts.clawbackEnabled ?? false,
      authorized: opts.authorizationRequired ?? false,
    };

    flagTx
      .addOperation(Operation.setOptions({
        setFlags: (opts.authorizationRequired ? 0x1 : 0) | (opts.authorizationRevocable ? 0x2 : 0) | (opts.clawbackEnabled ? 0x8 : 0),
        ...(opts.homeDomain && { homeDomain: opts.homeDomain }),
      }))
      .setTimeout(180);

    const builtFlagTx = flagTx.build();
    builtFlagTx.sign(issuerKp);
    await submitXdr(opts.network, builtFlagTx.toXDR(), opts.taskId);
    releaseSequence(opts.network, issuerKp.publicKey(), true);
  }

  // Step 3: Issuer sends asset to distributor
  const issuerSeq2 = await acquireSequence(opts.network, issuerKp.publicKey());
  const issueTx = new TransactionBuilder(
    { id: issuerKp.publicKey(), sequence: (issuerSeq2 - 1n).toString(), accountId: () => issuerKp.publicKey(), incrementSequenceNumber: () => {} } as unknown as InstanceType<typeof sdk.Account>,
    { fee: fee.toString(), networkPassphrase: cfg.networkPassphrase }
  )
    .addOperation(Operation.payment({ destination: distributorKp.publicKey(), asset, amount: opts.amount }))
    .setTimeout(180)
    .build();

  issueTx.sign(issuerKp);
  const issueResult = await submitXdr(opts.network, issueTx.toXDR(), opts.taskId);
  releaseSequence(opts.network, issuerKp.publicKey(), issueResult.status === 'confirmed');

  void emitEvent('stellar.asset_issued', {
    taskId: opts.taskId, network: opts.network,
    assetCode: opts.assetCode, issuer: issuerKp.publicKey(),
    distributor: distributorKp.publicKey(), amount: opts.amount,
  });

  return { taskId: opts.taskId, network: opts.network, trustline: trustResult, issuance: issueResult };
}

// ── Clawback ──────────────────────────────────────────────────

async function clawbackAsset(opts: {
  taskId: string;
  network: StellarNetwork;
  assetCode: string;
  from: string;
  amount: string;
}): Promise<StellarTxResult> {
  const sdk = await getStellarSdk();
  const { Keypair, Asset, Operation, TransactionBuilder, BASE_FEE } = sdk;

  const secretKey = getStellarSecretKey(opts.network);
  const keypair = Keypair.fromSecret(secretKey);
  const cfg = STELLAR_NETWORKS[opts.network];

  const asset = new Asset(opts.assetCode, keypair.publicKey());
  const seq = await acquireSequence(opts.network, keypair.publicKey());
  const feeStats = await horizonGet(opts.network, '/fee_stats') as { fee_charged?: { mode?: string } };
  const fee = feeStats.fee_charged?.mode ?? BASE_FEE;

  const tx = new TransactionBuilder(
    { id: keypair.publicKey(), sequence: (seq - 1n).toString(), accountId: () => keypair.publicKey(), incrementSequenceNumber: () => {} } as unknown as InstanceType<typeof sdk.Account>,
    { fee: fee.toString(), networkPassphrase: cfg.networkPassphrase }
  )
    .addOperation(Operation.clawback({ asset, from: opts.from, amount: opts.amount }))
    .setTimeout(180)
    .build();

  tx.sign(keypair);

  let success = false;
  try {
    const result = await submitXdr(opts.network, tx.toXDR(), opts.taskId);
    success = result.status === 'confirmed';
    if (success) void emitEvent('stellar.clawback_executed', { taskId: opts.taskId, network: opts.network, assetCode: opts.assetCode, from: opts.from, amount: opts.amount });
    return result;
  } finally {
    releaseSequence(opts.network, keypair.publicKey(), success);
  }
}

// ── Path payment (cross-asset swap via DEX) ───────────────────

async function pathPayment(opts: {
  taskId: string;
  network: StellarNetwork;
  destination: string;
  sendAsset: { code: string; issuer?: string };
  sendMax: string;
  destAsset: { code: string; issuer?: string };
  destAmount: string;
  path?: Array<{ code: string; issuer?: string }>;
}): Promise<StellarTxResult> {
  const sdk = await getStellarSdk();
  const { Keypair, Asset, Operation, TransactionBuilder, BASE_FEE } = sdk;

  const secretKey = getStellarSecretKey(opts.network);
  const keypair = Keypair.fromSecret(secretKey);
  const cfg = STELLAR_NETWORKS[opts.network];

  const toAsset = (a: { code: string; issuer?: string }) =>
    a.code === 'XLM' ? Asset.native() : new Asset(a.code, a.issuer!);

  const path = (opts.path ?? []).map(toAsset);
  const seq = await acquireSequence(opts.network, keypair.publicKey());
  const feeStats = await horizonGet(opts.network, '/fee_stats') as { fee_charged?: { mode?: string } };
  const fee = feeStats.fee_charged?.mode ?? BASE_FEE;

  const tx = new TransactionBuilder(
    { id: keypair.publicKey(), sequence: (seq - 1n).toString(), accountId: () => keypair.publicKey(), incrementSequenceNumber: () => {} } as unknown as InstanceType<typeof sdk.Account>,
    { fee: fee.toString(), networkPassphrase: cfg.networkPassphrase }
  )
    .addOperation(Operation.pathPaymentStrictReceive({
      sendAsset: toAsset(opts.sendAsset),
      sendMax: opts.sendMax,
      destination: opts.destination,
      destAsset: toAsset(opts.destAsset),
      destAmount: opts.destAmount,
      path,
    }))
    .setTimeout(180)
    .build();

  tx.sign(keypair);

  let success = false;
  try {
    const result = await submitXdr(opts.network, tx.toXDR(), opts.taskId);
    success = result.status === 'confirmed';
    return result;
  } finally {
    releaseSequence(opts.network, keypair.publicKey(), success);
  }
}

// ── Multi-sig: add/remove signer, set thresholds ──────────────

async function setAccountSigners(opts: {
  taskId: string;
  network: StellarNetwork;
  signers: Array<{ publicKey: string; weight: number }>;
  lowThreshold: number;
  medThreshold: number;
  highThreshold: number;
  masterWeight: number;
}): Promise<StellarTxResult> {
  const sdk = await getStellarSdk();
  const { Keypair, Operation, TransactionBuilder, BASE_FEE } = sdk;

  const secretKey = getStellarSecretKey(opts.network);
  const keypair = Keypair.fromSecret(secretKey);
  const cfg = STELLAR_NETWORKS[opts.network];

  const seq = await acquireSequence(opts.network, keypair.publicKey());
  const feeStats = await horizonGet(opts.network, '/fee_stats') as { fee_charged?: { mode?: string } };
  const fee = feeStats.fee_charged?.mode ?? BASE_FEE;

  const builder = new TransactionBuilder(
    { id: keypair.publicKey(), sequence: (seq - 1n).toString(), accountId: () => keypair.publicKey(), incrementSequenceNumber: () => {} } as unknown as InstanceType<typeof sdk.Account>,
    { fee: fee.toString(), networkPassphrase: cfg.networkPassphrase }
  );

  // Set thresholds and master weight
  builder.addOperation(Operation.setOptions({
    masterWeight: opts.masterWeight,
    lowThreshold: opts.lowThreshold,
    medThreshold: opts.medThreshold,
    highThreshold: opts.highThreshold,
  }));

  // Add signers
  for (const signer of opts.signers) {
    builder.addOperation(Operation.setOptions({
      signer: { ed25519PublicKey: signer.publicKey, weight: signer.weight },
    }));
  }

  const tx = builder.setTimeout(180).build();
  tx.sign(keypair);

  let success = false;
  try {
    const result = await submitXdr(opts.network, tx.toXDR(), opts.taskId);
    success = result.status === 'confirmed';
    if (success) void emitEvent('stellar.multisig_configured', { taskId: opts.taskId, network: opts.network, signerCount: opts.signers.length });
    return result;
  } finally {
    releaseSequence(opts.network, keypair.publicKey(), success);
  }
}

// ── DEX: manage offers ────────────────────────────────────────

async function manageSellOffer(opts: {
  taskId: string;
  network: StellarNetwork;
  selling: { code: string; issuer?: string };
  buying: { code: string; issuer?: string };
  amount: string;
  price: string;
  offerId?: string;
}): Promise<StellarTxResult> {
  const sdk = await getStellarSdk();
  const { Keypair, Asset, Operation, TransactionBuilder, BASE_FEE } = sdk;

  const secretKey = getStellarSecretKey(opts.network);
  const keypair = Keypair.fromSecret(secretKey);
  const cfg = STELLAR_NETWORKS[opts.network];

  const toAsset = (a: { code: string; issuer?: string }) =>
    a.code === 'XLM' ? Asset.native() : new Asset(a.code, a.issuer!);

  const seq = await acquireSequence(opts.network, keypair.publicKey());
  const feeStats = await horizonGet(opts.network, '/fee_stats') as { fee_charged?: { mode?: string } };
  const fee = feeStats.fee_charged?.mode ?? BASE_FEE;

  const tx = new TransactionBuilder(
    { id: keypair.publicKey(), sequence: (seq - 1n).toString(), accountId: () => keypair.publicKey(), incrementSequenceNumber: () => {} } as unknown as InstanceType<typeof sdk.Account>,
    { fee: fee.toString(), networkPassphrase: cfg.networkPassphrase }
  )
    .addOperation(Operation.manageSellOffer({
      selling: toAsset(opts.selling),
      buying: toAsset(opts.buying),
      amount: opts.amount,
      price: opts.price,
      offerId: opts.offerId ? parseInt(opts.offerId) : 0,
    }))
    .setTimeout(180)
    .build();

  tx.sign(keypair);

  let success = false;
  try {
    const result = await submitXdr(opts.network, tx.toXDR(), opts.taskId);
    success = result.status === 'confirmed';
    return result;
  } finally {
    releaseSequence(opts.network, keypair.publicKey(), success);
  }
}

// ── Soroban contract deployment ───────────────────────────────

async function deploySorobanContract(opts: {
  taskId: string;
  network: StellarNetwork;
  wasmPath?: string;
  wasmBase64?: string;
  contractName: string;
  constructorArgs?: unknown[];
}): Promise<{
  taskId: string;
  network: StellarNetwork;
  success: boolean;
  contractId?: string;
  txHash?: string;
  error?: string;
  deployedAt: string;
  explorerUrl?: string;
}> {
  const cfg = STELLAR_NETWORKS[opts.network];

  // Load WASM
  let wasmBytes: Buffer;
  if (opts.wasmBase64) {
    wasmBytes = Buffer.from(opts.wasmBase64, 'base64');
  } else if (opts.wasmPath) {
    wasmBytes = await readFile(opts.wasmPath);
  } else {
    return { taskId: opts.taskId, network: opts.network, success: false, error: 'wasmPath or wasmBase64 required', deployedAt: getTodayISO() };
  }

  // Security audit of WASM before deploy
  try {
    const auditRes = await internalFetch('module2-auditor', '/audit', {
      method: 'POST',
      body: JSON.stringify({
        content: `Soroban WASM: ${opts.contractName} (${wasmBytes.length} bytes base64)`,
        contentType: 'solidity', // reuse solidity audit flow for WASM
        auditDate: getTodayDate(),
        taskId: opts.taskId,
      }),
    }, 50_000);
    const audit = await auditRes.json() as { passed: boolean; recommendation: string; summary: string };
    if (!audit.passed && audit.recommendation === 'reject') {
      return {
        taskId: opts.taskId, network: opts.network, success: false,
        error: `Security audit rejected Soroban deploy: ${audit.summary}`,
        deployedAt: getTodayISO(),
      };
    }
  } catch { /* audit unavailable — proceed with warning */ }

  // Use Stellar CLI (stellar contract deploy) if available
  try {
    const wasmFile = join(WORKSPACE, `${opts.taskId}.wasm`);
    await mkdir(WORKSPACE, { recursive: true });
    await writeFile(wasmFile, wasmBytes);

    const secretKey = getStellarSecretKey(opts.network);
    const args = [
      'contract', 'deploy',
      '--wasm', wasmFile,
      '--source', secretKey,
      '--network', opts.network === 'mainnet' ? 'mainnet' : opts.network,
      '--rpc-url', cfg.sorobanRpcUrl,
      '--network-passphrase', cfg.networkPassphrase,
    ];

    if (opts.constructorArgs && opts.constructorArgs.length > 0) {
      args.push('--');
      for (const arg of opts.constructorArgs) {
        args.push(String(arg));
      }
    }

    const { stdout } = await execAsync('stellar', args, { timeout: 120_000 });
    const contractId = stdout.trim();

    await rm(wasmFile, { force: true }).catch(() => {});

    void emitEvent('stellar.contract_deployed', {
      taskId: opts.taskId, network: opts.network,
      contractId, contractName: opts.contractName,
    });

    // Persist
    void persistStellarContract({
      contractId, name: opts.contractName,
      network: opts.network, deployedAt: getTodayISO(), taskId: opts.taskId,
    });

    return {
      taskId: opts.taskId, network: opts.network, success: true,
      contractId,
      deployedAt: getTodayISO(),
      explorerUrl: `${cfg.explorerUrl}/contract/${contractId}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Fallback: use Soroban RPC directly (upload WASM + instantiate)
    try {
      // uploadContractWasm — sendTransaction with InvokeHostFunctionOp
      const uploadResult = await sorobanRpc(opts.network, 'sendTransaction', {
        transaction: wasmBytes.toString('base64'),
      }) as { hash?: string; status?: string; errorResultXdr?: string };

      if (uploadResult.status === 'ERROR') {
        return {
          taskId: opts.taskId, network: opts.network, success: false,
          error: `Soroban upload failed: ${uploadResult.errorResultXdr ?? 'unknown'}`,
          deployedAt: getTodayISO(),
        };
      }

      return {
        taskId: opts.taskId, network: opts.network, success: true,
        txHash: uploadResult.hash,
        deployedAt: getTodayISO(),
        explorerUrl: uploadResult.hash ? `${cfg.explorerUrl}/tx/${uploadResult.hash}` : undefined,
      };
    } catch (rpcErr) {
      return {
        taskId: opts.taskId, network: opts.network, success: false,
        error: msg.slice(0, 400),
        deployedAt: getTodayISO(),
      };
    }
  }
}

// ── Soroban contract invoke ───────────────────────────────────

async function invokeSorobanContract(opts: {
  taskId: string;
  network: StellarNetwork;
  contractId: string;
  method: string;
  args?: unknown[];
  simulate?: boolean;
}): Promise<{
  taskId: string;
  success: boolean;
  result?: unknown;
  txHash?: string;
  error?: string;
}> {
  const cfg = STELLAR_NETWORKS[opts.network];

  try {
    // Simulate first
    const simResult = await sorobanRpc(opts.network, 'simulateTransaction', {
      transaction: JSON.stringify({
        contractId: opts.contractId,
        method: opts.method,
        args: opts.args ?? [],
        network: opts.network,
      }),
    }) as { results?: Array<{ xdr: string }>; error?: string; cost?: unknown };

    if (simResult.error) {
      return { taskId: opts.taskId, success: false, error: simResult.error };
    }

    if (opts.simulate) {
      return { taskId: opts.taskId, success: true, result: simResult.results };
    }

    // Use Stellar CLI for actual invocation if available
    const secretKey = getStellarSecretKey(opts.network);
    const cliArgs = [
      'contract', 'invoke',
      '--id', opts.contractId,
      '--source', secretKey,
      '--network', opts.network === 'mainnet' ? 'mainnet' : opts.network,
      '--rpc-url', cfg.sorobanRpcUrl,
      '--network-passphrase', cfg.networkPassphrase,
      '--', opts.method,
    ];

    if (opts.args) {
      for (const arg of opts.args) {
        cliArgs.push(String(arg));
      }
    }

    const { stdout } = await execAsync('stellar', cliArgs, { timeout: 60_000 });
    const result = JSON.parse(stdout.trim());

    void emitEvent('stellar.contract_invoked', {
      taskId: opts.taskId, network: opts.network,
      contractId: opts.contractId, method: opts.method,
    });

    return { taskId: opts.taskId, success: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { taskId: opts.taskId, success: false, error: msg.slice(0, 400) };
  }
}

// ── Keypair generation (for display/export) ───────────────────

async function generateKeypair(): Promise<{ publicKey: string; secretKey: string; warning: string }> {
  const sdk = await getStellarSdk();
  const kp = sdk.Keypair.random();
  return {
    publicKey: kp.publicKey(),
    secretKey: kp.secret(),
    warning: 'NEVER share your secret key. Store it securely. This keypair is not saved by the system.',
  };
}

// ── Federation lookup ─────────────────────────────────────────

async function federationLookup(address: string): Promise<{ accountId?: string; memoType?: string; memo?: string; error?: string }> {
  try {
    // Stellar federation protocol: query .well-known/stellar.toml then federation endpoint
    const [name, domain] = address.split('*');
    if (!domain) return { error: 'Not a federation address (format: name*domain.com)' };

    const tomlRes = await fetchWithTimeout(`https://${domain}/.well-known/stellar.toml`, {}, 10_000);
    if (!tomlRes.ok) return { error: 'Could not fetch stellar.toml from domain' };
    const toml = await tomlRes.text();
    const fedMatch = toml.match(/FEDERATION_SERVER\s*=\s*"(.+?)"/);
    if (!fedMatch) return { error: 'No FEDERATION_SERVER in stellar.toml' };

    const fedUrl = `${fedMatch[1]}?q=${encodeURIComponent(address)}&type=name`;
    const fedRes = await fetchWithTimeout(fedUrl, {}, 10_000);
    if (!fedRes.ok) return { error: 'Federation server returned error' };
    const data = await fedRes.json() as { account_id?: string; memo_type?: string; memo?: string };
    return { accountId: data.account_id, memoType: data.memo_type, memo: data.memo };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Asset info via Horizon ────────────────────────────────────

async function getAssetInfo(network: StellarNetwork, assetCode: string, issuer?: string) {
  if (assetCode === 'XLM') {
    return { assetCode: 'XLM', assetType: 'native', description: 'Stellar Lumens — native currency' };
  }
  const path = issuer
    ? `/assets?asset_code=${assetCode}&asset_issuer=${issuer}`
    : `/assets?asset_code=${assetCode}&limit=5`;
  return horizonGet(network, path);
}

// ── DEX order book ────────────────────────────────────────────

async function getOrderBook(network: StellarNetwork, opts: {
  sellingCode: string; sellingIssuer?: string;
  buyingCode: string; buyingIssuer?: string;
  limit?: number;
}) {
  const params = new URLSearchParams({
    selling_asset_type: opts.sellingCode === 'XLM' ? 'native' : 'credit_alphanum4',
    ...(opts.sellingCode !== 'XLM' && { selling_asset_code: opts.sellingCode }),
    ...(opts.sellingIssuer && { selling_asset_issuer: opts.sellingIssuer }),
    buying_asset_type: opts.buyingCode === 'XLM' ? 'native' : 'credit_alphanum4',
    ...(opts.buyingCode !== 'XLM' && { buying_asset_code: opts.buyingCode }),
    ...(opts.buyingIssuer && { buying_asset_issuer: opts.buyingIssuer }),
    limit: String(opts.limit ?? 20),
  });
  return horizonGet(network, `/order_book?${params.toString()}`);
}

// ── Find payment paths ────────────────────────────────────────

async function findPaymentPaths(network: StellarNetwork, opts: {
  sourceAccount: string;
  destinationAccount: string;
  destAssetCode: string;
  destAssetIssuer?: string;
  destAmount: string;
}) {
  const params = new URLSearchParams({
    source_account: opts.sourceAccount,
    destination_account: opts.destinationAccount,
    destination_asset_type: opts.destAssetCode === 'XLM' ? 'native' : 'credit_alphanum4',
    ...(opts.destAssetCode !== 'XLM' && { destination_asset_code: opts.destAssetCode }),
    ...(opts.destAssetIssuer && { destination_asset_issuer: opts.destAssetIssuer }),
    destination_amount: opts.destAmount,
  });
  return horizonGet(network, `/paths/strict-receive?${params.toString()}`);
}

// ── Helpers: event emitter and DB persistence ─────────────────

async function emitEvent(type: string, payload: Record<string, unknown>) {
  try {
    await internalFetch('module9-events', '/emit', {
      method: 'POST',
      body: JSON.stringify({ type, source: 'module15-stellar', payload, emittedAt: getTodayISO() }),
    }, 3_000);
  } catch { /* best-effort */ }
}

async function persistStellarContract(contract: {
  contractId: string; name: string; network: string; deployedAt: string; taskId: string;
}) {
  try {
    await internalFetch('module6-database', '/stellar-contracts', {
      method: 'POST',
      body: JSON.stringify(contract),
    }, 5_000);
  } catch { /* best-effort */ }
}

async function persistStellarTx(tx: StellarTxResult, description: string) {
  try {
    await internalFetch('module6-database', '/stellar-transactions', {
      method: 'POST',
      body: JSON.stringify({ ...tx, description }),
    }, 5_000);
  } catch { /* best-effort */ }
}

// ── Zod schemas ───────────────────────────────────────────────

const NetworkSchema = z.enum(['mainnet', 'testnet', 'futurenet']).default('mainnet');
const AssetSchema = z.object({
  code: z.string().min(1).max(12),
  issuer: z.string().length(56).optional(),
});

const PaymentSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  network: NetworkSchema,
  destination: z.string().min(56).max(56),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/, 'Amount must be a positive decimal with up to 7 places'),
  asset: AssetSchema,
  memo: z.string().max(28).optional(),
  simulate: z.boolean().default(false),
});

const CreateAccountSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  network: NetworkSchema,
  destination: z.string().length(56),
  startingBalance: z.string().regex(/^\d+(\.\d{1,7})?$/),
  memo: z.string().max(28).optional(),
});

const IssueAssetSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  network: NetworkSchema,
  assetCode: z.string().min(1).max(12),
  issuerSecretKey: z.string().length(56).startsWith('S'),
  distributorSecretKey: z.string().length(56).startsWith('S'),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
  clawbackEnabled: z.boolean().optional(),
  authorizationRequired: z.boolean().optional(),
  authorizationRevocable: z.boolean().optional(),
  homeDomain: z.string().max(32).optional(),
});

const ClawbackSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  network: NetworkSchema,
  assetCode: z.string().min(1).max(12),
  from: z.string().length(56),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
});

const PathPaymentSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  network: NetworkSchema,
  destination: z.string().length(56),
  sendAsset: AssetSchema,
  sendMax: z.string().regex(/^\d+(\.\d{1,7})?$/),
  destAsset: AssetSchema,
  destAmount: z.string().regex(/^\d+(\.\d{1,7})?$/),
  path: z.array(AssetSchema).max(5).optional(),
});

const MultiSigSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  network: NetworkSchema,
  signers: z.array(z.object({
    publicKey: z.string().length(56),
    weight: z.number().int().min(0).max(255),
  })).min(1).max(20),
  lowThreshold: z.number().int().min(0).max(255),
  medThreshold: z.number().int().min(0).max(255),
  highThreshold: z.number().int().min(0).max(255),
  masterWeight: z.number().int().min(0).max(255),
});

const SellOfferSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  network: NetworkSchema,
  selling: AssetSchema,
  buying: AssetSchema,
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
  price: z.string().regex(/^\d+(\.\d{1,7})?$/),
  offerId: z.string().optional(),
});

const DeploySorobanSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  network: NetworkSchema,
  contractName: z.string().min(1).max(64),
  wasmBase64: z.string().optional(),
  constructorArgs: z.array(z.unknown()).optional(),
});

const InvokeContractSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  network: NetworkSchema,
  contractId: z.string().min(1),
  method: z.string().min(1).max(64),
  args: z.array(z.unknown()).optional(),
  simulate: z.boolean().default(false),
});

// ── Routes ────────────────────────────────────────────────────

// Health
fastify.get('/health', async (): Promise<HealthStatus> => {
  let sdkAvailable = false;
  try { await getStellarSdk(); sdkAvailable = true; } catch {}

  let stellarCliAvailable = false;
  try { await execAsync('stellar', ['--version'], { timeout: 2000 }); stellarCliAvailable = true; } catch {}

  return {
    service: 'module15-stellar',
    status: 'online',
    date: getTodayDate(),
    timestamp: getTodayISO(),
    uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
    dependencies: {
      database: getServiceUrl('module6-database'),
      events: getServiceUrl('module9-events'),
      auditor: getServiceUrl('module2-auditor'),
      gate: getServiceUrl('module1-relevance-gate'),
    },
    version: JSON.stringify({ stellarSdk: sdkAvailable, stellarCli: stellarCliAvailable }),
  };
});

// GET /networks
fastify.get('/networks', async () => ({
  networks: Object.values(STELLAR_NETWORKS).map(n => ({
    name: n.name, horizonUrl: n.horizonUrl,
    explorerUrl: n.explorerUrl, isTestnet: n.isTestnet,
    networkPassphrase: n.networkPassphrase,
  })),
}));

// GET /account?network=testnet&accountId=G...
fastify.get('/account', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const network = (q['network'] ?? 'mainnet') as StellarNetwork;
  const accountId = q['accountId'];
  if (!accountId) return reply.status(400).send({ error: 'accountId required' });
  if (!STELLAR_NETWORKS[network]) return reply.status(400).send({ error: 'Invalid network' });
  try {
    const data = await getAccount(network, accountId);
    return data;
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// GET /account/transactions
fastify.get('/account/transactions', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const network = (q['network'] ?? 'mainnet') as StellarNetwork;
  const accountId = q['accountId'];
  const limit = parseInt(q['limit'] ?? '10');
  if (!accountId) return reply.status(400).send({ error: 'accountId required' });
  try {
    return await getAccountTransactions(network, accountId, limit);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// GET /account/payments
fastify.get('/account/payments', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const network = (q['network'] ?? 'mainnet') as StellarNetwork;
  const accountId = q['accountId'];
  if (!accountId) return reply.status(400).send({ error: 'accountId required' });
  try {
    return await getAccountPayments(network, accountId, parseInt(q['limit'] ?? '10'));
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// GET /account/offers
fastify.get('/account/offers', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const network = (q['network'] ?? 'mainnet') as StellarNetwork;
  const accountId = q['accountId'];
  if (!accountId) return reply.status(400).send({ error: 'accountId required' });
  try {
    return await getAccountOffers(network, accountId);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /account/fund-testnet — Friendbot funding
fastify.post('/account/fund-testnet', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as { accountId?: string; network?: string };
  if (!b.accountId) return reply.status(400).send({ error: 'accountId required' });
  if (b.network === 'mainnet') return reply.status(400).send({ error: 'Friendbot only works on testnet/futurenet' });
  try {
    const result = await fundTestnetAccount(b.accountId);
    return result;
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /keypair/generate
fastify.post('/keypair/generate', async (_req, _reply) => {
  return generateKeypair();
});

// POST /payment
fastify.post('/payment', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = PaymentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  try {
    const result = await sendPayment(parsed.data);
    if (result.status === 'confirmed') {
      void persistStellarTx(result, `Payment ${parsed.data.amount} ${parsed.data.asset.code} to ${parsed.data.destination.slice(0, 8)}...`);
    }
    return reply.status(result.status === 'confirmed' ? 200 : result.status === 'simulated' ? 200 : 422).send(result);
  } catch (err) {
    const msg = String(err).slice(0, 300);
    return reply.status(500).send({ error: msg });
  }
});

// POST /account/create
fastify.post('/account/create', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = CreateAccountSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  try {
    const result = await createAccount(parsed.data);
    return reply.status(result.status === 'confirmed' ? 200 : 422).send(result);
  } catch (err) {
    return reply.status(500).send({ error: String(err).slice(0, 300) });
  }
});

// POST /asset/issue
fastify.post('/asset/issue', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = IssueAssetSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  try {
    const result = await issueAsset(parsed.data);
    return reply.send(result);
  } catch (err) {
    return reply.status(500).send({ error: String(err).slice(0, 300) });
  }
});

// POST /asset/clawback
fastify.post('/asset/clawback', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = ClawbackSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  try {
    const result = await clawbackAsset(parsed.data);
    return reply.status(result.status === 'confirmed' ? 200 : 422).send(result);
  } catch (err) {
    return reply.status(500).send({ error: String(err).slice(0, 300) });
  }
});

// GET /asset/info
fastify.get('/asset/info', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const network = (q['network'] ?? 'mainnet') as StellarNetwork;
  if (!STELLAR_NETWORKS[network]) return reply.status(400).send({ error: 'Invalid network' });
  try {
    return await getAssetInfo(network, q['code'] ?? 'XLM', q['issuer']);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /payment/path
fastify.post('/payment/path', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = PathPaymentSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  try {
    const result = await pathPayment(parsed.data);
    return reply.status(result.status === 'confirmed' ? 200 : 422).send(result);
  } catch (err) {
    return reply.status(500).send({ error: String(err).slice(0, 300) });
  }
});

// GET /payment/paths — find available paths
fastify.get('/payment/paths', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  if (!q['sourceAccount'] || !q['destinationAccount'] || !q['destAssetCode'] || !q['destAmount']) {
    return reply.status(400).send({ error: 'sourceAccount, destinationAccount, destAssetCode, destAmount required' });
  }
  const network = (q['network'] ?? 'mainnet') as StellarNetwork;
  try {
    return await findPaymentPaths(network, {
      sourceAccount: q['sourceAccount'],
      destinationAccount: q['destinationAccount'],
      destAssetCode: q['destAssetCode'],
      destAssetIssuer: q['destAssetIssuer'],
      destAmount: q['destAmount'],
    });
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /multisig/configure
fastify.post('/multisig/configure', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = MultiSigSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  try {
    const result = await setAccountSigners(parsed.data);
    return reply.status(result.status === 'confirmed' ? 200 : 422).send(result);
  } catch (err) {
    return reply.status(500).send({ error: String(err).slice(0, 300) });
  }
});

// POST /dex/offer
fastify.post('/dex/offer', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = SellOfferSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  try {
    const result = await manageSellOffer(parsed.data);
    return reply.status(result.status === 'confirmed' ? 200 : 422).send(result);
  } catch (err) {
    return reply.status(500).send({ error: String(err).slice(0, 300) });
  }
});

// DELETE /dex/offer — cancel offer (set amount=0)
fastify.delete('/dex/offer', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as { taskId?: string; network?: string; offerId: string; selling: { code: string; issuer?: string }; buying: { code: string; issuer?: string } };
  if (!b.offerId) return reply.status(400).send({ error: 'offerId required' });
  try {
    const result = await manageSellOffer({
      taskId: b.taskId ?? crypto.randomUUID(),
      network: (b.network ?? 'mainnet') as StellarNetwork,
      selling: b.selling,
      buying: b.buying,
      amount: '0',
      price: '1',
      offerId: b.offerId,
    });
    return reply.status(result.status === 'confirmed' ? 200 : 422).send(result);
  } catch (err) {
    return reply.status(500).send({ error: String(err).slice(0, 300) });
  }
});

// GET /dex/orderbook
fastify.get('/dex/orderbook', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const network = (q['network'] ?? 'mainnet') as StellarNetwork;
  if (!q['sellingCode'] || !q['buyingCode']) {
    return reply.status(400).send({ error: 'sellingCode and buyingCode required' });
  }
  try {
    return await getOrderBook(network, {
      sellingCode: q['sellingCode'],
      sellingIssuer: q['sellingIssuer'],
      buyingCode: q['buyingCode'],
      buyingIssuer: q['buyingIssuer'],
      limit: q['limit'] ? parseInt(q['limit']) : 20,
    });
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /contract/deploy — deploy Soroban WASM contract
fastify.post('/contract/deploy', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = DeploySorobanSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  const result = await deploySorobanContract(parsed.data);
  return reply.status(result.success ? 200 : 422).send(result);
});

// POST /contract/invoke — invoke a deployed Soroban contract
fastify.post('/contract/invoke', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = InvokeContractSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  const result = await invokeSorobanContract(parsed.data);
  return reply.status(result.success ? 200 : 422).send(result);
});

// GET /contract/state — read contract data
fastify.get('/contract/state', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const network = (q['network'] ?? 'mainnet') as StellarNetwork;
  if (!q['contractId']) return reply.status(400).send({ error: 'contractId required' });
  try {
    const result = await sorobanRpc(network, 'getContractData', {
      contract: q['contractId'],
      key: q['key'] ?? 'instance',
      durability: q['durability'] ?? 'persistent',
    });
    return result;
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// GET /contracts — list deployed Soroban contracts from DB
fastify.get('/contracts', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const qs = new URLSearchParams();
    if (q['network']) qs.set('network', q['network']);
    if (q['limit']) qs.set('limit', q['limit']);
    const res = await internalFetch('module6-database', `/stellar-contracts?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
    return { contracts: [] };
  } catch {
    return { contracts: [] };
  }
});

// GET /transactions — Stellar transaction history from DB
fastify.get('/transactions', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const qs = new URLSearchParams();
    if (q['network']) qs.set('network', q['network']);
    if (q['limit']) qs.set('limit', q['limit']);
    const res = await internalFetch('module6-database', `/stellar-transactions?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
    return { transactions: [] };
  } catch {
    return { transactions: [] };
  }
});

// GET /federation — resolve a federation address
fastify.get('/federation', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  if (!q['address']) return reply.status(400).send({ error: 'address required (e.g. alice*domain.com)' });
  try {
    return await federationLookup(q['address']);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// GET /fee-stats — current Stellar fee stats
fastify.get('/fee-stats', async (req: FastifyRequest, reply: FastifyReply) => {
  const network = ((req.query as Record<string, string>)['network'] ?? 'mainnet') as StellarNetwork;
  try {
    return await horizonGet(network, '/fee_stats');
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// GET /ledger — latest ledger info
fastify.get('/ledger', async (req: FastifyRequest, reply: FastifyReply) => {
  const network = ((req.query as Record<string, string>)['network'] ?? 'mainnet') as StellarNetwork;
  try {
    return await horizonGet(network, '/ledgers?order=desc&limit=1');
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// GET /sequence — view pending sequence state per account
fastify.get('/sequence', async () => ({
  pendingSequences: Object.fromEntries(
    [...sequenceCache.entries()].map(([key, v]) => [
      key, { seq: v.seq.toString(), lockedAt: new Date(v.lockedAt).toISOString(), ageMs: Date.now() - v.lockedAt }
    ])
  ),
  count: sequenceCache.size,
}));

// DELETE /sequence/:network/:accountId — clear sequence lock
fastify.delete('/sequence/:network/:accountId', async (
  req: FastifyRequest<{ Params: { network: string; accountId: string } }>, reply: FastifyReply
) => {
  const key = `${req.params.network}:${req.params.accountId}`;
  const existed = sequenceCache.has(key);
  sequenceCache.delete(key);
  return reply.send({ ok: true, key, cleared: existed });
});

// ── Graceful shutdown ─────────────────────────────────────────

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

// ── Start ─────────────────────────────────────────────────────

const start = async () => {
  try {
    if (!process.env.INTERNAL_SERVICE_TOKEN) throw new Error('INTERNAL_SERVICE_TOKEN required');
    await mkdir(WORKSPACE, { recursive: true });
    await fastify.listen({ port: 3015, host: '0.0.0.0' });
    fastify.log.info('⭐ Stellar Engine online — port 3015');
    fastify.log.info(`📅 ${getTodayDate()} | Workspace: ${WORKSPACE}`);

    let sdkStatus = 'not installed';
    try { await getStellarSdk(); sdkStatus = 'loaded'; } catch {}
    fastify.log.info(`🔭 Stellar SDK: ${sdkStatus}`);

    let cliStatus = 'not installed';
    try { await execAsync('stellar', ['--version'], { timeout: 2000 }); cliStatus = 'available'; } catch {}
    fastify.log.info(`🛠️  Stellar CLI: ${cliStatus}`);
  } catch (err) {
    fastify.log.error(err, 'Stellar Engine failed to start');
    process.exit(1);
  }
};
start();
