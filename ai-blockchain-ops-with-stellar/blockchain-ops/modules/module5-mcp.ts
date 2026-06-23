// ============================================================
// MODULE 5: MCP SERVER
// Agent tools: web_fetch, package_lookup, run_typescript,
//              read_file, cast_call, eth_rpc, forge_build,
//              simulate_tx, abi_decode
// Port: 3005
// ============================================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import crypto from 'crypto';
import { McpTool, McpCallRequest, McpCallResult, McpToolCall, HealthStatus } from '../shared/types.js';
import { getTodayISO, getTodayDate, fetchWithTimeout } from '../shared/date-utils.js';
import { getServiceUrl, internalFetch, verifyInternalToken, INTERNAL_HEADER } from '../shared/registry.js';

const SERVICE_START = Date.now();

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: () => crypto.randomUUID(),
  requestTimeout: 60_000,
});

await fastify.register(cors, { origin: process.env.ALLOWED_ORIGIN ?? '*' });
await fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' });

fastify.addContentTypeParser('application/json', { parseAs: 'string' },
  (_req: FastifyRequest, body: unknown, done: (e: Error | null, r?: unknown) => void) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  }
);

fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.url === '/health' || req.url === '/tools' || req.method === 'OPTIONS') return;
  if (!verifyInternalToken(req.headers[INTERNAL_HEADER] as string)) {
    return reply.status(401).send({ error: 'Internal token required' });
  }
});

const TOOLS: McpTool[] = [
  {
    name: 'web_fetch',
    description: 'Fetch text content of an HTTPS URL. Verify docs, API schemas, release notes.',
    inputSchema: { url: { type: 'string' } },
  },
  {
    name: 'package_lookup',
    description: 'Look up latest version and publish date of an npm package. Verify it is current.',
    inputSchema: { packageName: { type: 'string' } },
  },
  {
    name: 'run_typescript',
    description: 'Execute a TypeScript snippet in a sandboxed environment. Returns stdout.',
    inputSchema: { code: { type: 'string' } },
  },
  {
    name: 'read_file',
    description: 'Read a file from /workspace.',
    inputSchema: { path: { type: 'string' } },
  },
  {
    name: 'cast_call',
    description: 'Call a read-only function on a deployed smart contract using Foundry cast. No gas needed.',
    inputSchema: {
      contractAddress: { type: 'string' },
      functionSig: { type: 'string', description: 'e.g. "balanceOf(address)(uint256)"' },
      args: { type: 'array', items: { type: 'string' } },
      rpcUrl: { type: 'string', description: 'RPC URL or chain name' },
    },
  },
  {
    name: 'eth_rpc',
    description: 'Make a raw JSON-RPC call to any EVM chain. Use for eth_call, eth_getBalance, etc.',
    inputSchema: {
      rpcUrl: { type: 'string' },
      method: { type: 'string' },
      params: { type: 'array' },
    },
  },
  {
    name: 'forge_build',
    description: 'Compile a Solidity contract using Foundry forge. Returns ABI and bytecode.',
    inputSchema: {
      source: { type: 'string', description: 'Full Solidity source code' },
      contractName: { type: 'string' },
      solidityVersion: { type: 'string', description: 'e.g. 0.8.24' },
    },
  },
  {
    name: 'abi_decode',
    description: 'Decode ABI-encoded calldata or return data given a function signature.',
    inputSchema: {
      data: { type: 'string', description: 'Hex-encoded data to decode' },
      types: { type: 'array', items: { type: 'string' }, description: 'ABI types, e.g. ["address","uint256"]' },
    },
  },
  {
    name: 'gas_estimate',
    description: 'Get current gas prices for any supported EVM chain.',
    inputSchema: {
      chainId: { type: 'number' },
    },
  },
];

const ToolCallSchema = z.object({
  taskId: z.string().uuid(),
  toolName: z.string().min(1),
  input: z.record(z.unknown()),
});

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(execFile);

  switch (name) {
    case 'web_fetch': {
      const url = String(input['url'] ?? '');
      if (!url.startsWith('https://')) throw new Error('Only HTTPS URLs are permitted');
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'aiops-mcp/1.0' } }, 15_000);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return (await res.text()).slice(0, 10_000);
    }

    case 'package_lookup': {
      const pkg = encodeURIComponent(String(input['packageName'] ?? ''));
      const res = await fetchWithTimeout(`https://registry.npmjs.org/${pkg}/latest`, {}, 10_000);
      if (!res.ok) throw new Error(`Package not found: ${String(input['packageName'])}`);
      const data = await res.json() as Record<string, unknown>;
      return JSON.stringify({
        name: data['name'], version: data['version'],
        publishedAt: data['_time'] ?? 'unknown',
        description: String(data['description'] ?? '').slice(0, 200),
        deprecated: data['deprecated'] ?? false,
        license: data['license'] ?? 'unknown',
      }, null, 2);
    }

    case 'run_typescript': {
      const { writeFile, unlink } = await import('fs/promises');
      const { join } = await import('path');
      const tsCode = String(input['code'] ?? '');
      if (tsCode.length > 10_000) throw new Error('Code too large — max 10KB');
      const tmpFile = join('/tmp', `mcp_ts_${crypto.randomUUID()}.ts`);
      try {
        await writeFile(tmpFile, tsCode, 'utf-8');
        try {
          const { stdout, stderr } = await execAsync('npx', ['--yes', 'tsx', tmpFile], {
            timeout: 8_000, maxBuffer: 512 * 1024,
            env: { ...process.env, NODE_ENV: 'production' },
          });
          return ((stdout || stderr || '(no output)')).slice(0, 5_000);
        } catch {
          // tsx not available — strip TS syntax for simple snippets
          const jsCode = tsCode
            .replace(/^\s*import\s+type\s+.*?;\s*$/gm, '')
            .replace(/:\s*(string|number|boolean|void|unknown|any|never|null|undefined|object)(\[\])?\b/g, '')
            .replace(/\bas\s+\w+/g, '');
          const { stdout, stderr } = await execAsync(
            process.execPath, ['--input-type=module'],
            { input: jsCode, timeout: 5_000, maxBuffer: 512 * 1024 }
          );
          return (stdout || stderr || '(no output)').slice(0, 5_000);
        }
      } finally {
        await unlink(tmpFile).catch(() => { });
      }
    }

    case 'read_file': {
      const { readFile } = await import('fs/promises');
      const { resolve } = await import('path');
      const workspace = '/workspace';
      const safePath = resolve(workspace, String(input['path'] ?? ''));
      if (!safePath.startsWith(resolve(workspace))) throw new Error('Path traversal not allowed');
      return (await readFile(safePath, 'utf-8')).slice(0, 20_000);
    }

    case 'cast_call': {
      // Use Foundry cast to call a read-only contract function
      const addr = String(input['contractAddress'] ?? '');
      const sig = String(input['functionSig'] ?? '');
      const args = Array.isArray(input['args']) ? input['args'].map(String) : [];
      const rpcUrl = String(input['rpcUrl'] ?? 'http://127.0.0.1:8545');
      if (!addr.startsWith('0x')) throw new Error('Invalid contract address');

      const castArgs = ['call', addr, sig, ...args, '--rpc-url', rpcUrl];
      try {
        const { stdout, stderr } = await execAsync('cast', castArgs, { timeout: 15_000 });
        return (stdout || stderr || '(empty result)').trim();
      } catch (err) {
        // cast not available — fall back to eth_call
        const selector = sig.split('(')[0];
        throw new Error(`cast not available (${selector}): install Foundry for contract calls. Error: ${String(err).slice(0, 200)}`);
      }
    }

    case 'eth_rpc': {
      const rpcUrl = String(input['rpcUrl'] ?? 'http://127.0.0.1:8545');
      const method = String(input['method'] ?? '');
      const params = Array.isArray(input['params']) ? input['params'] : [];
      if (!method) throw new Error('method required');
      const res = await fetchWithTimeout(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }, 15_000);
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const data = await res.json() as { result?: unknown; error?: { message: string } };
      if (data.error) throw new Error(`RPC error: ${data.error.message}`);
      return JSON.stringify(data.result, null, 2);
    }

    case 'forge_build': {
      const { writeFile, readFile, mkdir, rm } = await import('fs/promises');
      const { join } = await import('path');
      const { existsSync } = await import('fs');

      const source = String(input['source'] ?? '');
      const contractName = String(input['contractName'] ?? 'Contract');
      const dir = join('/tmp', `forge_${crypto.randomUUID()}`);
      const srcFile = join(dir, `${contractName}.sol`);
      const outDir = join(dir, 'out');

      try {
        await mkdir(dir, { recursive: true });
        await writeFile(srcFile, source, 'utf-8');
        await execAsync('forge', ['build', '--contracts', srcFile, '--out', outDir, '--json'], {
          timeout: 60_000, cwd: dir,
        });
        const artifactPath = join(outDir, `${contractName}.sol`, `${contractName}.json`);
        if (!existsSync(artifactPath)) throw new Error('Artifact not found after compilation');
        const artifact = JSON.parse(await readFile(artifactPath, 'utf-8')) as {
          abi: unknown[]; bytecode: { object: string };
        };
        return JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode.object.slice(0, 500) + '...' }, null, 2);
      } catch (err) {
        throw new Error(`forge build failed: ${String(err).slice(0, 500)}`);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => { });
      }
    }

    case 'abi_decode': {
      const data = String(input['data'] ?? '');
      const types = Array.isArray(input['types']) ? input['types'].map(String) : [];
      if (!data.startsWith('0x')) throw new Error('data must be hex');
      if (!types.length) throw new Error('types array required');

      try {
        const castArgs = ['--abi-decode', `decode(${types.join(',')})`, data];
        const { stdout } = await execAsync('cast', castArgs, { timeout: 5_000 });
        return stdout.trim();
      } catch {
        // Manual decode using ethers
        const { ethers } = await import('ethers');
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, data);
        return JSON.stringify(decoded.map(v => v.toString()), null, 2);
      }
    }

    case 'gas_estimate': {
      const chainId = Number(input['chainId'] ?? 1);
      const res = await internalFetch('module11-blockchain', `/gas?chainId=${chainId}`, {}, 10_000);
      if (!res.ok) throw new Error(`Gas estimate failed: ${res.status}`);
      const gas = await res.json();
      return JSON.stringify(gas, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Tool call metrics ─────────────────────────────────────────

const toolMetrics = new Map<string, { calls: number; failures: number; totalDurationMs: number; lastCalledAt: string }>();
function trackToolCall(toolName: string, success: boolean, durationMs: number) {
  const m = toolMetrics.get(toolName) ?? { calls: 0, failures: 0, totalDurationMs: 0, lastCalledAt: '' };
  m.calls++;
  if (!success) m.failures++;
  m.totalDurationMs += durationMs;
  m.lastCalledAt = getTodayISO();
  toolMetrics.set(toolName, m);
}

// ── Recent call history ring buffer ──────────────────────────

interface CallRecord {
  callId: string; taskId: string; toolName: string;
  success: boolean; durationMs: number; calledAt: string;
  error?: string; inputSummary: string;
}
const callHistory: CallRecord[] = [];
function recordCall(c: CallRecord) {
  callHistory.unshift(c);
  if (callHistory.length > 200) callHistory.pop();
}

async function emitEvent(type: 'mcp.tool_called' | 'mcp.tool_failed', call: McpToolCall) {
  try {
    await internalFetch('module9-events', '/emit', {
      method: 'POST',
      body: JSON.stringify({ type, source: 'module5-mcp', payload: call, taskId: call.taskId }),
    }, 3_000);
  } catch { /* best-effort */ }
}

async function persistCall(call: McpToolCall) {
  try {
    await internalFetch('module6-database', '/mcp-calls', {
      method: 'POST',
      body: JSON.stringify(call),
    }, 3_000);
  } catch { /* best-effort */ }
}

const BatchCallSchema = z.object({
  taskId: z.string().uuid(),
  calls: z.array(z.object({
    toolName: z.string().min(1),
    input: z.record(z.unknown()),
  })).min(1).max(5),
  parallel: z.boolean().default(false),
});

fastify.get('/health', async (): Promise<HealthStatus> => ({
  service: 'module5-mcp', status: 'online',
  date: getTodayDate(), timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  dependencies: { gate: getServiceUrl('module1-relevance-gate'), database: getServiceUrl('module6-database'), events: getServiceUrl('module9-events'), blockchain: getServiceUrl('module11-blockchain') },
}));

fastify.get('/tools', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const search = q['search']?.toLowerCase();
  const tools = search ? TOOLS.filter(t => t.name.includes(search) || t.description.toLowerCase().includes(search)) : TOOLS;
  return { tools, count: tools.length, date: getTodayDate() };
});

fastify.get('/tools/:toolName', async (req: FastifyRequest<{ Params: { toolName: string } }>, reply: FastifyReply) => {
  const tool = TOOLS.find(t => t.name === req.params.toolName);
  if (!tool) return reply.status(404).send({ error: `Tool '${req.params.toolName}' not found`, available: TOOLS.map(t => t.name) });
  const metrics = toolMetrics.get(tool.name);
  return { ...tool, metrics: metrics ?? null };
});

fastify.get('/metrics', async () => ({
  service: 'module5-mcp', timestamp: getTodayISO(),
  uptime: Math.floor((Date.now() - SERVICE_START) / 1000),
  tools: TOOLS.map(t => {
    const m = toolMetrics.get(t.name);
    return { name: t.name, calls: m?.calls ?? 0, failures: m?.failures ?? 0, successRate: m?.calls ? ((1 - m.failures / m.calls) * 100).toFixed(1) + '%' : 'N/A', avgDurationMs: m?.calls ? Math.round(m.totalDurationMs / m.calls) : 0, lastCalledAt: m?.lastCalledAt ?? null };
  }),
  totalCalls: [...toolMetrics.values()].reduce((s, m) => s + m.calls, 0),
}));

fastify.get('/history', async (req: FastifyRequest) => {
  const q = req.query as Record<string, string>;
  const limit = Math.min(parseInt(q['limit'] ?? '50'), 200);
  const toolName = q['tool'];
  let history = callHistory;
  if (toolName) history = history.filter(c => c.toolName === toolName);
  return { total: history.length, calls: history.slice(0, limit) };
});

fastify.post('/call', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = ToolCallSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const { taskId, toolName, input } = parsed.data;
  const callId = crypto.randomUUID();
  const t0 = Date.now();

  if (!TOOLS.find(t => t.name === toolName)) {
    return reply.status(404).send({ error: `Tool '${toolName}' not found`, available: TOOLS.map(t => t.name) });
  }

  let output = '';
  let success = true;
  let errorMsg: string | undefined;

  try {
    output = await executeTool(toolName, input as Record<string, unknown>);

    // Gate-check tool output before Claude sees it
    const gateRes = await internalFetch('module1-relevance-gate', '/check', {
      method: 'POST',
      body: JSON.stringify({ content: output, contentType: 'output', submittedBy: 'mcp', taskId }),
    }, 20_000);
    const gate = await gateRes.json() as { approved: boolean; reason: string };
    if (!gate.approved) {
      output = `[GATE BLOCKED] Tool output rejected: ${gate.reason}`;
      success = false;
    }
  } catch (err) {
    success = false;
    errorMsg = String(err).slice(0, 300);
    fastify.log.error({ requestId, taskId, toolName, err }, 'Tool execution failed');
  }

  const durationMs = Date.now() - t0;
  trackToolCall(toolName, success, durationMs);

  const call: McpToolCall = {
    callId, taskId, toolName,
    input: input as Record<string, unknown>,
    output: success ? output : undefined,
    error: errorMsg,
    calledAt: new Date(t0).toISOString(),
    completedAt: getTodayISO(),
    durationMs,
  };

  recordCall({ callId, taskId, toolName, success, durationMs, calledAt: call.calledAt, error: errorMsg, inputSummary: JSON.stringify(input).slice(0, 100) });
  void persistCall(call);
  void emitEvent(success ? 'mcp.tool_called' : 'mcp.tool_failed', call);

  return reply.status(success ? 200 : 422).send({
    callId, success,
    output: success ? output : (errorMsg ?? 'Tool failed'),
    durationMs,
  } satisfies McpCallResult);
});

// POST /batch — run multiple tools in sequence or parallel
fastify.post('/batch', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = BatchCallSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues });

  const { taskId, calls, parallel } = parsed.data;

  async function runCall(toolCall: { toolName: string; input: Record<string, unknown> }) {
    const callId = crypto.randomUUID();
    const t0 = Date.now();
    if (!TOOLS.find(t => t.name === toolCall.toolName)) {
      return { callId, toolName: toolCall.toolName, success: false, output: `Tool '${toolCall.toolName}' not found`, durationMs: 0 };
    }
    try {
      const output = await executeTool(toolCall.toolName, toolCall.input);
      const durationMs = Date.now() - t0;
      trackToolCall(toolCall.toolName, true, durationMs);
      void persistCall({ callId, taskId, toolName: toolCall.toolName, input: toolCall.input, output, calledAt: new Date(t0).toISOString(), completedAt: getTodayISO(), durationMs });
      return { callId, toolName: toolCall.toolName, success: true, output, durationMs };
    } catch (err) {
      const durationMs = Date.now() - t0;
      trackToolCall(toolCall.toolName, false, durationMs);
      return { callId, toolName: toolCall.toolName, success: false, output: String(err).slice(0, 300), durationMs };
    }
  }

  let results: Awaited<ReturnType<typeof runCall>>[];
  if (parallel) {
    results = await Promise.all(calls.map(c => runCall(c as { toolName: string; input: Record<string, unknown> })));
  } else {
    results = [];
    for (const c of calls) {
      results.push(await runCall(c as { toolName: string; input: Record<string, unknown> }));
    }
  }

  const allSuccess = results.every(r => r.success);
  return reply.status(allSuccess ? 200 : 207).send({ taskId, parallel, results, summary: { total: results.length, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length } });
});

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    await fastify.listen({ port: 3005, host: '0.0.0.0' });
    fastify.log.info('🔧 MCP Server online — port 3005');
    fastify.log.info(`📅 ${getTodayDate()} | Tools: ${TOOLS.map(t => t.name).join(', ')}`);
  } catch (err) { fastify.log.error(err, 'MCP failed to start'); process.exit(1); }
};
start();
    fastify.log.error({ requestId, taskId, toolName, err: errorMsg }, 'Tool execution failed');
  }

  const durationMs = Date.now() - t0;
  trackToolCall(toolName, success, durationMs);
  recordCall({ callId, taskId, toolName, success, durationMs, calledAt: new Date(t0).toISOString(), error: errorMsg, inputSummary: JSON.stringify(input).slice(0, 100) });

  const call: McpToolCall = {
    callId, taskId, toolName,
    input: input as Record<string, unknown>,
    output: success ? output : undefined,
    error: errorMsg,
    calledAt: new Date(t0).toISOString(),
    completedAt: getTodayISO(),
    durationMs,
  };

  void persistCall(call);
  void emitEvent(success ? 'mcp.tool_called' : 'mcp.tool_failed', { callId, taskId, toolName, durationMs, success, outputBytes: output.length });

  fastify.log.info({ requestId, taskId, toolName, success, durationMs, outputBytes: output.length }, 'Tool call complete');

  return reply.status(success ? 200 : 422).send({
    callId, success,
    output: success ? output : (errorMsg ?? 'Tool failed'),
    durationMs,
    outputBytes: output.length,
  } satisfies McpCallResult);
});

// POST /batch — run multiple tools in sequence or parallel
fastify.post('/batch', async (req: FastifyRequest, reply: FastifyReply) => {
  const requestId = req.id as string;
  const parsed = BatchCallSchema.safeParse(req.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', issues: parsed.error.issues, requestId });

  const { taskId, calls, parallel } = parsed.data;

  async function runOne(toolCall: { toolName: string; input: Record<string, unknown> }) {
    const callId = crypto.randomUUID();
    const t0 = Date.now();
    if (!TOOLS.find(t => t.name === toolCall.toolName)) {
      return { callId, toolName: toolCall.toolName, success: false, output: `Tool '${toolCall.toolName}' not found`, durationMs: 0 };
    }
    try {
      const output = await executeTool(toolCall.toolName, toolCall.input);
      const durationMs = Date.now() - t0;
      trackToolCall(toolCall.toolName, true, durationMs);
      recordCall({ callId, taskId, toolName: toolCall.toolName, success: true, durationMs, calledAt: new Date(t0).toISOString(), inputSummary: JSON.stringify(toolCall.input).slice(0, 100) });
      void persistCall({ callId, taskId, toolName: toolCall.toolName, input: toolCall.input, output, calledAt: new Date(t0).toISOString(), completedAt: getTodayISO(), durationMs });
      return { callId, toolName: toolCall.toolName, success: true, output, durationMs };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const error = String(err).slice(0, 300);
      trackToolCall(toolCall.toolName, false, durationMs);
      recordCall({ callId, taskId, toolName: toolCall.toolName, success: false, durationMs, calledAt: new Date(t0).toISOString(), error, inputSummary: JSON.stringify(toolCall.input).slice(0, 100) });
      return { callId, toolName: toolCall.toolName, success: false, output: error, durationMs };
    }
  }

  let results: Awaited<ReturnType<typeof runOne>>[];
  if (parallel) {
    results = await Promise.all(calls.map(c => runOne(c as { toolName: string; input: Record<string, unknown> })));
  } else {
    results = [];
    for (const c of calls) {
      results.push(await runOne(c as { toolName: string; input: Record<string, unknown> }));
    }
  }

  const allSuccess = results.every(r => r.success);
  fastify.log.info({ requestId, taskId, total: results.length, succeeded: results.filter(r => r.success).length, parallel }, 'Batch call complete');

  return reply.status(allSuccess ? 200 : 207).send({
    taskId, parallel, results,
    summary: { total: results.length, succeeded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length },
  });
});

process.on('SIGTERM', async () => { await fastify.close(); process.exit(0); });
process.on('SIGINT', async () => { await fastify.close(); process.exit(0); });

const start = async () => {
  try {
    await fastify.listen({ port: 3005, host: '0.0.0.0' });
    fastify.log.info('🔧 MCP Server online — port 3005');
    fastify.log.info(`📅 ${getTodayDate()} | Tools: ${TOOLS.map(t => t.name).join(', ')}`);
    fastify.log.info(`⏱  Timeouts: ${Object.entries(TOOL_TIMEOUTS).map(([k, v]) => `${k}=${v}ms`).join(' | ')}`);
    fastify.log.info(`📦 Max output: ${MAX_OUTPUT_BYTES / 1024}KB per tool call`);
  } catch (err) { fastify.log.error(err, 'MCP failed to start'); process.exit(1); }
};
start();
