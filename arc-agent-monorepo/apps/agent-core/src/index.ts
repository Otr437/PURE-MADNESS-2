import Fastify from 'fastify';
import { getConfig } from '@arc-agents/config';
import { AgentWalletManager } from '@arc-agents/wallet-client';
import { createLogger, initTelemetry } from '@arc-agents/observability';
import { AutonomousPurchaseAgent } from './agent/autonomous-agent.js';

const logger = createLogger('agent-core');
initTelemetry('agent-core');

const app = Fastify({ logger: false });
const agent = new AutonomousPurchaseAgent();
const walletManager = new AgentWalletManager();

// ─── Health ───────────────────────────────────────────────────────────────

app.get('/health', async () => ({ status: 'ok', service: 'agent-core', ts: new Date().toISOString() }));

// ─── Wallet Management ────────────────────────────────────────────────────

app.post('/wallets', async (req, reply) => {
  const body = req.body as any;
  const wallet = await walletManager.createAgentWallet({
    name: body.name,
    chain: body.chain ?? 'Arc_Testnet',
    description: body.description,
  });
  return reply.code(201).send({ success: true, data: wallet });
});

app.get('/wallets', async () => {
  const wallets = await walletManager.listWallets();
  return { success: true, data: wallets };
});

app.get<{ Params: { id: string } }>('/wallets/:id/balance', async (req, reply) => {
  const balance = await walletManager.getWalletBalance(req.params.id);
  return { success: true, data: balance };
});

// ─── Agent Execution ──────────────────────────────────────────────────────

app.post('/agent/run', async (req, reply) => {
  const { task, walletId, framework = 'langchain' } = req.body as any;

  if (!task || !walletId) {
    return reply.code(400).send({ success: false, error: 'task and walletId required' });
  }

  logger.info('Agent run requested', { task, walletId, framework });

  let action;
  switch (framework) {
    case 'anthropic':
      action = await agent.runAnthropic(task, walletId);
      break;
    case 'vercel':
      action = await agent.runVercelAI(task, walletId);
      break;
    case 'langchain':
    default:
      action = await agent.runLangChain(task, walletId);
  }

  return { success: true, data: action };
});

// ─── Boot ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '3001');

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    logger.error('Failed to start agent-core', { error: err.message });
    process.exit(1);
  }
  logger.info(`agent-core running`, { port: PORT });
});
