// api/middleware.ts — Express middleware: logging, auth, error handling.

import { Request, Response, NextFunction } from 'express';
import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { extractBearerToken, verifyToken } from '../auth/validator';
import { AuthError } from '../auth/exceptions';
import { config } from '../config';

// ─── Logger ───────────────────────────────────────────────────────────────────

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: 'agentic-oauth-bot' },
  transports:  [new winston.transports.Console()],
});

// ─── Request ID ───────────────────────────────────────────────────────────────

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const upstream = req.headers['x-request-id'];
  const id = typeof upstream === 'string' && /^[\w\-]{8,64}$/.test(upstream) ? upstream : uuidv4();
  (req as Request & { id: string }).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

export function requireBotApiSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-bot-api-secret'];
  if (secret !== config.BOT_API_SECRET) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid bot API secret' });
    return;
  }
  next();
}

export function requireAuth0Token(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Bearer token required' });
    return;
  }
  verifyToken(token)
    .then(claims => {
      (req as Request & { user: typeof claims }).user = claims;
      next();
    })
    .catch(err => {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.code, message: err.message });
      } else {
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Token verification failed' });
      }
    });
}

// ─── Error handler ────────────────────────────────────────────────────────────

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  logger.error('Unhandled error', { error: message, path: req.path, method: req.method });
  res.status(500).json({ error: 'INTERNAL_ERROR', message: config.NODE_ENV === 'production' ? 'An error occurred' : message });
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ error: 'NOT_FOUND', message: `Cannot ${req.method} ${req.originalUrl}` });
}
