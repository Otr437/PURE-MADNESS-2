// ============================================================
// CONFIG — Centralized Runtime Configuration
// All modules import from here. Single source of truth for
// all configuration values, env validation, and defaults.
// ============================================================

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env if not already loaded ──────────────────────────

function loadEnvFile() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

// ── Type-safe env reader ──────────────────────────────────────

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Required environment variable '${key}' is not set`);
  return val;
}

function envOptional(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  if (isNaN(n)) throw new Error(`Environment variable '${key}' must be an integer, got '${val}'`);
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key]?.toLowerCase();
  if (!val) return fallback;
  if (val === 'true' || val === '1' || val === 'yes') return true;
  if (val === 'false' || val === '0' || val === 'no') return false;
  throw new Error(`Environment variable '${key}' must be true/false, got '${val}'`);
}

// ── Service URLs ──────────────────────────────────────────────

export const SERVICES = {
  gate:         envOptional('GATE_URL',         'http://localhost:3001'),
  auditor:      envOptional('AUDITOR_URL',       'http://localhost:3002'),
  orchestrator: envOptional('ORCHESTRATOR_URL',  'http://localhost:3003'),
  gateway:      envOptional('GATEWAY_URL',       'http://localhost:3004'),
  mcp:          envOptional('MCP_URL',           'http://localhost:3005'),
  database:     envOptional('DB_SERVICE_URL',    'http://localhost:3006'),
  auth:         envOptional('AUTH_URL',          'http://localhost:3007'),
  secrets:      envOptional('SECRETS_URL',       'http://localhost:3008'),
  events:       envOptional('EVENTS_URL',        'http://localhost:3009'),
  admin:        envOptional('ADMIN_URL',         'http://localhost:3010'),
  blockchain:   envOptional('BLOCKCHAIN_URL',    'http://localhost:3011'),
  frontend:     envOptional('FRONTEND_URL',      'http://localhost:3012'),
  stellar:      envOptional('STELLAR_URL',       'http://localhost:3015'),
} as const;

// ── Ports ─────────────────────────────────────────────────────

export const PORTS = {
  gate:         envInt('GATE_PORT',         3001),
  auditor:      envInt('AUDITOR_PORT',      3002),
  orchestrator: envInt('ORCHESTRATOR_PORT', 3003),
  gateway:      envInt('GATEWAY_PORT',      3004),
  mcp:          envInt('MCP_PORT',          3005),
  database:     envInt('DB_PORT',           3006),
  auth:         envInt('AUTH_PORT',         3007),
  secrets:      envInt('SECRETS_PORT',      3008),
  events:       envInt('EVENTS_PORT',       3009),
  admin:        envInt('ADMIN_PORT',        3010),
  blockchain:   envInt('BLOCKCHAIN_PORT',   3011),
  frontend:     envInt('FRONTEND_PORT',     3012),
  stellar:      envInt('STELLAR_PORT',      3015),
} as const;

// ── Security ──────────────────────────────────────────────────

export const SECURITY = {
  get internalServiceToken(): string {
    return env('INTERNAL_SERVICE_TOKEN');
  },
  get secretsMasterKey(): string {
    return env('SECRETS_MASTER_KEY');
  },
  allowedOrigin: envOptional('ALLOWED_ORIGIN', '*'),
  jwtSecret: envOptional('JWT_SECRET', ''),
} as const;

// ── AI Providers ──────────────────────────────────────────────

export const AI = {
  get anthropicApiKey(): string {
    return env('ANTHROPIC_API_KEY');
  },
  get deepseekApiKey(): string {
    return env('DEEPSEEK_API_KEY');
  },
  get geminiApiKey(): string {
    return env('GEMINI_API_KEY');
  },
  anthropicModel:  envOptional('ANTHROPIC_MODEL',  'claude-sonnet-4-6'),
  deepseekModel:   envOptional('DEEPSEEK_MODEL',   'deepseek-chat'),
  geminiModel:     envOptional('GEMINI_MODEL',     'gemini-2.5-flash'),
  maxOutputTokens: envInt('MAX_OUTPUT_TOKENS', 8096),
  temperature:     parseFloat(envOptional('AI_TEMPERATURE', '0.7')),
} as const;

// ── Database ──────────────────────────────────────────────────

export const DATABASE = {
  get url(): string {
    return env('DATABASE_URL');
  },
  ssl:                  envBool('DATABASE_SSL',           false),
  maxConnections:       envInt('DB_MAX_CONNECTIONS',      10),
  idleTimeoutMs:        envInt('DB_IDLE_TIMEOUT_MS',      30_000),
  connectionTimeoutMs:  envInt('DB_CONNECTION_TIMEOUT_MS', 5_000),
  statementTimeoutMs:   envInt('DB_STATEMENT_TIMEOUT_MS', 10_000),
} as const;

// ── Blockchain ────────────────────────────────────────────────

export const BLOCKCHAIN = {
  get walletPrivateKey(): string | undefined {
    return process.env['WALLET_PRIVATE_KEY'];
  },
  workspace: envOptional('BLOCKCHAIN_WORKSPACE', './.blockchain-workspace'),
  rpc: {
    ethereum:    envOptional('ETH_RPC_URL',          'https://eth.llamarpc.com'),
    base:        envOptional('BASE_RPC_URL',          'https://mainnet.base.org'),
    arbitrum:    envOptional('ARB_RPC_URL',           'https://arb1.arbitrum.io/rpc'),
    optimism:    envOptional('OP_RPC_URL',            'https://mainnet.optimism.io'),
    polygon:     envOptional('POLYGON_RPC_URL',       'https://polygon-rpc.com'),
    bsc:         envOptional('BSC_RPC_URL',           'https://bsc-dataseed.binance.org'),
    sepolia:     envOptional('SEPOLIA_RPC_URL',       'https://rpc.sepolia.org'),
    baseSepolia: envOptional('BASE_SEPOLIA_RPC_URL',  'https://sepolia.base.org'),
    localhost:   envOptional('LOCAL_RPC_URL',         'http://127.0.0.1:8545'),
  },
  explorer: {
    etherscan:  envOptional('ETHERSCAN_API_KEY',  ''),
    basescan:   envOptional('BASESCAN_API_KEY',   ''),
    arbiscan:   envOptional('ARBISCAN_API_KEY',   ''),
    polygonscan: envOptional('POLYGONSCAN_API_KEY', ''),
  },
  defaultChainId: envInt('DEFAULT_CHAIN_ID', 1),
  maxGasLimit:    envOptional('MAX_GAS_LIMIT', '5000000'),
  gasMultiplier:  parseFloat(envOptional('GAS_MULTIPLIER', '1.2')), // 20% buffer
} as const;

// ── Stellar ───────────────────────────────────────────────────

export const STELLAR = {
  workspace: envOptional('STELLAR_WORKSPACE', './.stellar-workspace'),
  mainnet: {
    horizonUrl:        envOptional('STELLAR_MAINNET_HORIZON_URL',  'https://horizon.stellar.org'),
    sorobanRpcUrl:     envOptional('STELLAR_MAINNET_SOROBAN_RPC',  'https://soroban-mainnet.stellar.org:443'),
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  },
  testnet: {
    horizonUrl:        envOptional('STELLAR_TESTNET_HORIZON_URL',  'https://horizon-testnet.stellar.org'),
    sorobanRpcUrl:     envOptional('STELLAR_TESTNET_SOROBAN_RPC',  'https://soroban-testnet.stellar.org:443'),
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
  futurenet: {
    horizonUrl:        envOptional('STELLAR_FUTURENET_HORIZON_URL', 'https://horizon-futurenet.stellar.org'),
    sorobanRpcUrl:     envOptional('STELLAR_FUTURENET_SOROBAN_RPC', 'https://rpc-futurenet.stellar.org:443'),
    networkPassphrase: 'Test SDF Future Network ; October 2022',
  },
  // Secret keys — loaded lazily, never logged
  get secretKeyMainnet(): string | undefined { return process.env['STELLAR_SECRET_KEY']; },
  get secretKeyTestnet(): string | undefined { return process.env['STELLAR_SECRET_KEY_TESTNET']; },
  get secretKeyFuturenet(): string | undefined { return process.env['STELLAR_SECRET_KEY_FUTURENET']; },
} as const;

// ── Rate Limits ───────────────────────────────────────────────
export const RATE_LIMITS = {
  gateway:      envInt('RATE_LIMIT_GATEWAY',      60),
  gate:         envInt('RATE_LIMIT_GATE',          200),
  auditor:      envInt('RATE_LIMIT_AUDITOR',       100),
  mcp:          envInt('RATE_LIMIT_MCP',           100),
  blockchain:   envInt('RATE_LIMIT_BLOCKCHAIN',    30),
  auth:         envInt('RATE_LIMIT_AUTH',          30),
  stellar:      envInt('RATE_LIMIT_STELLAR',       30),
  events:       envInt('RATE_LIMIT_EVENTS',        200),
  timeWindowMs: envInt('RATE_LIMIT_WINDOW_MS',     60_000),
} as const;

// ── Timeouts ──────────────────────────────────────────────────

export const TIMEOUTS = {
  defaultFetchMs:     envInt('TIMEOUT_DEFAULT_FETCH',      30_000),
  gateCheckMs:        envInt('TIMEOUT_GATE_CHECK',         32_000),
  auditMs:            envInt('TIMEOUT_AUDIT',              55_000),
  claudeMs:           envInt('TIMEOUT_CLAUDE',             90_000),
  blockchainTxMs:     envInt('TIMEOUT_BLOCKCHAIN_TX',      120_000),
  blockchainDeployMs: envInt('TIMEOUT_BLOCKCHAIN_DEPLOY',  300_000),
  webhookDeliveryMs:  envInt('TIMEOUT_WEBHOOK_DELIVERY',   15_000),
  mcpToolMs:          envInt('TIMEOUT_MCP_TOOL',           30_000),
  dbQueryMs:          envInt('TIMEOUT_DB_QUERY',           10_000),
} as const;

// ── Cache ─────────────────────────────────────────────────────

export const CACHE = {
  gateCacheMax:    envInt('CACHE_GATE_MAX',     500),
  gateCacheTtlMs:  envInt('CACHE_GATE_TTL_MS',  300_000), // 5 min
  taskCacheMax:    envInt('CACHE_TASK_MAX',      500),
} as const;

// ── Orchestrator ──────────────────────────────────────────────

export const ORCHESTRATOR = {
  maxConcurrentTasks: envInt('MAX_CONCURRENT_TASKS', 3),
  maxRevisionLoops:   envInt('MAX_REVISION_LOOPS',   1),
  requireAuditDefault: envBool('REQUIRE_AUDIT_DEFAULT', true),
} as const;

// ── Logging ───────────────────────────────────────────────────

export const LOG = {
  level:  envOptional('LOG_LEVEL',  'info'),
  pretty: envBool('LOG_PRETTY', process.env['NODE_ENV'] !== 'production'),
} as const;

// ── Auth ──────────────────────────────────────────────────────

export const AUTH = {
  accessTokenTtlSeconds:  envInt('ACCESS_TOKEN_TTL_SECONDS',  3600),          // 1 hour
  refreshTokenTtlSeconds: envInt('REFRESH_TOKEN_TTL_SECONDS', 30 * 86400),    // 30 days
  pbkdf2Iterations:       envInt('PBKDF2_ITERATIONS',         100_000),
  minPasswordLength:      envInt('MIN_PASSWORD_LENGTH',       12),
} as const;

// ── Secrets ───────────────────────────────────────────────────

export const SECRETS_CONFIG = {
  expiryWarningDays:   envInt('SECRET_EXPIRY_WARNING_DAYS',  7),
  monitorIntervalMs:   envInt('SECRET_MONITOR_INTERVAL_MS',  3_600_000), // 1 hour
  seedRetryAttempts:   envInt('SECRET_SEED_RETRY_ATTEMPTS',  10),
} as const;

// ── Frontend ──────────────────────────────────────────────────

export const FRONTEND = {
  publicDir:    envOptional('FRONTEND_PUBLIC_DIR', './frontend/public'),
  wsHeartbeatMs: envInt('WS_HEARTBEAT_MS', 30_000),
} as const;

// ── Full config export ────────────────────────────────────────

export const config = {
  services:     SERVICES,
  ports:        PORTS,
  security:     SECURITY,
  ai:           AI,
  database:     DATABASE,
  blockchain:   BLOCKCHAIN,
  stellar:      STELLAR,
  rateLimits:   RATE_LIMITS,
  timeouts:     TIMEOUTS,
  cache:        CACHE,
  orchestrator: ORCHESTRATOR,
  log:          LOG,
  auth:         AUTH,
  secrets:      SECRETS_CONFIG,
  frontend:     FRONTEND,
  isDevelopment: process.env['NODE_ENV'] === 'development',
  isProduction:  process.env['NODE_ENV'] !== 'development',
  nodeEnv:       envOptional('NODE_ENV', 'production'),
} as const;

// ── Config validation ─────────────────────────────────────────

export function validateConfig(requiredKeys: (keyof typeof process.env)[] = []) {
  const errors: string[] = [];

  // Always required
  const alwaysRequired = ['INTERNAL_SERVICE_TOKEN', 'SECRETS_MASTER_KEY', 'DATABASE_URL'];
  for (const key of alwaysRequired) {
    if (!process.env[key]) errors.push(`${key} is required`);
  }

  // Caller-specified required keys
  for (const key of requiredKeys) {
    if (!process.env[key]) errors.push(`${key} is required for this module`);
  }

  // Validate SECRETS_MASTER_KEY length
  const masterKey = process.env['SECRETS_MASTER_KEY'] ?? '';
  if (masterKey && masterKey.length < 32) {
    errors.push('SECRETS_MASTER_KEY must be at least 32 characters');
  }

  // Validate INTERNAL_SERVICE_TOKEN length
  const internalToken = process.env['INTERNAL_SERVICE_TOKEN'] ?? '';
  if (internalToken && internalToken.length < 16) {
    errors.push('INTERNAL_SERVICE_TOKEN must be at least 16 characters');
  }

  if (errors.length > 0) {
    console.error('❌ Configuration validation failed:');
    errors.forEach(e => console.error(`   • ${e}`));
    process.exit(1);
  }
}

// ── Helper: get RPC URL for chainId ──────────────────────────

export function getRpcUrl(chainId: number): string {
  const map: Record<number, string> = {
    1:        BLOCKCHAIN.rpc.ethereum,
    8453:     BLOCKCHAIN.rpc.base,
    42161:    BLOCKCHAIN.rpc.arbitrum,
    10:       BLOCKCHAIN.rpc.optimism,
    137:      BLOCKCHAIN.rpc.polygon,
    56:       BLOCKCHAIN.rpc.bsc,
    11155111: BLOCKCHAIN.rpc.sepolia,
    84532:    BLOCKCHAIN.rpc.baseSepolia,
    31337:    BLOCKCHAIN.rpc.localhost,
  };
  const url = map[chainId];
  if (!url) throw new Error(`No RPC URL configured for chainId ${chainId}`);
  return url;
}

// ── Helper: get explorer API key for chainId ──────────────────

export function getExplorerApiKey(chainId: number): string {
  const map: Record<number, string> = {
    1:        BLOCKCHAIN.explorer.etherscan,
    11155111: BLOCKCHAIN.explorer.etherscan,
    8453:     BLOCKCHAIN.explorer.basescan,
    84532:    BLOCKCHAIN.explorer.basescan,
    42161:    BLOCKCHAIN.explorer.arbiscan,
    137:      BLOCKCHAIN.explorer.polygonscan,
  };
  return map[chainId] ?? '';
}

export default config;
