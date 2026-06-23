import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { config } from './config.js';
import { initDatabase } from './database.js';
import { wafMiddleware } from './middleware/waf.js';
import { setupRoutes } from './routes/admin.js';
import { setupMetrics } from './metrics.js';
import { logger } from './utils/logger.js';

const fastify = Fastify({
  logger: config.isDevelopment ? true : {
    level: 'info',
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          ip: request.ip
        };
      }
    }
  },
  trustProxy: true,
  bodyLimit: config.maxRequestSize
});

// Initialize database
await initDatabase();

// Setup metrics
setupMetrics();

// Register plugins
await fastify.register(cors, {
  origin: config.allowedOrigins || true
});

await fastify.register(sensible);

// Global rate limiting
await fastify.register(rateLimit, {
  max: config.rateLimitRequests,
  timeWindow: config.rateLimitWindow * 1000,
  ban: config.rateLimitBan,
  skipOnError: false,
  keyGenerator: (request) => request.ip,
  errorResponseBuilder: (request, context) => {
    return {
      code: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.after / 1000)} seconds`,
      retryAfter: context.after
    };
  }
});

// WAF Middleware - This is where the magic happens
fastify.addHook('onRequest', wafMiddleware);

// Setup admin routes
setupRoutes(fastify);

// Proxy handler for all other routes
fastify.all('/*', async (request, reply) => {
  // In production, this would proxy to your backend services
  // For now, return success to show the request passed WAF validation
  return {
    message: 'Request passed WAF validation',
    method: request.method,
    path: request.url,
    timestamp: Date.now()
  };
});

// Error handler
fastify.setErrorHandler((error, request, reply) => {
  if (error.statusCode === 429) {
    logger.warn(`Rate limit exceeded for ${request.ip}`);
  } else {
    logger.error(error);
  }
  reply.send(error);
});

// Graceful shutdown
const closeGracefully = async (signal) => {
  logger.info(`Received ${signal}, closing server...`);
  await fastify.close();
  process.exit(0);
};

process.on('SIGTERM', closeGracefully);
process.on('SIGINT', closeGracefully);

// Start server
try {
  await fastify.listen({
    port: config.port,
    host: config.host
  });
  
  logger.info(`
╔═══════════════════════════════════════════╗
║   WAF Microservice (JavaScript/Node.js)   ║
║   Version: 1.0.0                          ║
║   Port: ${config.port}                              ║
║   Environment: ${config.isDevelopment ? 'development' : 'production'}               ║
╚═══════════════════════════════════════════╝
  `);
  
  logger.info('WAF is ready to protect your services! 🛡️');
  logger.info(`Admin API: http://localhost:${config.port}/waf/`);
  logger.info(`Metrics: http://localhost:${config.port}/waf/metrics`);
  
} catch (err) {
  logger.error('Failed to start server:', err);
  process.exit(1);
}
