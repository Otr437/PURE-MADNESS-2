// api/routes/admin.ts — Admin endpoints: health, memory stats, token status.

import { Router, Request, Response } from 'express';
import { requireBotApiSecret } from '../middleware';
import { getMemoryStats } from '../../agent/memory';
import { getTokenStatus } from '../../auth/client';
import { config } from '../../config';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status:    'ok',
    agentId:   config.AGENT_ID,
    agentName: config.AGENT_NAME,
    timestamp: new Date().toISOString(),
  });
});

router.get('/status', requireBotApiSecret, (_req: Request, res: Response) => {
  const tokenStatus  = getTokenStatus();
  const memoryStatus = getMemoryStats();
  res.status(200).json({
    token:     tokenStatus,
    memory:    memoryStatus,
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

router.get('/jwks', async (_req: Request, res: Response) => {
  const { jwksHandler } = await import('../../crypto/jwks');
  return jwksHandler(_req, res);
});

export default router;
