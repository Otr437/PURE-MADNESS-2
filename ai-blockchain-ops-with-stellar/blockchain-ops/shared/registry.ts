// ============================================================
// SHARED: SERVICE REGISTRY
// ============================================================

export type ServiceName =
  | 'module1-relevance-gate'
  | 'module2-auditor'
  | 'module3-orchestrator'
  | 'module4-gateway'
  | 'module5-mcp'
  | 'module6-database'
  | 'module7-auth'
  | 'module8-secrets'
  | 'module9-events'
  | 'module10-admin'
  | 'module11-blockchain'
  | 'module12-frontend'
  | 'module13-nova'
  | 'module14-voice'
  | 'module15-stellar';

export interface ServiceDefinition {
  name: ServiceName;
  envKey: string;
  defaultHost: string;
  port: number;
  healthPath: string;
}

export const SERVICE_REGISTRY: Record<ServiceName, ServiceDefinition> = {
  'module1-relevance-gate': { name: 'module1-relevance-gate', envKey: 'GATE_URL', defaultHost: 'localhost', port: 3001, healthPath: '/health' },
  'module2-auditor':        { name: 'module2-auditor',        envKey: 'AUDITOR_URL', defaultHost: 'localhost', port: 3002, healthPath: '/health' },
  'module3-orchestrator':   { name: 'module3-orchestrator',   envKey: 'ORCHESTRATOR_URL', defaultHost: 'localhost', port: 3003, healthPath: '/health' },
  'module4-gateway':        { name: 'module4-gateway',        envKey: 'GATEWAY_URL', defaultHost: 'localhost', port: 3004, healthPath: '/health' },
  'module5-mcp':            { name: 'module5-mcp',            envKey: 'MCP_URL', defaultHost: 'localhost', port: 3005, healthPath: '/health' },
  'module6-database':       { name: 'module6-database',       envKey: 'DB_SERVICE_URL', defaultHost: 'localhost', port: 3006, healthPath: '/health' },
  'module7-auth':           { name: 'module7-auth',           envKey: 'AUTH_URL', defaultHost: 'localhost', port: 3007, healthPath: '/health' },
  'module8-secrets':        { name: 'module8-secrets',        envKey: 'SECRETS_URL', defaultHost: 'localhost', port: 3008, healthPath: '/health' },
  'module9-events':         { name: 'module9-events',         envKey: 'EVENTS_URL', defaultHost: 'localhost', port: 3009, healthPath: '/health' },
  'module10-admin':         { name: 'module10-admin',         envKey: 'ADMIN_URL', defaultHost: 'localhost', port: 3010, healthPath: '/health' },
  'module11-blockchain':    { name: 'module11-blockchain',    envKey: 'BLOCKCHAIN_URL', defaultHost: 'localhost', port: 3011, healthPath: '/health' },
  'module12-frontend':      { name: 'module12-frontend',      envKey: 'FRONTEND_URL', defaultHost: 'localhost', port: 3012, healthPath: '/' },
  'module13-nova':          { name: 'module13-nova',          envKey: 'NOVA_URL',   defaultHost: 'localhost', port: 3013, healthPath: '/health' },
  'module14-voice':         { name: 'module14-voice',         envKey: 'VOICE_URL',    defaultHost: 'localhost', port: 3014, healthPath: '/health' },
  'module15-stellar':       { name: 'module15-stellar',       envKey: 'STELLAR_URL',  defaultHost: 'localhost', port: 3015, healthPath: '/health' },
};

export function getServiceUrl(name: ServiceName): string {
  const svc = SERVICE_REGISTRY[name];
  const fromEnv = process.env[svc.envKey];
  if (fromEnv) return fromEnv;
  return `http://${svc.defaultHost}:${svc.port}`;
}

export const INTERNAL_HEADER = 'x-aiops-service-token';

export function getInternalToken(): string {
  const t = process.env.INTERNAL_SERVICE_TOKEN;
  if (!t) throw new Error('INTERNAL_SERVICE_TOKEN is required');
  return t;
}

export function verifyInternalToken(provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = process.env.INTERNAL_SERVICE_TOKEN ?? '';
  if (!expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

import { fetchWithTimeout } from './date-utils.js';

export async function internalFetch(
  targetService: ServiceName,
  path: string,
  options: RequestInit = {},
  timeoutMs = 30_000
): Promise<Response> {
  const url = `${getServiceUrl(targetService)}${path}`;
  const headers = new Headers(options.headers as HeadersInit);
  headers.set(INTERNAL_HEADER, getInternalToken());
  headers.set('Content-Type', 'application/json');
  return fetchWithTimeout(url, { ...options, headers }, timeoutMs);
}

export async function pingAllServices(): Promise<Record<ServiceName, 'online' | 'offline'>> {
  const results = {} as Record<ServiceName, 'online' | 'offline'>;
  await Promise.allSettled(
    (Object.keys(SERVICE_REGISTRY) as ServiceName[]).map(async (name) => {
      try {
        const svc = SERVICE_REGISTRY[name];
        const url = `${getServiceUrl(name)}${svc.healthPath}`;
        const res = await fetchWithTimeout(url, {}, 4_000);
        results[name] = res.ok ? 'online' : 'offline';
      } catch {
        results[name] = 'offline';
      }
    })
  );
  return results;
}

// ── verifyToken — verify Bearer token via module7 auth ────────
// Used by modules that accept human requests and need to verify
// the caller's OAuth2 token before processing.

export async function verifyToken(
  req: { headers: Record<string, string | string[] | undefined>; id?: unknown },
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  requiredScope?: string,
): Promise<boolean> {
  const authHeader = req.headers['authorization'] as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Bearer token required', requestId: req.id });
    return false;
  }
  const token = authHeader.slice(7);
  try {
    const res = await internalFetch('module7-auth', '/introspect', {
      method: 'POST',
      body: JSON.stringify({ token, required_scope: requiredScope }),
    }, 8_000);
    if (!res.ok) {
      reply.status(401).send({ error: 'Token verification failed', requestId: req.id });
      return false;
    }
    const payload = await res.json() as { active: boolean; scope?: string };
    if (!payload.active) {
      reply.status(401).send({ error: 'Token expired or revoked', requestId: req.id });
      return false;
    }
    if (requiredScope && !payload.scope?.includes(requiredScope) && !payload.scope?.includes('admin:full')) {
      reply.status(403).send({ error: `Required scope: ${requiredScope}`, requestId: req.id });
      return false;
    }
    return true;
  } catch {
    reply.status(503).send({ error: 'Auth service unavailable — try again', requestId: req.id });
    return false;
  }
}
