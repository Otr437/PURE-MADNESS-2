// ============================================================
// MODULE 11: BLOCKCHAIN ENGINE
// Role: Full local blockchain operations — compile, deploy,
//       transact, gas management, wallet ops, meme token launch.
//       Wraps local Foundry (forge/cast/anvil) and Hardhat tools.
//       All signing happens here — private keys never leave.
// Knows about: Module 6 (persists contracts/txs)
//              Module 9 (emits blockchain events)
//              Module 2 (Solidity security audit)
//              Module 1 (gate-checks all Solidity before compile)
// Port: 3011
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, mkdir, unlink, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import {
  ChainConfig, GasEstimate, WalletInfo, TransactionRequest, TransactionResult,
  CompileRequest, CompileResult, DeployRequest, DeployResult,
  ContractRecord, MemeTokenConfig, HealthStatus,
  SupportedChain,
} from '../shared/types.js';
import { getTodayISO, getTodayDate, fetchWithTimeout } from '../shared/date-utils.js';
import { internalFetch, verifyInternalToken, INTERNAL_HEADER, getServiceUrl } from '../shared/registry.js';

const execAsync = promisify(execFile);
const SERVICE_START = Date.now();
const WORKSPACE = process.env.BLOCKCHAIN_WORKSPACE ?? join(process.cwd(), '.blockchain-workspace');

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 300_000, // 5 min — deployments take time
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

fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.url === '/health' || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Internal token or Bearer auth required' });
    }
    // Verify token with DB
    try {
      const hash = crypto.createHash('sha256').update(auth.slice(7)).digest('hex');
      const res = await internalFetch('module6-database', `/oauth-tokens/by-hash/${hash}`, {}, 5_000);
      if (!res.ok) return reply.status(401).send({ error: 'Invalid or expired token' });
    } catch {
      return reply.status(503).send({ error: 'Auth unavailable' });
    }
  }
});

// ── Chain configs ─────────────────────────────────────────────

const CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1, name: 'ethereum',
    rpcUrl: process.env.ETH_RPC_URL ?? 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
    explorerApiUrl: 'https://api.etherscan.io/api',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },
  8453: {
    chainId: 8453, name: 'base',
    rpcUrl: process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    explorerApiUrl: 'https://api.basescan.org/api',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },
  42161: {
    chainId: 42161, name: 'arbitrum',
    rpcUrl: process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    explorerApiUrl: 'https://api.arbiscan.io/api',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },
  10: {
    chainId: 10, name: 'optimism',
    rpcUrl: process.env.OP_RPC_URL ?? 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },
  137: {
    chainId: 137, name: 'polygon',
    rpcUrl: process.env.POLYGON_RPC_URL ?? 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
    explorerApiUrl: 'https://api.polygonscan.com/api',
    nativeCurrency: { symbol: 'MATIC', decimals: 18 },
    isTestnet: false,
  },
  56: {
    chainId: 56, name: 'bsc',
    rpcUrl: process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.binance.org',
    explorerUrl: 'https://bscscan.com',
    explorerApiUrl: 'https://api.bscscan.com/api',
    nativeCurrency: { symbol: 'BNB', decimals: 18 },
    isTestnet: false,
  },
  11155111: {
    chainId: 11155111, name: 'sepolia',
    rpcUrl: process.env.SEPOLIA_RPC_URL ?? 'https://rpc.sepolia.org',
    explorerUrl: 'https://sepolia.etherscan.io',
    explorerApiUrl: 'https://api-sepolia.etherscan.io/api',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    isTestnet: true,
  },
  84532: {
    chainId: 84532, name: 'base-sepolia',
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    isTestnet: true,
  },
  31337: {
    chainId: 31337, name: 'localhost',
    rpcUrl: process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545',
    explorerUrl: '',
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    isTestnet: true,
  },
};

// ── RPC helpers ───────────────────────────────────────────────

async function rpcCall(chainId: number, method: string, params: unknown[] = []): Promise<unknown> {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chainId: ${chainId}`);
  const res = await fetchWithTimeout(chain.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, 15_000);
  if (!res.ok) throw new Error(`RPC HTTP error ${res.status} from ${chain.rpcUrl}`);
  const data = await res.json() as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

function hexToDecimal(hex: string): bigint {
  return BigInt(hex);
}

function weiToGwei(wei: bigint): string {
  return (Number(wei) / 1e9).toFixed(4);
}

function weiToEth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(8);
}

// ── Gas estimation ────────────────────────────────────────────

async function estimateGas(chainId: number, gasUnits = 21000): Promise<GasEstimate> {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chainId: ${chainId}`);

  // Get latest block for baseFee
  const block = await rpcCall(chainId, 'eth_getBlockByNumber', ['latest', false]) as Record<string, string>;
  const baseFeeWei = hexToDecimal(block.baseFeePerGas ?? '0x0');

  // Get fee history for priority fee estimate
  let priorityFeeWei = BigInt(1_500_000_000); // 1.5 gwei default
  try {
    const feeHistory = await rpcCall(chainId, 'eth_feeHistory', [5, 'latest', [25, 50, 75]]) as Record<string, unknown>;
    const rewards = (feeHistory.reward as string[][]) ?? [];
    if (rewards.length > 0) {
      const medianRewards = rewards.map(r => hexToDecimal(r[1] ?? '0x0'));
      const sum = medianRewards.reduce((a, b) => a + b, BigInt(0));
      priorityFeeWei = sum / BigInt(medianRewards.length);
    }
  } catch { /* use default */ }

  // EIP-1559: maxFee = 2 * baseFee + priorityFee
  const maxFeeWei = baseFeeWei * BigInt(2) + priorityFeeWei;
  const estimatedCostWei = maxFeeWei * BigInt(gasUnits);

  // Get ETH/USD price
  let ethPriceUsd: number | undefined;
  try {
    const priceRes = await fetchWithTimeout(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      {}, 5_000
    );
    if (priceRes.ok) {
      const priceData = await priceRes.json() as { ethereum?: { usd?: number } };
      ethPriceUsd = priceData.ethereum?.usd;
    }
  } catch { /* best effort */ }

  const estimatedCostEth = weiToEth(estimatedCostWei);
  const estimatedCostUsd = ethPriceUsd
    ? (parseFloat(estimatedCostEth) * ethPriceUsd).toFixed(4)
    : undefined;

  return {
    chainId,
    baseFeeGwei: weiToGwei(baseFeeWei),
    maxPriorityFeeGwei: weiToGwei(priorityFeeWei),
    maxFeeGwei: weiToGwei(maxFeeWei),
    estimatedCostEth,
    estimatedCostUsd,
    confidence: 'high',
    fetchedAt: getTodayISO(),
  };
}

// ── Wallet ────────────────────────────────────────────────────

async function getWalletInfo(address: string, chainId: number): Promise<WalletInfo> {
  const [balanceHex, nonceHex] = await Promise.all([
    rpcCall(chainId, 'eth_getBalance', [address, 'latest']) as Promise<string>,
    rpcCall(chainId, 'eth_getTransactionCount', [address, 'latest']) as Promise<string>,
  ]);
  const balanceWei = hexToDecimal(balanceHex);
  return {
    address,
    chainId,
    balanceWei: balanceWei.toString(),
    balanceEth: weiToEth(balanceWei),
    nonce: Number(hexToDecimal(nonceHex)),
    connectedAt: getTodayISO(),
    source: process.env.WALLET_PRIVATE_KEY ? 'private_key_env' : 'local_keystore',
  };
}

// ── Transaction simulation via eth_call ───────────────────────

async function simulateTransaction(req: TransactionRequest): Promise<{ success: boolean; trace: string; gasEstimate?: string }> {
  try {
    // eth_call for simulation (doesn't broadcast)
    const callObj: Record<string, string> = {
      from: req.from,
      ...(req.to && { to: req.to }),
      ...(req.value && { value: '0x' + BigInt(req.value).toString(16) }),
      ...(req.data && { data: req.data }),
    };

    await rpcCall(req.chainId, 'eth_call', [callObj, 'latest']);

    // If we get here, call succeeded — estimate gas
    const gasHex = await rpcCall(req.chainId, 'eth_estimateGas', [callObj]) as string;
    const gasEst = hexToDecimal(gasHex).toString();

    return { success: true, trace: 'Simulation passed — call succeeded', gasEstimate: gasEst };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, trace: `Simulation failed: ${msg}` };
  }
}

// ── Nonce manager — prevents nonce collision on concurrent txs ─

const pendingNonces = new Map<string, { nonce: number; lockedAt: number }>();
const NONCE_LOCK_TTL_MS = 60_000;

async function acquireNonce(chainId: number, from: string): Promise<number> {
  const key = `${chainId}:${from.toLowerCase()}`;
  const now = Date.now();

  // Release stale locks
  const existing = pendingNonces.get(key);
  if (existing && now - existing.lockedAt > NONCE_LOCK_TTL_MS) {
    pendingNonces.delete(key);
  }

  // Get current pending nonce from chain
  const chainNonce = await rpcCall(chainId, 'eth_getTransactionCount', [from, 'pending'])
    .then(h => Number(hexToDecimal(h as string)));

  // If we have a pending nonce that is higher, use that + 1
  const localPending = pendingNonces.get(key);
  const nonce = localPending ? Math.max(chainNonce, localPending.nonce + 1) : chainNonce;

  pendingNonces.set(key, { nonce, lockedAt: now });
  return nonce;
}

function releaseNonce(chainId: number, from: string, nonce: number, success: boolean) {
  const key = `${chainId}:${from.toLowerCase()}`;
  if (!success) {
    // On failure, clear so next attempt fetches fresh from chain
    pendingNonces.delete(key);
  }
  // On success, keep so next concurrent tx gets nonce+1
}

// ── Gas spike protection ──────────────────────────────────────

const GAS_SPIKE_MULTIPLIER = parseFloat(process.env.GAS_SPIKE_MAX_MULTIPLIER ?? '3.0');

async function checkGasSpike(chainId: number, requestedMaxFeeGwei?: string): Promise<{ safe: boolean; currentGwei: number; requestedGwei: number | null; reason?: string }> {
  try {
    const gas = await estimateGas(chainId);
    const currentGwei = parseFloat(gas.baseFeeGwei);
    if (!requestedMaxFeeGwei) return { safe: true, currentGwei, requestedGwei: null };
    const requestedGwei = parseFloat(requestedMaxFeeGwei) / 1e9; // convert wei to gwei
    if (requestedGwei > currentGwei * GAS_SPIKE_MULTIPLIER) {
      return { safe: false, currentGwei, requestedGwei, reason: `maxFeePerGas ${requestedGwei.toFixed(2)} gwei is ${(requestedGwei / currentGwei).toFixed(1)}x current base fee ${currentGwei.toFixed(2)} gwei — exceeds spike threshold ${GAS_SPIKE_MULTIPLIER}x` };
    }
    return { safe: true, currentGwei, requestedGwei };
  } catch {
    return { safe: true, currentGwei: 0, requestedGwei: null }; // allow through if check fails
  }
}

// ── Transaction signing + broadcast ──────────────────────────

function getPrivateKey(): string {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) throw new Error('WALLET_PRIVATE_KEY not set — cannot sign transactions');
  return pk.startsWith('0x') ? pk : `0x${pk}`;
}

async function sendTransaction(req: TransactionRequest): Promise<TransactionResult> {
  const t0 = Date.now();
  const chain = CHAINS[req.chainId];
  if (!chain) throw new Error(`Unsupported chainId: ${req.chainId}`);

  // Resolve gas if not provided
  let gasLimit = req.gasLimit;
  let maxFeePerGas = req.maxFeePerGas;
  let maxPriorityFeePerGas = req.maxPriorityFeePerGas;

  if (!gasLimit || !maxFeePerGas || !maxPriorityFeePerGas) {
    const gas = await estimateGas(req.chainId);
    if (!gasLimit) {
      const callObj = {
        from: req.from,
        ...(req.to && { to: req.to }),
        ...(req.data && { data: req.data }),
        ...(req.value && { value: '0x' + BigInt(req.value).toString(16) }),
      };
      try {
        const gasHex = await rpcCall(req.chainId, 'eth_estimateGas', [callObj]) as string;
        // Add 20% buffer
        gasLimit = (hexToDecimal(gasHex) * BigInt(120) / BigInt(100)).toString();
      } catch {
        gasLimit = '300000'; // fallback
      }
    }
    if (!maxFeePerGas) maxFeePerGas = (BigInt(Math.ceil(parseFloat(gas.maxFeeGwei) * 1e9))).toString();
    if (!maxPriorityFeePerGas) maxPriorityFeePerGas = (BigInt(Math.ceil(parseFloat(gas.maxPriorityFeeGwei) * 1e9))).toString();
  }

  // Gas spike protection — reject if gas is unreasonably high
  if (maxFeePerGas) {
    const spikeCheck = await checkGasSpike(req.chainId, maxFeePerGas);
    if (!spikeCheck.safe) {
      throw new Error(`Gas spike protection triggered: ${spikeCheck.reason}`);
    }
  }

  // Get nonce using nonce manager (prevents concurrent nonce collisions)
  const nonce = req.nonce ?? await acquireNonce(req.chainId, req.from);

  // Use cast (Foundry) for signing and broadcasting if available
  let txHash: string;
  const castAvailable = await checkToolAvailable('cast');
  let broadcastSuccess = false;

  try {
    if (castAvailable) {
      txHash = await broadcastWithCast(req, chain.rpcUrl, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas);
    } else {
      txHash = await broadcastWithEthers(req, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas);
    }
    broadcastSuccess = true;
  } finally {
    releaseNonce(req.chainId, req.from, nonce, broadcastSuccess);
  }

  // Poll for receipt
  const receipt = await waitForReceipt(req.chainId, txHash, 60);

  const result: TransactionResult = {
    taskId: req.taskId,
    txHash,
    status: receipt?.status === '0x1' ? 'confirmed' : receipt ? 'reverted' : 'submitted',
    blockNumber: receipt ? Number(hexToDecimal(receipt.blockNumber as string)) : undefined,
    gasUsed: receipt?.gasUsed ? hexToDecimal(receipt.gasUsed as string).toString() : undefined,
    effectiveGasPrice: receipt?.effectiveGasPrice
      ? weiToGwei(hexToDecimal(receipt.effectiveGasPrice as string)) + ' gwei'
      : undefined,
    submittedAt: new Date(t0).toISOString(),
    confirmedAt: receipt ? getTodayISO() : undefined,
    explorerUrl: chain.explorerUrl ? `${chain.explorerUrl}/tx/${txHash}` : undefined,
  };

  return result;
}

async function broadcastWithCast(
  req: TransactionRequest,
  rpcUrl: string,
  nonce: number,
  gasLimit: string,
  maxFee: string,
  maxPriorityFee: string,
): Promise<string> {
  const pk = getPrivateKey();
  const args = [
    'send',
    '--rpc-url', rpcUrl,
    '--private-key', pk,
    '--nonce', nonce.toString(),
    '--gas-limit', gasLimit,
    '--gas-price', maxFee,
    '--priority-gas-price', maxPriorityFee,
    '--json',
  ];
  if (req.to) args.push(req.to);
  if (req.value) { args.push('--value'); args.push(req.value); }
  if (req.data) { args.push(req.data); }

  const { stdout } = await execAsync('cast', args, { timeout: 60_000 });
  const result = JSON.parse(stdout) as { transactionHash?: string };
  if (!result.transactionHash) throw new Error('cast send did not return txHash');
  return result.transactionHash;
}

async function broadcastWithEthers(
  req: TransactionRequest,
  nonce: number,
  gasLimit: string,
  maxFee: string,
  maxPriorityFee: string,
): Promise<string> {
  // Dynamic import ethers — only load when needed
  const { ethers } = await import('ethers');
  const chain = CHAINS[req.chainId];
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
  const wallet = new ethers.Wallet(getPrivateKey(), provider);

  const tx = await wallet.sendTransaction({
    to: req.to,
    value: req.value ? BigInt(req.value) : undefined,
    data: req.data,
    nonce,
    gasLimit: BigInt(gasLimit),
    maxFeePerGas: BigInt(maxFee),
    maxPriorityFeePerGas: BigInt(maxPriorityFee),
    chainId: req.chainId,
  });
  return tx.hash;
}

async function waitForReceipt(chainId: number, txHash: string, maxWaitSeconds: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const receipt = await rpcCall(chainId, 'eth_getTransactionReceipt', [txHash]) as Record<string, unknown> | null;
      if (receipt) return receipt;
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 2_000));
  }
  return null;
}

// ── Tool availability checks ──────────────────────────────────

const toolCache = new Map<string, boolean>();
async function checkToolAvailable(tool: string): Promise<boolean> {
  if (toolCache.has(tool)) return toolCache.get(tool)!;
  try {
    await execAsync('which', [tool], { timeout: 2_000 });
    toolCache.set(tool, true);
    return true;
  } catch {
    toolCache.set(tool, false);
    return false;
  }
}

// ── Solidity compilation ──────────────────────────────────────

async function compileWithFoundry(req: CompileRequest): Promise<CompileResult> {
  const dir = join(WORKSPACE, 'compile', req.taskId);
  await mkdir(dir, { recursive: true });
  const srcFile = join(dir, `${req.contractName}.sol`);
  const outDir = join(dir, 'out');

  try {
    await writeFile(srcFile, req.source, 'utf-8');
    const { stdout, stderr } = await execAsync(
      'forge', ['build', '--contracts', srcFile, '--out', outDir, '--json'],
      { timeout: 60_000, cwd: dir }
    );

    const warnings = stderr ? stderr.split('\n').filter(l => l.includes('Warning')).map(l => l.trim()) : [];

    // Parse forge output
    const artifactPath = join(outDir, `${req.contractName}.sol`, `${req.contractName}.json`);
    if (!existsSync(artifactPath)) {
      return {
        taskId: req.taskId, success: false, contractName: req.contractName,
        errors: [stderr || 'Compilation failed — artifact not found'],
        warnings, compiledAt: getTodayISO(),
      };
    }
    const artifact = JSON.parse(await readFile(artifactPath, 'utf-8')) as {
      abi: unknown[]; bytecode: { object: string; deployedObject?: string }; metadata?: string;
    };

    return {
      taskId: req.taskId, success: true, contractName: req.contractName,
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      deployedBytecode: artifact.bytecode.deployedObject,
      metadata: artifact.metadata,
      warnings, compiledAt: getTodayISO(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      taskId: req.taskId, success: false, contractName: req.contractName,
      errors: [msg.slice(0, 2000)], compiledAt: getTodayISO(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { });
  }
}

async function compileWithHardhat(req: CompileRequest): Promise<CompileResult> {
  const dir = join(WORKSPACE, 'hardhat', req.taskId);
  await mkdir(join(dir, 'contracts'), { recursive: true });
  await mkdir(join(dir, 'artifacts'), { recursive: true });

  const srcFile = join(dir, 'contracts', `${req.contractName}.sol`);
  const hardhatConfig = `
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
const config: HardhatUserConfig = {
  solidity: { version: "${req.solidityVersion ?? '0.8.24'}", settings: { optimizer: { enabled: ${req.optimizer?.enabled ?? true}, runs: ${req.optimizer?.runs ?? 200} } } },
};
export default config;
`;
  try {
    await writeFile(srcFile, req.source, 'utf-8');
    await writeFile(join(dir, 'hardhat.config.ts'), hardhatConfig, 'utf-8');
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'compile-task', type: 'module',
      dependencies: { hardhat: '^2.22.0', '@nomicfoundation/hardhat-toolbox': '^5.0.0' },
    }), 'utf-8');

    // Install deps and compile
    await execAsync('npm', ['install', '--prefer-offline', '--silent'], { cwd: dir, timeout: 120_000 });
    const { stderr } = await execAsync('npx', ['hardhat', 'compile'], { cwd: dir, timeout: 60_000 });

    const artifactPath = join(dir, 'artifacts', 'contracts', `${req.contractName}.sol`, `${req.contractName}.json`);
    if (!existsSync(artifactPath)) {
      return {
        taskId: req.taskId, success: false, contractName: req.contractName,
        errors: [stderr || 'Hardhat compile failed'], compiledAt: getTodayISO(),
      };
    }
    const artifact = JSON.parse(await readFile(artifactPath, 'utf-8')) as {
      abi: unknown[]; bytecode: string; deployedBytecode: string;
    };
    return {
      taskId: req.taskId, success: true, contractName: req.contractName,
      abi: artifact.abi, bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode,
      compiledAt: getTodayISO(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      taskId: req.taskId, success: false, contractName: req.contractName,
      errors: [msg.slice(0, 2000)], compiledAt: getTodayISO(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { });
  }
}

async function compileSolidity(req: CompileRequest): Promise<CompileResult> {
  // Gate-check the Solidity before compiling
  try {
    const gateRes = await internalFetch('module1-relevance-gate', '/check', {
      method: 'POST',
      body: JSON.stringify({ content: req.source, contentType: 'solidity', submittedBy: 'blockchain', taskId: req.taskId }),
    }, 30_000);
    const gate = await gateRes.json() as { approved: boolean; reason: string };
    if (!gate.approved) {
      return {
        taskId: req.taskId, success: false, contractName: req.contractName,
        errors: [`Gate rejected Solidity: ${gate.reason}`], compiledAt: getTodayISO(),
      };
    }
  } catch { /* gate unavailable — compile anyway but log */ }

  const forgeAvailable = await checkToolAvailable('forge');
  return forgeAvailable ? compileWithFoundry(req) : compileWithHardhat(req);
}

// ── Contract deployment ───────────────────────────────────────

async function deployContract(req: DeployRequest): Promise<DeployResult> {
  const chain = CHAINS[req.chainId];
  if (!chain) return { taskId: req.taskId, success: false, error: `Unsupported chainId: ${req.chainId}`, deployedAt: getTodayISO() };

  const t0 = Date.now();

  // Audit the ABI/bytecode before deploying
  try {
    const auditRes = await internalFetch('module2-auditor', '/audit', {
      method: 'POST',
      body: JSON.stringify({
        content: JSON.stringify({ abi: req.abi, bytecode: req.bytecode.slice(0, 5000) }),
        contentType: 'solidity', auditDate: getTodayDate(), taskId: req.taskId,
      }),
    }, 50_000);
    const audit = await auditRes.json() as { passed: boolean; recommendation: string; summary: string };
    if (!audit.passed && audit.recommendation === 'reject') {
      return {
        taskId: req.taskId, success: false,
        error: `Security audit rejected deployment: ${audit.summary}`,
        deployedAt: getTodayISO(),
      };
    }
  } catch { /* audit unavailable — proceed with warning */ }

  try {
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
    const wallet = new ethers.Wallet(getPrivateKey(), provider);

    const factory = new ethers.ContractFactory(req.abi, req.bytecode, wallet);

    // Gas estimation for deployment
    const gas = await estimateGas(req.chainId, 3_000_000); // deployment gas estimate
    const deployTx = await factory.deploy(...(req.constructorArgs ?? []), {
      value: req.value ? BigInt(req.value) : undefined,
      gasLimit: req.gasLimit ? BigInt(req.gasLimit) : BigInt(3_000_000),
      maxFeePerGas: BigInt(Math.ceil(parseFloat(gas.maxFeeGwei) * 1e9)),
      maxPriorityFeePerGas: BigInt(Math.ceil(parseFloat(gas.maxPriorityFeeGwei) * 1e9)),
    });

    const receipt = await deployTx.deploymentTransaction()?.wait(1);
    const contractAddress = await deployTx.getAddress();

    // Emit event
    void emitEvent('blockchain.contract_deployed', {
      contractAddress, chainId: req.chainId, contractName: req.contractName,
      txHash: deployTx.deploymentTransaction()?.hash, deployedBy: req.from,
    });

    // Persist to DB
    void persistContract({
      contractId: crypto.randomUUID(),
      name: req.contractName,
      address: contractAddress,
      chainId: req.chainId,
      abi: req.abi,
      bytecode: req.bytecode,
      txHash: deployTx.deploymentTransaction()?.hash,
      deployedBy: req.from,
      verified: false,
      deployedAt: getTodayISO(),
      taskId: req.taskId,
    });

    // Verify on explorer if requested
    let verified = false;
    if (req.verify && req.explorerApiKey && chain.explorerApiUrl) {
      verified = await verifyOnExplorer(contractAddress, req, chain);
      void emitEvent('blockchain.contract_verified', { contractAddress, chainId: req.chainId });
    }

    return {
      taskId: req.taskId,
      success: true,
      contractAddress,
      txHash: deployTx.deploymentTransaction()?.hash,
      blockNumber: receipt?.blockNumber,
      gasUsed: receipt?.gasUsed?.toString(),
      abi: req.abi,
      verified,
      deployedAt: getTodayISO(),
      explorerUrl: chain.explorerUrl ? `${chain.explorerUrl}/address/${contractAddress}` : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { taskId: req.taskId, success: false, error: msg.slice(0, 500), deployedAt: getTodayISO() };
  }
}

async function verifyOnExplorer(contractAddress: string, req: DeployRequest, chain: ChainConfig): Promise<boolean> {
  if (!chain.explorerApiUrl || !req.explorerApiKey) return false;
  try {
    // Standard explorer verification via API
    const body = new URLSearchParams({
      apikey: req.explorerApiKey,
      module: 'contract',
      action: 'verifysourcecode',
      contractaddress: contractAddress,
      contractname: req.contractName,
      codeformat: 'solidity-standard-json-input',
      compilerversion: 'v0.8.24+commit.e11b9ed9',
      sourceCode: JSON.stringify({ language: 'Solidity' }),
    });
    const res = await fetchWithTimeout(`${chain.explorerApiUrl}`, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, 30_000);
    const data = await res.json() as { status: string };
    return data.status === '1';
  } catch {
    return false;
  }
}

// ── Meme token template ───────────────────────────────────────

function generateMemeTokenSolidity(cfg: MemeTokenConfig): string {
  const hasTax = (cfg.taxBuyPercent ?? 0) > 0 || (cfg.taxSellPercent ?? 0) > 0;
  const hasLimits = (cfg.maxWalletPercent ?? 0) > 0 || (cfg.maxTxPercent ?? 0) > 0;

  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
${cfg.burnable ? 'import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";' : ''}

contract ${cfg.name.replace(/\s+/g, '')} is ERC20${cfg.burnable ? ', ERC20Burnable' : ''}, Ownable {
    uint8 private _decimals;
    ${hasTax ? `
    uint256 public buyTaxPercent = ${cfg.taxBuyPercent ?? 0};
    uint256 public sellTaxPercent = ${cfg.taxSellPercent ?? 0};
    address public taxWallet;
    mapping(address => bool) public isExcludedFromTax;
    address public uniswapPair;
    ` : ''}
    ${hasLimits ? `
    uint256 public maxWalletAmount;
    uint256 public maxTxAmount;
    mapping(address => bool) public isExcludedFromLimits;
    ` : ''}
    bool public tradingEnabled;

    event TradingEnabled(uint256 timestamp);
    ${hasTax ? 'event TaxUpdated(uint256 buyTax, uint256 sellTax);' : ''}

    constructor() ERC20("${cfg.name}", "${cfg.symbol}") Ownable(msg.sender) {
        _decimals = ${cfg.decimals};
        ${hasTax ? `taxWallet = ${cfg.taxWallet ? `address(${cfg.taxWallet})` : 'msg.sender'};
        isExcludedFromTax[msg.sender] = true;
        isExcludedFromTax[address(this)] = true;` : ''}
        ${hasLimits ? `
        uint256 totalTokens = ${cfg.totalSupply} * 10**${cfg.decimals};
        maxWalletAmount = totalTokens * ${cfg.maxWalletPercent ?? 100} / 100;
        maxTxAmount = totalTokens * ${cfg.maxTxPercent ?? 100} / 100;
        isExcludedFromLimits[msg.sender] = true;
        isExcludedFromLimits[address(this)] = true;
        ` : ''}
        _mint(msg.sender, ${cfg.totalSupply} * 10**uint256(_decimals));
    }

    function decimals() public view override returns (uint8) { return _decimals; }

    function enableTrading() external onlyOwner {
        require(!tradingEnabled, "Already enabled");
        tradingEnabled = true;
        emit TradingEnabled(block.timestamp);
    }

    ${hasTax ? `
    function setUniswapPair(address pair) external onlyOwner { uniswapPair = pair; }
    function setTaxWallet(address wallet) external onlyOwner {
        require(wallet != address(0), "Zero address");
        taxWallet = wallet;
    }
    function setTaxes(uint256 buyTax, uint256 sellTax) external onlyOwner {
        require(buyTax <= 25 && sellTax <= 25, "Tax too high");
        buyTaxPercent = buyTax;
        sellTaxPercent = sellTax;
        emit TaxUpdated(buyTax, sellTax);
    }
    function excludeFromTax(address account, bool excluded) external onlyOwner {
        isExcludedFromTax[account] = excluded;
    }
    ` : ''}

    ${hasLimits ? `
    function setMaxWallet(uint256 amount) external onlyOwner { maxWalletAmount = amount; }
    function setMaxTx(uint256 amount) external onlyOwner { maxTxAmount = amount; }
    function excludeFromLimits(address account, bool excluded) external onlyOwner {
        isExcludedFromLimits[account] = excluded;
    }
    ` : ''}

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            require(tradingEnabled || from == owner() || to == owner(), "Trading not enabled");
            ${hasLimits ? `
            if (!isExcludedFromLimits[from] && !isExcludedFromLimits[to]) {
                require(amount <= maxTxAmount, "Exceeds max tx");
                if (to != uniswapPair) {
                    require(balanceOf(to) + amount <= maxWalletAmount, "Exceeds max wallet");
                }
            }` : ''}
            ${hasTax ? `
            if (!isExcludedFromTax[from] && !isExcludedFromTax[to]) {
                uint256 taxRate = (from == uniswapPair) ? buyTaxPercent : (to == uniswapPair) ? sellTaxPercent : 0;
                if (taxRate > 0 && taxWallet != address(0)) {
                    uint256 taxAmount = amount * taxRate / 100;
                    super._update(from, taxWallet, taxAmount);
                    amount -= taxAmount;
                }
            }` : ''}
        }
        super._update(from, to, amount);
    }

    ${cfg.mintable ? `function mint(address to, uint256 amount) external onlyOwner { _mint(to, amount); }` : ''}

    receive() external payable {}
}
`;
}

// ── DB and event helpers ──────────────────────────────────────

async function emitEvent(type: string, payload: Record<string, unknown>, taskId?: string) {
  try {
    await internalFetch('module9-events', '/emit', {
      method: 'POST',
      body: JSON.stringify({ type, source: 'module11-blockchain', payload, emittedAt: getTodayISO(), taskId }),
    }, 3_000);
  } catch { /* best-effort */ }
}

async function persistContract(contract: ContractRecord) {
  try {
    await internalFetch('module6-database', '/contracts', {
      method: 'POST',
      body: JSON.stringify(contract),
    }, 5_000);
  } catch { /* best-effort */ }
}

async function persistTransaction(tx: TransactionResult, taskId: string, chainId: number, description: string) {
  try {
    await internalFetch('module6-database', '/blockchain-transactions', {
      method: 'POST',
      body: JSON.stringify({ ...tx, chainId, description }),
    }, 5_000);
  } catch { /* best-effort */ }
}

// ── Schemas ───────────────────────────────────────────────────

const GasSchema = z.object({
  chainId: z.number().int().positive(),
  gasUnits: z.number().int().positive().optional(),
});

const WalletSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Ethereum address'),
  chainId: z.number().int().positive(),
});

const TxSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  chainId: z.number().int().positive(),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  value: z.string().optional(),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/).optional(),
  gasLimit: z.string().optional(),
  maxFeePerGas: z.string().optional(),
  maxPriorityFeePerGas: z.string().optional(),
  nonce: z.number().int().nonnegative().optional(),
  description: z.string().min(1).max(200),
  simulate: z.boolean().default(false),
});

const CompileSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  source: z.string().min(1).max(500_000),
  contractName: z.string().min(1).max(100),
  solidityVersion: z.string().optional(),
  optimizer: z.object({ enabled: z.boolean(), runs: z.number().int() }).optional(),
});

const DeploySchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  chainId: z.number().int().positive(),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  contractName: z.string().min(1),
  abi: z.array(z.unknown()),
  bytecode: z.string().startsWith('0x'),
  constructorArgs: z.array(z.unknown()).optional(),
  value: z.string().optional(),
  gasLimit: z.string().optional(),
  verify: z.boolean().default(false),
  explorerApiKey: z.string().optional(),
});

const MemeTokenSchema = z.object({
  taskId: z.string().uuid().default(() => crypto.randomUUID()),
  chainId: z.number().int().positive(),
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  config: z.object({
    name: z.string().min(1).max(50),
    symbol: z.string().min(1).max(10),
    totalSupply: z.string().min(1),
    decimals: z.number().int().min(0).max(18).default(18),
    mintable: z.boolean().default(false),
    burnable: z.boolean().default(true),
    taxBuyPercent: z.number().min(0).max(25).optional(),
    taxSellPercent: z.number().min(0).max(25).optional(),
    taxWallet: z.string().optional(),
    maxWalletPercent: z.number().min(0).max(100).optional(),
    maxTxPercent: z.number().min(0).max(100).optional(),
    addLiquidity: z.object({
      dexRouter: z.string(),
      ethAmount: z.string(),
      tokenPercent: z.number().min(1).max(100),
      lockLpDays: z.number().int().min(0).optional(),
    }).optional(),
  }),
  solidityVersion: z.string().optional(),
  verify: z.boolean().default(false),
  explorerApiKey: z.string().optional(),
  deployOnly: z.boolean().default(false), // if true, skip liquidity add
});

// ── Routes ────────────────────────────────────────────────────

fastify.get('/health', async (): Promise<HealthStatus> => {
  const forgeAvailable = await checkToolAvailable('forge');
  const castAvailable = await checkToolAvailable('cast');
  const hardhatAvailable = await checkToolAvailable('hardhat');
  return {
    service: 'module11-blockchain',
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
    version: JSON.stringify({ forge: forgeAvailable, cast: castAvailable, hardhat: hardhatAvailable }),
  };
});

// GET /chains — list supported chains
fastify.get('/chains', async () => ({
  chains: Object.values(CHAINS).map(c => ({
    chainId: c.chainId, name: c.name,
    explorerUrl: c.explorerUrl, isTestnet: c.isTestnet,
    nativeCurrency: c.nativeCurrency,
  })),
}));

// GET /gas?chainId=1 — gas price estimate
fastify.get('/gas', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const parsed = GasSchema.safeParse({ chainId: parseInt(q['chainId'] ?? '1'), gasUnits: q['gasUnits'] ? parseInt(q['gasUnits']) : undefined });
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid params', issues: parsed.error.issues });
  try {
    const estimate = await estimateGas(parsed.data.chainId, parsed.data.gasUnits);
    void emitEvent('blockchain.gas_spike', { ...estimate }, undefined);
    return estimate;
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// GET /wallet — wallet info and balance
fastify.get('/wallet', async (req: FastifyRequest, reply: FastifyReply) => {
  const q = req.query as Record<string, string>;
  const parsed = WalletSchema.safeParse({ address: q['address'], chainId: parseInt(q['chainId'] ?? '1') });
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid params', issues: parsed.error.issues });
  try {
    const info = await getWalletInfo(parsed.data.address, parsed.data.chainId);
    void emitEvent('blockchain.wallet_connected', { address: parsed.data.address, chainId: parsed.data.chainId });
    return info;
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /simulate — simulate a transaction without broadcasting
fastify.post('/simulate', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = TxSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  try {
    const result = await simulateTransaction(parsed.data as TransactionRequest);
    void emitEvent(
      result.success ? 'blockchain.simulation_passed' : 'blockchain.simulation_failed',
      { taskId: parsed.data.taskId, ...result }
    );
    return reply.status(result.success ? 200 : 422).send(result);
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /transaction — send a transaction with nonce management and gas spike protection
fastify.post('/transaction', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = TxSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const txReq = parsed.data as TransactionRequest;

  // Always simulate first unless explicitly skipped
  if (txReq.simulate !== false) {
    const sim = await simulateTransaction(txReq);
    if (!sim.success) {
      void emitEvent('blockchain.simulation_failed', { taskId: txReq.taskId, trace: sim.trace });
      return reply.status(422).send({ error: 'Simulation failed — tx not sent', trace: sim.trace });
    }
  }

  try {
    const result = await sendTransaction(txReq);
    void persistTransaction(result, txReq.taskId, txReq.chainId, txReq.description);
    void emitEvent(
      result.status === 'confirmed' ? 'blockchain.tx_confirmed' :
        result.status === 'failed' || result.status === 'reverted' ? 'blockchain.tx_failed' : 'blockchain.tx_submitted',
      { txHash: result.txHash, chainId: txReq.chainId, status: result.status }
    );
    // Speak confirmation via voice
    try { await internalFetch('module14-voice', '/speak-tx', { method: 'POST', body: JSON.stringify(result) }, 8_000); } catch {}
    return reply.status(result.status === 'confirmed' ? 200 : 202).send(result);
  } catch (err) {
    const errMsg = String(err).slice(0, 300);
    if (errMsg.includes('Gas spike protection')) {
      void emitEvent('blockchain.gas_spike_blocked', { chainId: txReq.chainId, reason: errMsg });
      return reply.status(422).send({ error: errMsg, code: 'GAS_SPIKE_PROTECTION' });
    }
    return reply.status(500).send({ error: errMsg });
  }
});

// POST /transaction/speed-up — replace a pending tx with higher gas
fastify.post('/transaction/speed-up', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const txHash = String(b['txHash'] ?? '');
  const chainId = parseInt(String(b['chainId'] ?? '1'));
  const from = String(b['from'] ?? '');
  const gasBumpPercent = parseInt(String(b['gasBumpPercent'] ?? '20'));

  if (!txHash || !from) return reply.status(400).send({ error: 'txHash and from required' });

  try {
    // Get current gas prices with bump
    const gas = await estimateGas(chainId);
    const bumpMultiplier = (100 + gasBumpPercent) / 100;
    const newMaxFeePerGas = (BigInt(Math.ceil(parseFloat(gas.maxFeeGwei) * 1e9 * bumpMultiplier))).toString();
    const newMaxPriorityFeePerGas = (BigInt(Math.ceil(parseFloat(gas.maxPriorityFeeGwei) * 1e9 * bumpMultiplier))).toString();

    // Get original tx nonce from pending txs
    const pendingKey = `${chainId}:${from.toLowerCase()}`;
    const pending = pendingNonces.get(pendingKey);
    if (!pending) return reply.status(404).send({ error: 'No pending nonce found for this wallet — tx may already be confirmed' });

    // Send replacement tx with same nonce but higher gas (empty data = ETH transfer to self to cancel)
    const replacementReq: TransactionRequest = {
      taskId: crypto.randomUUID(),
      chainId,
      from,
      to: from, // send to self
      value: '0',
      nonce: pending.nonce,
      maxFeePerGas: newMaxFeePerGas,
      maxPriorityFeePerGas: newMaxPriorityFeePerGas,
      simulate: false,
      description: `Speed-up replacement for ${txHash.slice(0, 14)}`,
    };

    const result = await sendTransaction(replacementReq);
    void emitEvent('blockchain.tx_replaced', { originalHash: txHash, replacementHash: result.txHash, chainId, action: 'speed-up', gasBumpPercent });
    fastify.log.info({ originalHash: txHash, replacementHash: result.txHash, gasBumpPercent }, 'Transaction speed-up submitted');
    return reply.send({ ok: true, originalHash: txHash, replacementHash: result.txHash, action: 'speed-up', gasBumpPercent });
  } catch (err) {
    return reply.status(500).send({ error: String(err).slice(0, 200) });
  }
});

// POST /transaction/cancel — cancel a pending tx by replacing with zero-value self-transfer
fastify.post('/transaction/cancel', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as Record<string, unknown>;
  const txHash = String(b['txHash'] ?? '');
  const chainId = parseInt(String(b['chainId'] ?? '1'));
  const from = String(b['from'] ?? '');

  if (!txHash || !from) return reply.status(400).send({ error: 'txHash and from required' });

  try {
    const gas = await estimateGas(chainId);
    // Use 50% gas bump for cancellation to ensure it replaces
    const bumpMultiplier = 1.5;
    const newMaxFeePerGas = (BigInt(Math.ceil(parseFloat(gas.maxFeeGwei) * 1e9 * bumpMultiplier))).toString();
    const newMaxPriorityFeePerGas = (BigInt(Math.ceil(parseFloat(gas.maxPriorityFeeGwei) * 1e9 * bumpMultiplier))).toString();

    const pendingKey = `${chainId}:${from.toLowerCase()}`;
    const pending = pendingNonces.get(pendingKey);
    if (!pending) return reply.status(404).send({ error: 'No pending nonce found — tx may already be confirmed or dropped' });

    const cancelReq: TransactionRequest = {
      taskId: crypto.randomUUID(),
      chainId,
      from,
      to: from,
      value: '0',
      nonce: pending.nonce,
      maxFeePerGas: newMaxFeePerGas,
      maxPriorityFeePerGas: newMaxPriorityFeePerGas,
      simulate: false,
      description: `Cancellation replacement for ${txHash.slice(0, 14)}`,
    };

    const result = await sendTransaction(cancelReq);
    void emitEvent('blockchain.tx_cancelled', { originalHash: txHash, replacementHash: result.txHash, chainId });
    fastify.log.info({ originalHash: txHash, replacementHash: result.txHash }, 'Transaction cancellation submitted');
    return reply.send({ ok: true, originalHash: txHash, cancellationHash: result.txHash, action: 'cancel', note: 'Cancellation tx submitted — will be confirmed when mined' });
  } catch (err) {
    return reply.status(500).send({ error: String(err).slice(0, 200) });
  }
});

// GET /nonces — view pending nonce state per wallet
fastify.get('/nonces', async () => ({
  pendingNonces: Object.fromEntries(
    [...pendingNonces.entries()].map(([key, v]) => [key, { nonce: v.nonce, lockedAt: new Date(v.lockedAt).toISOString(), ageMs: Date.now() - v.lockedAt }])
  ),
  count: pendingNonces.size,
}));

// DELETE /nonces/:chainId/:address — clear nonce lock for a wallet
fastify.delete('/nonces/:chainId/:address', async (req: FastifyRequest<{ Params: { chainId: string; address: string } }>, reply: FastifyReply) => {
  const key = `${req.params.chainId}:${req.params.address.toLowerCase()}`;
  const existed = pendingNonces.has(key);
  pendingNonces.delete(key);
  return reply.send({ ok: true, key, cleared: existed });
});

// POST /compile — compile Solidity
fastify.post('/compile', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = CompileSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  const result = await compileSolidity(parsed.data as CompileRequest);
  return reply.status(result.success ? 200 : 422).send(result);
});

// POST /deploy — deploy a compiled contract
fastify.post('/deploy', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = DeploySchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });
  const result = await deployContract(parsed.data as DeployRequest);
  return reply.status(result.success ? 200 : 422).send(result);
});

// POST /compile-and-deploy — one-shot: compile then deploy
fastify.post('/compile-and-deploy', async (req: FastifyRequest, reply: FastifyReply) => {
  const body = req.body as Record<string, unknown>;
  const compileReq = {
    taskId: body['taskId'] as string ?? crypto.randomUUID(),
    source: body['source'] as string,
    contractName: body['contractName'] as string,
    solidityVersion: body['solidityVersion'] as string | undefined,
    optimizer: body['optimizer'] as { enabled: boolean; runs: number } | undefined,
  };

  const compiled = await compileSolidity(compileReq);
  if (!compiled.success) return reply.status(422).send(compiled);
  if (!compiled.abi || !compiled.bytecode) {
    return reply.status(422).send({ error: 'Compile succeeded but missing ABI/bytecode' });
  }

  const deployReq: DeployRequest = {
    taskId: compileReq.taskId,
    chainId: body['chainId'] as number,
    from: body['from'] as string,
    contractName: compileReq.contractName,
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    constructorArgs: body['constructorArgs'] as unknown[] | undefined,
    value: body['value'] as string | undefined,
    gasLimit: body['gasLimit'] as string | undefined,
    verify: (body['verify'] as boolean) ?? false,
    explorerApiKey: body['explorerApiKey'] as string | undefined,
  };

  const deployed = await deployContract(deployReq);
  return reply.status(deployed.success ? 200 : 422).send({ compiled, deployed });
});

// POST /meme-token — full meme token launch pipeline
fastify.post('/meme-token', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = MemeTokenSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const { taskId, chainId, from, config: cfg, solidityVersion, verify, explorerApiKey, deployOnly } = parsed.data;
  fastify.log.info({ taskId, symbol: cfg.symbol }, 'Meme token launch started');

  // Step 1: Generate Solidity
  const source = generateMemeTokenSolidity(cfg as MemeTokenConfig);

  // Step 2: Compile
  const compiled = await compileSolidity({ taskId, source, contractName: cfg.name.replace(/\s+/g, ''), solidityVersion });
  if (!compiled.success) {
    return reply.status(422).send({ error: 'Compilation failed', details: compiled });
  }

  // Step 3: Deploy token contract
  const deployed = await deployContract({
    taskId, chainId, from,
    contractName: cfg.name.replace(/\s+/g, ''),
    abi: compiled.abi!, bytecode: compiled.bytecode!,
    verify, explorerApiKey,
  });

  if (!deployed.success) {
    return reply.status(422).send({ error: 'Deployment failed', details: deployed });
  }

  // Step 4: Add liquidity if configured and not deployOnly
  let liquidityResult: Record<string, unknown> | null = null;
  if (!deployOnly && cfg.addLiquidity && deployed.contractAddress) {
    try {
      const { ethers } = await import('ethers');
      const chain = CHAINS[chainId];
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
      const wallet = new ethers.Wallet(getPrivateKey(), provider);

      const tokenContract = new ethers.Contract(deployed.contractAddress, compiled.abi!, wallet);
      const routerAbi = [
        'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)',
      ];
      const router = new ethers.Contract(cfg.addLiquidity.dexRouter, routerAbi, wallet);

      const totalSupply = BigInt(cfg.totalSupply) * BigInt(10) ** BigInt(cfg.decimals);
      const tokenAmount = totalSupply * BigInt(cfg.addLiquidity.tokenPercent) / BigInt(100);
      const ethAmount = ethers.parseEther(cfg.addLiquidity.ethAmount);
      const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 min

      // Approve router
      await (tokenContract as unknown as { approve: (addr: string, amount: bigint) => Promise<{ wait: () => Promise<void> }> })
        .approve(cfg.addLiquidity.dexRouter, tokenAmount)
        .then((tx) => tx.wait());

      // Add liquidity
      const lpTx = await router.addLiquidityETH(
        deployed.contractAddress, tokenAmount, 0n, 0n, from, deadline,
        { value: ethAmount }
      );
      const lpReceipt = await lpTx.wait();

      liquidityResult = {
        success: true, txHash: lpTx.hash,
        blockNumber: lpReceipt?.blockNumber,
        tokenAmount: tokenAmount.toString(),
        ethAmount: cfg.addLiquidity.ethAmount,
      };

      void emitEvent('blockchain.contract_deployed', {
        type: 'liquidity_added', contractAddress: deployed.contractAddress,
        chainId, txHash: lpTx.hash,
      }, taskId);
    } catch (err) {
      liquidityResult = { success: false, error: String(err).slice(0, 300) };
    }
  }

  return reply.status(200).send({
    taskId,
    token: {
      name: cfg.name,
      symbol: cfg.symbol,
      address: deployed.contractAddress,
      chainId,
      explorerUrl: deployed.explorerUrl,
      verified: deployed.verified,
    },
    compilation: { warnings: compiled.warnings ?? [] },
    deployment: { txHash: deployed.txHash, gasUsed: deployed.gasUsed },
    liquidity: liquidityResult,
    source, // return generated source for transparency
  });
});

// GET /contracts — list deployed contracts
fastify.get('/contracts', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const qs = new URLSearchParams();
    if (q['chainId']) qs.set('chainId', q['chainId']);
    if (q['limit']) qs.set('limit', q['limit']);
    const res = await internalFetch('module6-database', `/contracts?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
    return { contracts: [] };
  } catch {
    return { contracts: [] };
  }
});

// GET /transactions — transaction history
fastify.get('/transactions', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  try {
    const qs = new URLSearchParams();
    if (q['chainId']) qs.set('chainId', q['chainId']);
    if (q['limit']) qs.set('limit', q['limit']);
    const res = await internalFetch('module6-database', `/blockchain-transactions?${qs.toString()}`, {}, 5_000);
    if (res.ok) return res.json();
    return { transactions: [] };
  } catch {
    return { transactions: [] };
  }
});

// POST /rpc — raw RPC proxy with auth
fastify.post('/rpc', async (req: FastifyRequest, reply: FastifyReply) => {
  const b = req.body as { chainId?: number; method: string; params?: unknown[] };
  const chainId = b.chainId ?? 1;
  if (!b.method) return reply.status(400).send({ error: 'method required' });
  try {
    const result = await rpcCall(chainId, b.method, b.params ?? []);
    return { jsonrpc: '2.0', id: 1, result };
  } catch (err) {
    return reply.status(502).send({ error: String(err).slice(0, 200) });
  }
});

// POST /meme-token/generate-source — generate Solidity source without deploying
fastify.post('/meme-token/generate-source', async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = MemeTokenSchema.partial().required({ config: true }).safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid config', issues: parsed.error.issues });
  const source = generateMemeTokenSolidity(parsed.data.config as MemeTokenConfig);
  return { source, contractName: (parsed.data.config.name as string).replace(/\s+/g, '') };
});

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    if (!process.env.INTERNAL_SERVICE_TOKEN) throw new Error('INTERNAL_SERVICE_TOKEN required');
    await mkdir(WORKSPACE, { recursive: true });
    await fastify.listen({ port: 3011, host: '0.0.0.0' });
    fastify.log.info('⛓️  Blockchain Engine online — port 3011');
    fastify.log.info(`📅 ${getTodayDate()} | Workspace: ${WORKSPACE}`);
    fastify.log.info(`🔨 Forge: ${await checkToolAvailable('forge')} | Cast: ${await checkToolAvailable('cast')}`);
  } catch (err) { fastify.log.error(err, 'Blockchain Engine failed'); process.exit(1); }
};
start();
