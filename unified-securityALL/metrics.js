import client from 'prom-client';

const register = new client.Registry();

// Default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Custom WAF metrics
export const metrics = {
  requestsTotal: new client.Counter({
    name: 'waf_requests_total',
    help: 'Total number of requests processed',
    registers: [register]
  }),
  
  requestsAllowed: new client.Counter({
    name: 'waf_requests_allowed',
    help: 'Number of requests allowed through',
    registers: [register]
  }),
  
  requestsBlocked: new client.Counter({
    name: 'waf_requests_blocked',
    help: 'Number of requests blocked',
    registers: [register]
  }),
  
  sqlInjectionBlocked: new client.Counter({
    name: 'waf_sql_injection_blocked',
    help: 'SQL injection attacks blocked',
    registers: [register]
  }),
  
  xssBlocked: new client.Counter({
    name: 'waf_xss_blocked',
    help: 'XSS attacks blocked',
    registers: [register]
  }),
  
  pathTraversalBlocked: new client.Counter({
    name: 'waf_path_traversal_blocked',
    help: 'Path traversal attacks blocked',
    registers: [register]
  }),
  
  commandInjectionBlocked: new client.Counter({
    name: 'waf_command_injection_blocked',
    help: 'Command injection attacks blocked',
    registers: [register]
  }),
  
  xxeBlocked: new client.Counter({
    name: 'waf_xxe_blocked',
    help: 'XXE attacks blocked',
    registers: [register]
  }),
  
  ssrfBlocked: new client.Counter({
    name: 'waf_ssrf_blocked',
    help: 'SSRF attacks blocked',
    registers: [register]
  }),
  
  rateLimitsTriggered: new client.Counter({
    name: 'waf_rate_limits_triggered',
    help: 'Rate limits triggered',
    registers: [register]
  }),
  
  customRulesTriggered: new client.Counter({
    name: 'waf_custom_rules_triggered',
    help: 'Custom rules triggered',
    registers: [register]
  }),
  
  responseTime: new client.Histogram({
    name: 'waf_response_time_seconds',
    help: 'Response time in seconds',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [register]
  }),
  
  activeBlocks: new client.Gauge({
    name: 'waf_active_blocks',
    help: 'Number of currently blocked IPs',
    registers: [register]
  })
};

export function setupMetrics() {
  console.log('✓ Prometheus metrics configured');
}

export function getMetricsRegistry() {
  return register;
}
