// ============================================================
// MAIN ENTRY POINT — AI Blockchain Ops
// Starts all 12 modules as child processes with health checks,
// dependency ordering, restart on crash, and graceful shutdown.
// Usage: node main.js | tsx main.ts
// ============================================================

import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env ─────────────────────────────────────────────────

function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) {
    console.error('❌ .env file not found. Copy .env.example to .env and fill in values.');
    process.exit(1);
  }
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

loadEnv();

// ── Validate required env vars ────────────────────────────────

function validateEnv() {
  const required = [
    'INTERNAL_SERVICE_TOKEN',
    'SECRETS_MASTER_KEY',
    'DATABASE_URL',
    'ANTHROPIC_API_KEY',
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(k => console.error(`   • ${k}`));
    console.error('\n📋 See .env.example for setup instructions.');
    process.exit(1);
  }
  if (!process.env.DEEPSEEK_API_KEY) console.warn('⚠️  DEEPSEEK_API_KEY not set — Module1 (Relevance Gate) will be degraded');
  if (!process.env.GEMINI_API_KEY) console.warn('⚠️  GEMINI_API_KEY not set — Module2 (Auditor) will be degraded');
}

validateEnv();

// ── Module definitions with dependency ordering ───────────────

interface ModuleDef {
  name: string;
  file: string;
  port: number;
  healthPath: string;
  color: string;
  dependsOn: string[];
  restartOnCrash: boolean;
  startupDelayMs: number;
  criticalPath: boolean; // if true, failure kills entire system
}

const MODULES: ModuleDef[] = [
  {
    name: 'module6-database',
    file: 'modules/module6-database.ts',
    port: 3006,
    healthPath: '/health',
    color: '\x1b[37m', // white
    dependsOn: [],
    restartOnCrash: true,
    startupDelayMs: 0,
    criticalPath: true,
  },
  {
    name: 'module9-events',
    file: 'modules/module9-events.ts',
    port: 3009,
    healthPath: '/health',
    color: '\x1b[35m', // magenta
    dependsOn: ['module6-database'],
    restartOnCrash: true,
    startupDelayMs: 1000,
    criticalPath: false,
  },
  {
    name: 'module7-auth',
    file: 'modules/module7-auth.ts',
    port: 3007,
    healthPath: '/health',
    color: '\x1b[31m', // red
    dependsOn: ['module6-database'],
    restartOnCrash: true,
    startupDelayMs: 1500,
    criticalPath: true,
  },
  {
    name: 'module8-secrets',
    file: 'modules/module8-secrets.ts',
    port: 3008,
    healthPath: '/health',
    color: '\x1b[33m', // yellow
    dependsOn: ['module6-database', 'module9-events'],
    restartOnCrash: true,
    startupDelayMs: 2000,
    criticalPath: false,
  },
  {
    name: 'module1-relevance-gate',
    file: 'modules/module1-relevance-gate.ts',
    port: 3001,
    healthPath: '/health',
    color: '\x1b[36m', // cyan
    dependsOn: ['module6-database', 'module9-events'],
    restartOnCrash: true,
    startupDelayMs: 2500,
    criticalPath: false,
  },
  {
    name: 'module2-auditor',
    file: 'modules/module2-auditor.ts',
    port: 3002,
    healthPath: '/health',
    color: '\x1b[33m', // yellow
    dependsOn: ['module6-database', 'module9-events'],
    restartOnCrash: true,
    startupDelayMs: 3000,
    criticalPath: false,
  },
  {
    name: 'module5-mcp',
    file: 'modules/module5-mcp.ts',
    port: 3005,
    healthPath: '/health',
    color: '\x1b[34m', // blue
    dependsOn: ['module1-relevance-gate', 'module6-database', 'module9-events'],
    restartOnCrash: true,
    startupDelayMs: 3500,
    criticalPath: false,
  },
  {
    name: 'module11-blockchain',
    file: 'modules/module11-blockchain.ts',
    port: 3011,
    healthPath: '/health',
    color: '\x1b[32m', // green
    dependsOn: ['module6-database', 'module9-events', 'module1-relevance-gate', 'module2-auditor'],
    restartOnCrash: true,
    startupDelayMs: 4000,
    criticalPath: false,
  },
  {
    name: 'module3-orchestrator',
    file: 'modules/module3-orchestrator.ts',
    port: 3003,
    healthPath: '/health',
    color: '\x1b[32m', // green
    dependsOn: ['module1-relevance-gate', 'module2-auditor', 'module5-mcp', 'module6-database', 'module7-auth', 'module9-events'],
    restartOnCrash: true,
    startupDelayMs: 5000,
    criticalPath: true,
  },
  {
    name: 'module10-admin',
    file: 'modules/module10-admin.ts',
    port: 3010,
    healthPath: '/health',
    color: '\x1b[35m', // magenta
    dependsOn: ['module6-database', 'module7-auth'],
    restartOnCrash: true,
    startupDelayMs: 5000,
    criticalPath: false,
  },
  {
    name: 'module4-gateway',
    file: 'modules/module4-gateway.ts',
    port: 3004,
    healthPath: '/health',
    color: '\x1b[34m', // blue
    dependsOn: ['module3-orchestrator', 'module7-auth', 'module9-events', 'module11-blockchain'],
    restartOnCrash: true,
    startupDelayMs: 6000,
    criticalPath: true,
  },
  {
    name: 'module12-frontend',
    file: 'modules/module12-frontend.ts',
    port: 3012,
    healthPath: '/',
    color: '\x1b[36m', // cyan
    dependsOn: ['module4-gateway', 'module9-events'],
    restartOnCrash: true,
    startupDelayMs: 7000,
    criticalPath: false,
  },
  {
    name: 'module13-nova',
    file: 'modules/module13-nova.ts',
    port: 3013,
    healthPath: '/health',
    color: '\x1b[33m', // yellow
    dependsOn: ['module6-database', 'module9-events'],
    restartOnCrash: true,
    startupDelayMs: 4500,
    criticalPath: false,
  },
  {
    name: 'module14-voice',
    file: 'modules/module14-voice.ts',
    port: 3014,
    healthPath: '/health',
    color: '\x1b[35m', // magenta
    dependsOn: ['module9-events'],
    restartOnCrash: true,
    startupDelayMs: 5500,
    criticalPath: false,
  },
  {
    name: 'module15-stellar',
    file: 'modules/module15-stellar.ts',
    port: 3015,
    healthPath: '/health',
    color: '\x1b[96m', // bright cyan
    dependsOn: ['module6-database', 'module9-events', 'module1-relevance-gate', 'module2-auditor'],
    restartOnCrash: true,
    startupDelayMs: 6500,
    criticalPath: false,
  },
];

// ── Process registry ──────────────────────────────────────────

const processes = new Map<string, ChildProcess>();
const restartCounts = new Map<string, number>();
const moduleStatus = new Map<string, 'starting' | 'online' | 'offline' | 'crashed'>();
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function log(moduleName: string, color: string, msg: string) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`${DIM}${ts}${RESET} ${color}${BOLD}[${moduleName}]${RESET} ${msg}`);
}

function logMain(msg: string) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`${DIM}${ts}${RESET} \x1b[97m${BOLD}[MAIN]${RESET} ${msg}`);
}

// ── Health check ──────────────────────────────────────────────

async function waitForHealth(mod: ModuleDef, timeoutMs = 30_000): Promise<boolean> {
  const url = `http://localhost:${mod.port}${mod.healthPath}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1_000));
  }
  return false;
}

async function checkHealth(mod: ModuleDef): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${mod.port}${mod.healthPath}`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch { return false; }
}

// ── Spawn a module ────────────────────────────────────────────

function spawnModule(mod: ModuleDef): ChildProcess {
  const filePath = join(__dirname, mod.file);
  const tsxPath = join(__dirname, 'node_modules', '.bin', 'tsx');
  const runner = existsSync(tsxPath) ? tsxPath : 'tsx';

  const child = spawn(runner, [filePath], {
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      log(mod.name, mod.color, line);
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      log(mod.name, '\x1b[31m', `ERR: ${line}`);
    }
  });

  child.on('exit', (code, signal) => {
    moduleStatus.set(mod.name, 'crashed');
    processes.delete(mod.name);

    if (shuttingDown) return;

    const restarts = (restartCounts.get(mod.name) ?? 0) + 1;
    restartCounts.set(mod.name, restarts);
    log(mod.name, '\x1b[31m', `Exited (code=${code}, signal=${signal}). Restart #${restarts}`);

    if (!mod.restartOnCrash) {
      log(mod.name, '\x1b[31m', 'restartOnCrash=false — not restarting');
      if (mod.criticalPath) {
        logMain('Critical module crashed — shutting down system');
        void shutdown();
      }
      return;
    }

    const backoff = Math.min(1000 * Math.pow(2, Math.min(restarts - 1, 5)), 30_000);
    log(mod.name, '\x1b[33m', `Restarting in ${backoff}ms...`);
    setTimeout(() => {
      if (shuttingDown) return;
      const child = spawnModule(mod);
      processes.set(mod.name, child);
      moduleStatus.set(mod.name, 'starting');
    }, backoff);
  });

  return child;
}

// ── Start modules in dependency order ────────────────────────

async function startModules() {
  logMain('Starting AI Blockchain Ops system...');
  logMain(`Node.js ${process.version} | PID ${process.pid}`);
  logMain(`Modules: ${MODULES.length} | Environment: ${process.env.NODE_ENV ?? 'production'}`);
  console.log('');

  for (const mod of MODULES) {
    if (mod.startupDelayMs > 0) {
      await new Promise(r => setTimeout(r, mod.startupDelayMs));
    }

    log(mod.name, mod.color, `Starting on port ${mod.port}...`);
    moduleStatus.set(mod.name, 'starting');
    restartCounts.set(mod.name, 0);

    const child = spawnModule(mod);
    processes.set(mod.name, child);

    // Wait for health before proceeding for critical deps
    if (mod.criticalPath) {
      const healthy = await waitForHealth(mod, 45_000);
      if (!healthy) {
        log(mod.name, '\x1b[31m', `Health check failed after 45s — critical path module`);
        if (mod.criticalPath) {
          logMain('Critical module failed to start — aborting');
          await shutdown();
        }
      } else {
        moduleStatus.set(mod.name, 'online');
        log(mod.name, mod.color, `✅ Online — port ${mod.port}`);
      }
    } else {
      // Non-critical — wait briefly then continue
      setTimeout(async () => {
        const healthy = await waitForHealth(mod, 20_000);
        if (healthy) {
          moduleStatus.set(mod.name, 'online');
          log(mod.name, mod.color, `✅ Online — port ${mod.port}`);
        } else {
          moduleStatus.set(mod.name, 'offline');
          log(mod.name, '\x1b[33m', `⚠️  Health check failed — module may self-recover`);
        }
      }, 2_000);
    }
  }

  console.log('');
  logMain('═══════════════════════════════════════════════════════');
  logMain('🚀 AI Blockchain Ops system started');
  logMain('');
  logMain('  Frontend Dashboard:  http://localhost:3012');
  logMain('  API Gateway:         http://localhost:3004');
  logMain('  Admin API:           http://localhost:3010');
  logMain('  Blockchain Engine:   http://localhost:3011');
  logMain('  Events Bus (SSE):    http://localhost:3009');
  logMain('  Nova Engine:         http://localhost:3013');
  logMain('  Voice Engine:        http://localhost:3014');
  logMain('');
  logMain('  Run `npm run status` to check all modules');
  logMain('  Press Ctrl+C to shutdown gracefully');
  logMain('═══════════════════════════════════════════════════════');
  console.log('');
}

// ── System-wide health monitor ────────────────────────────────

let healthMonitorInterval: NodeJS.Timeout;

function startHealthMonitor() {
  healthMonitorInterval = setInterval(async () => {
    if (shuttingDown) return;
    for (const mod of MODULES) {
      const currentStatus = moduleStatus.get(mod.name);
      if (currentStatus === 'starting') continue;
      const healthy = await checkHealth(mod);
      if (healthy && currentStatus !== 'online') {
        moduleStatus.set(mod.name, 'online');
        log(mod.name, mod.color, '✅ Recovered');
      } else if (!healthy && currentStatus === 'online') {
        moduleStatus.set(mod.name, 'offline');
        log(mod.name, '\x1b[33m', '⚠️  Health check failed');
      }
    }
  }, 30_000);
}

// ── Status command ────────────────────────────────────────────

async function printStatus() {
  console.log('\n📊 System Status\n');
  for (const mod of MODULES) {
    const status = moduleStatus.get(mod.name) ?? 'unknown';
    const healthy = await checkHealth(mod);
    const restarts = restartCounts.get(mod.name) ?? 0;
    const pid = processes.get(mod.name)?.pid;
    const statusIcon = healthy ? '✅' : status === 'starting' ? '🔄' : '❌';
    console.log(`  ${statusIcon} ${mod.name.padEnd(28)} port ${mod.port}  pid ${String(pid ?? '—').padStart(6)}  restarts ${restarts}`);
  }
  console.log('');
}

// ── Graceful shutdown ─────────────────────────────────────────

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('');
  logMain('Shutting down gracefully...');

  clearInterval(healthMonitorInterval);

  // Stop in reverse order
  const reverseModules = [...MODULES].reverse();
  for (const mod of reverseModules) {
    const child = processes.get(mod.name);
    if (child && !child.killed) {
      log(mod.name, mod.color, 'Stopping...');
      child.kill('SIGTERM');
      processes.delete(mod.name);
    }
  }

  // Give processes time to exit gracefully
  await new Promise(r => setTimeout(r, 3_000));

  // Force kill any remaining
  for (const [name, child] of processes) {
    if (!child.killed) {
      logMain(`Force killing ${name}`);
      child.kill('SIGKILL');
    }
  }

  logMain('System stopped. Goodbye.');
  process.exit(0);
}

// ── Interactive status via stdin ──────────────────────────────

if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd === 'status' || cmd === 's') await printStatus();
    else if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') await shutdown();
    else if (cmd === 'help' || cmd === 'h') {
      console.log('  Commands: status (s) | quit (q) | help (h)');
    }
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  logMain(`Uncaught exception: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  logMain(`Unhandled rejection: ${String(reason)}`);
});

// ── Start ─────────────────────────────────────────────────────

await startModules();
startHealthMonitor();
