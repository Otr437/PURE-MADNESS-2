// main.ts — Entry point. Runs dependency checks then starts the Express server.

import { config } from './config';
import { createApp } from './api/server';
import { checkAllDependencies } from './api/dependencies';
import { logger } from './api/middleware';

async function main(): Promise<void> {
  logger.info('Starting agentic-oauth-bot', {
    agentId:   config.AGENT_ID,
    agentName: config.AGENT_NAME,
    port:      config.PORT,
    env:       config.NODE_ENV,
  });

  // Fail fast if critical dependencies are not available
  const { allOk, results } = await checkAllDependencies();

  if (!allOk) {
    const failed = results.filter(r => !r.ok).map(r => `${r.name}: ${r.detail}`).join('\n');
    logger.error('One or more dependencies failed — aborting startup', { failed });
    process.exit(1);
  }

  const app = createApp();

  const server = app.listen(config.PORT, () => {
    logger.info('Bot API server listening', {
      port:       config.PORT,
      agentId:    config.AGENT_ID,
      jwksUrl:    `http://localhost:${config.PORT}/.well-known/jwks.json`,
      chatUrl:    `http://localhost:${config.PORT}/chat`,
      healthUrl:  `http://localhost:${config.PORT}/admin/health`,
    });
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — exiting', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
