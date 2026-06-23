import { getMetricsRegistry } from '../metrics.js';
import * as db from '../database.js';
import validator from 'validator';

export function setupRoutes(fastify) {
  // Health check
  fastify.get('/waf/health', async () => {
    return {
      status: 'healthy',
      timestamp: Date.now(),
      version: '1.0.0',
      uptime: process.uptime()
    };
  });
  
  // Prometheus metrics
  fastify.get('/waf/metrics', async (request, reply) => {
    reply.header('Content-Type', getMetricsRegistry().contentType);
    return getMetricsRegistry().metrics();
  });
  
  // Statistics
  fastify.get('/waf/stats', async () => {
    return {
      ...db.getStats(),
      timestamp: Date.now()
    };
  });
  
  // Blocked IPs
  fastify.get('/waf/blocked-ips', async () => {
    const blockedIps = db.getBlockedIps();
    const now = Math.floor(Date.now() / 1000);
    
    return blockedIps.map(block => ({
      ip: block.ip_address,
      reason: block.reason,
      blocked_at: block.blocked_at,
      unblock_at: block.unblock_at,
      remaining_seconds: Math.max(0, block.unblock_at - now),
      block_count: block.block_count
    }));
  });
  
  // Whitelist
  fastify.get('/waf/whitelist', async () => {
    return db.getWhitelist().map(item => ({
      ip: item.ip_address,
      reason: item.reason,
      added_at: item.added_at
    }));
  });
  
  fastify.post('/waf/whitelist', {
    schema: {
      body: {
        type: 'object',
        required: ['ip', 'reason'],
        properties: {
          ip: { type: 'string' },
          reason: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { ip, reason } = request.body;
    
    // Validate IP
    if (!validator.isIP(ip)) {
      return reply.code(400).send({
        error: 'Invalid IP address'
      });
    }
    
    db.addToWhitelist(ip, reason);
    
    return {
      success: true,
      ip,
      reason
    };
  });
  
  fastify.delete('/waf/whitelist/:ip', async (request, reply) => {
    const { ip } = request.params;
    
    if (!validator.isIP(ip)) {
      return reply.code(400).send({
        error: 'Invalid IP address'
      });
    }
    
    db.removeFromWhitelist(ip);
    
    return {
      success: true,
      message: `IP ${ip} removed from whitelist`
    };
  });
  
  // Attack logs
  fastify.get('/waf/attack-logs', async (request) => {
    const limit = parseInt(request.query.limit || '100', 10);
    const logs = db.getAttackLogs(Math.min(limit, 1000));
    
    return logs.map(log => ({
      id: log.id,
      timestamp: log.timestamp,
      ip_address: log.ip_address,
      attack_type: log.attack_type,
      severity: log.severity,
      method: log.request_method,
      path: log.request_path,
      user_agent: log.user_agent,
      payload: log.payload,
      blocked: log.blocked === 1,
      details: log.details
    }));
  });
  
  // Custom rules
  fastify.get('/waf/rules', async () => {
    return db.getRules();
  });
  
  fastify.post('/waf/rules', {
    schema: {
      body: {
        type: 'object',
        required: ['rules'],
        properties: {
          rules: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'name', 'action', 'conditions'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                enabled: { type: 'boolean' },
                action: { type: 'string', enum: ['block', 'log', 'challenge'] },
                conditions: { type: 'array' },
                banDuration: { type: 'number' }
              }
            }
          }
        }
      }
    }
  }, async (request) => {
    const { rules } = request.body;
    
    // Clear existing rules and save new ones
    const existingRules = db.getRules();
    existingRules.forEach(rule => db.deleteRule(rule.id));
    
    rules.forEach(rule => db.saveRule(rule));
    
    return {
      success: true,
      message: `${rules.length} rules updated`
    };
  });
  
  fastify.delete('/waf/rules/:id', async (request) => {
    const { id } = request.params;
    db.deleteRule(id);
    
    return {
      success: true,
      message: `Rule ${id} deleted`
    };
  });
  
  // Clear all blocks
  fastify.post('/waf/clear-blocks', async () => {
    db.clearBlocks();
    
    return {
      success: true,
      message: 'All temporary blocks cleared'
    };
  });
  
  // Manual block IP
  fastify.post('/waf/block-ip', {
    schema: {
      body: {
        type: 'object',
        required: ['ip', 'reason'],
        properties: {
          ip: { type: 'string' },
          reason: { type: 'string' },
          duration: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { ip, reason, duration = 3600 } = request.body;
    
    if (!validator.isIP(ip)) {
      return reply.code(400).send({
        error: 'Invalid IP address'
      });
    }
    
    db.blockIp(ip, reason, duration);
    
    return {
      success: true,
      ip,
      reason,
      duration
    };
  });
  
  // Unblock IP
  fastify.delete('/waf/blocked-ips/:ip', async (request, reply) => {
    const { ip } = request.params;
    
    if (!validator.isIP(ip)) {
      return reply.code(400).send({
        error: 'Invalid IP address'
      });
    }
    
    const stmt = db.getDatabase().prepare('DELETE FROM blocked_ips WHERE ip_address = ?');
    stmt.run(ip);
    
    return {
      success: true,
      message: `IP ${ip} unblocked`
    };
  });
}
