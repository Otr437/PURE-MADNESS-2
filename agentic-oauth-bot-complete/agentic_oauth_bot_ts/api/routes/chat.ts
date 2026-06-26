// api/routes/chat.ts — POST /chat — run the agent orchestrator for a task.

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runOrchestrator } from '../../agent/orchestrator';
import { requireBotApiSecret } from '../middleware';

const router = Router();

router.post('/', requireBotApiSecret, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task, sessionId } = req.body as { task?: string; sessionId?: string };

    if (!task || typeof task !== 'string' || !task.trim()) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'task is required' });
      return;
    }
    if (task.length > 10_000) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'task exceeds maximum length of 10000 characters' });
      return;
    }

    const sid    = sessionId ?? uuidv4();
    const result = await runOrchestrator(task.trim(), sid);

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
