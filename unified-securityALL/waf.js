import { detectSqlInjection } from '../detectors/sql-injection.js';
import { detectXss } from '../detectors/xss.js';
import { detectPathTraversal } from '../detectors/path-traversal.js';
import { detectCommandInjection } from '../detectors/command-injection.js';
import { detectXxe } from '../detectors/xxe.js';
import { detectSsrf } from '../detectors/ssrf.js';
import { checkRules } from '../rules/engine.js';
import { isWhitelisted, isBlocked, blockIp } from '../database.js';
import { logAttack } from '../utils/logger.js';
import { metrics } from '../metrics.js';
import { config } from '../config.js';

const ATTACK_TYPES = {
  SQL_INJECTION: 'SQL_INJECTION',
  XSS: 'XSS',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  COMMAND_INJECTION: 'COMMAND_INJECTION',
  XXE: 'XXE',
  SSRF: 'SSRF',
  INVALID_INPUT: 'INVALID_INPUT',
  LARGE_PAYLOAD: 'LARGE_PAYLOAD',
  SUSPICIOUS_HEADERS: 'SUSPICIOUS_HEADERS'
};

const SEVERITY = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO'
};

export async function wafMiddleware(request, reply) {
  const startTime = Date.now();
  const ip = request.ip;
  const method = request.method;
  const path = request.url;
  
  // Skip WAF for admin endpoints
  if (path.startsWith('/waf/')) {
    return;
  }
  
  // Check whitelist
  if (isWhitelisted(ip)) {
    metrics.requestsAllowed.inc();
    return;
  }
  
  // Check if IP is blocked
  const blockInfo = isBlocked(ip);
  if (blockInfo) {
    const now = Date.now() / 1000;
    if (now < blockInfo.unblock_at) {
      metrics.requestsBlocked.inc();
      logAttack({
        ip,
        attackType: 'BLOCKED_IP',
        severity: SEVERITY.HIGH,
        method,
        path,
        userAgent: request.headers['user-agent'] || 'unknown',
        payload: '',
        blocked: true,
        details: `IP blocked: ${blockInfo.reason}`
      });
      
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Your IP has been blocked',
        reason: blockInfo.reason
      });
    }
  }
  
  // Get request data
  const query = new URL(path, 'http://localhost').search;
  const body = request.body ? JSON.stringify(request.body) : '';
  const headers = request.headers;
  
  // Check URL length
  if (path.length > config.maxUrlLength) {
    metrics.requestsBlocked.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.LARGE_PAYLOAD,
      SEVERITY.MEDIUM,
      method,
      path,
      headers,
      `URL too long: ${path.length} bytes`,
      '',
      reply
    );
    return;
  }
  
  // Check body size (already handled by Fastify bodyLimit, but double-check)
  if (body.length > config.maxRequestSize) {
    metrics.requestsBlocked.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.LARGE_PAYLOAD,
      SEVERITY.MEDIUM,
      method,
      path,
      headers,
      `Request too large: ${body.length} bytes`,
      body.substring(0, 100),
      reply
    );
    return;
  }
  
  // SQL Injection detection
  const sqlAttack = detectSqlInjection(query, body);
  if (sqlAttack) {
    metrics.sqlInjectionBlocked.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.SQL_INJECTION,
      SEVERITY.CRITICAL,
      method,
      path,
      headers,
      sqlAttack.details,
      sqlAttack.payload,
      reply
    );
    return;
  }
  
  // XSS detection
  const xssAttack = detectXss(query, body, headers);
  if (xssAttack) {
    metrics.xssBlocked.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.XSS,
      SEVERITY.CRITICAL,
      method,
      path,
      headers,
      xssAttack.details,
      xssAttack.payload,
      reply
    );
    return;
  }
  
  // Path Traversal detection
  const pathAttack = detectPathTraversal(path, query);
  if (pathAttack) {
    metrics.pathTraversalBlocked.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.PATH_TRAVERSAL,
      SEVERITY.HIGH,
      method,
      path,
      headers,
      pathAttack.details,
      pathAttack.payload,
      reply
    );
    return;
  }
  
  // Command Injection detection
  const cmdAttack = detectCommandInjection(query, body);
  if (cmdAttack) {
    metrics.commandInjectionBlocked.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.COMMAND_INJECTION,
      SEVERITY.CRITICAL,
      method,
      path,
      headers,
      cmdAttack.details,
      cmdAttack.payload,
      reply
    );
    return;
  }
  
  // XXE detection
  const xxeAttack = detectXxe(body);
  if (xxeAttack) {
    metrics.xxeBlocked.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.XXE,
      SEVERITY.HIGH,
      method,
      path,
      headers,
      xxeAttack.details,
      xxeAttack.payload,
      reply
    );
    return;
  }
  
  // SSRF detection
  const ssrfAttack = detectSsrf(query, body);
  if (ssrfAttack) {
    metrics.ssrfBlocked.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.SSRF,
      SEVERITY.HIGH,
      method,
      path,
      headers,
      ssrfAttack.details,
      ssrfAttack.payload,
      reply
    );
    return;
  }
  
  // Custom rules check
  const ruleViolation = await checkRules(method, path, headers, body, ip);
  if (ruleViolation) {
    metrics.customRulesTriggered.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.INVALID_INPUT,
      SEVERITY.HIGH,
      method,
      path,
      headers,
      `Rule violation: ${ruleViolation.ruleName}`,
      '',
      reply,
      ruleViolation.banDuration
    );
    return;
  }
  
  // Check for suspicious user agents
  const userAgent = headers['user-agent'] || '';
  const suspiciousAgents = [
    'sqlmap', 'nikto', 'nmap', 'masscan', 'nessus', 
    'burp', 'metasploit', 'havij', 'acunetix', 'w3af'
  ];
  
  if (suspiciousAgents.some(agent => userAgent.toLowerCase().includes(agent))) {
    metrics.requestsBlocked.inc();
    await handleAttack(
      ip,
      ATTACK_TYPES.SUSPICIOUS_HEADERS,
      SEVERITY.HIGH,
      method,
      path,
      headers,
      'Suspicious user agent detected',
      userAgent,
      reply
    );
    return;
  }
  
  // Request passed all checks
  metrics.requestsAllowed.inc();
  const responseTime = Date.now() - startTime;
  metrics.responseTime.observe(responseTime / 1000);
}

async function handleAttack(ip, attackType, severity, method, path, headers, details, payload, reply, customBanDuration = null) {
  const banDuration = customBanDuration || config.attackBanDuration;
  
  // Block IP
  blockIp(ip, `${attackType}: ${details}`, banDuration);
  
  // Log attack
  logAttack({
    ip,
    attackType,
    severity,
    method,
    path,
    userAgent: headers['user-agent'] || 'unknown',
    payload: payload.substring(0, 500),
    blocked: true,
    details
  });
  
  metrics.requestsBlocked.inc();
  
  return reply.code(403).send({
    error: 'Forbidden',
    message: 'Malicious request detected and blocked',
    attackType,
    bannedFor: `${banDuration} seconds`
  });
}
