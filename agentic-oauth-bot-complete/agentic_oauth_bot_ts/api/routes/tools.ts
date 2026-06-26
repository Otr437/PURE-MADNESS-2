// api/routes/tools.ts — GET /tools — list available tools; POST /tools/:name — execute one.

import { Router, Request, Response, NextFunction } from 'express';
import { TOOLS, executeTool } from '../../agent/tools';
import { requireBotApiSecret } from '../middleware';

const router = Router();

router.get('/', requireBotApiSecret, (_req: Request, res: Response) => {
  res.status(200).json({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, schema: t.input_schema })) });
});

router.post('/:name', requireBotApiSecret, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const args = (req.body ?? {}) as Record<string, unknown>;
    const result = await executeTool(name, args);
    res.status(200).json({ success: true, tool: name, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Unknown tool')) {
      res.status(404).json({ error: 'NOT_FOUND', message });
      return;
    }
    next(err);
  }
});

export default router;
