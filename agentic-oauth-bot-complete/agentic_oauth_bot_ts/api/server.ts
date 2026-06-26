// api/server.ts — Express application factory.
// Creates and configures the Express app without starting it.
// main.ts calls listen(); tests import the app directly.

import express, { Application } from 'express';
import { requestIdMiddleware, errorHandler, notFound, logger } from './middleware';
import routes from './routes/index';
import { jwksHandler } from '../crypto/jwks';

export function createApp(): Application {
  const app = express();

  // Body parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Request ID tracing on every request
  app.use(requestIdMiddleware);

  // Request logging
  app.use((req, _res, next) => {
    logger.info('Incoming request', { method: req.method, path: req.path, id: (req as typeof req & { id: string }).id });
    next();
  });

  // JWKS endpoint — public, no auth — so authorized-to-act can verify bot signatures
  app.get('/.well-known/jwks.json', jwksHandler);

  // All API routes mounted under /
  app.use('/', routes);

  // 404 and error handlers — must be last
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
