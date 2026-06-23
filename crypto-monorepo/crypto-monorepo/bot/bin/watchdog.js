#!/usr/bin/env node
'use strict';

/**
 * bot/bin/watchdog.js
 * Process supervisor — spawns the crypto agent and restarts it on crash.
 *
 * Features:
 *   - Exponential backoff between restarts (caps at 30s)
 *   - Max consecutive crash limit before giving up
 *   - Forwards stdin/stdout/stderr
 *   - Writes a PID file for external monitoring
 *   - Graceful shutdown on SIGTERM / SIGINT
 *   - Per-run log timestamped to data/watchdog.log
 *
 * Pure Node.js child_process — zero external deps.
 *
 * Usage:
 *   node bin/watchdog.js [-- ...args passed to run.js]
 */

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');

const CONFIG_PATH   = path.resolve(__dirname, '../config/config.js');
const CONFIG        = require(CONFIG_PATH);
const RUN_SCRIPT    = path.resolve(__dirname, './run.js');
const PID_FILE      = path.join(CONFIG.dataDir, 'agent.pid');
const WATCHDOG_LOG  = path.join(CONFIG.dataDir, 'watchdog.log');

const MAX_CRASHES   = parseInt(process.env.WATCHDOG_MAX_CRASHES || '10', 10);
const BASE_DELAY_MS = parseInt(process.env.WATCHDOG_BASE_DELAY  || '1000', 10);
const MAX_DELAY_MS  = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function wlog(msg) {
  const line = `[${new Date().toISOString()}] [watchdog] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(WATCHDOG_LOG, line);
}

function writePid(pid) {
  fs.writeFileSync(PID_FILE, String(pid), 'utf8');
}

function clearPid() {
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Supervisor loop ───────────────────────────────────────────────────────────

// Extra args to forward to run.js (everything after --)
const sepIdx   = process.argv.indexOf('--');
const extraArgs = sepIdx >= 0 ? process.argv.slice(sepIdx + 1) : [];

let crashCount    = 0;
let currentChild  = null;
let shuttingDown  = false;

async function supervise() {
  wlog(`Watchdog started. Max crashes: ${MAX_CRASHES}. Script: ${RUN_SCRIPT}`);

  while (!shuttingDown) {
    if (crashCount >= MAX_CRASHES) {
      wlog(`FATAL: exceeded max crash limit (${MAX_CRASHES}). Giving up.`);
      clearPid();
      process.exit(1);
    }

    const startedAt = Date.now();
    wlog(`Spawning agent (attempt ${crashCount + 1}/${MAX_CRASHES})...`);

    const child = spawn(process.execPath, [RUN_SCRIPT, ...extraArgs], {
      stdio: 'inherit',
      env:   process.env,
    });

    currentChild = child;
    writePid(child.pid);
    wlog(`Agent PID: ${child.pid}`);

    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    currentChild = null;

    const uptime = ((Date.now() - startedAt) / 1000).toFixed(1);
    wlog(`Agent exited — code: ${exitCode.code}, signal: ${exitCode.signal}, uptime: ${uptime}s`);

    if (shuttingDown) break;

    // Clean exit (code 0) — don't restart
    if (exitCode.code === 0) {
      wlog('Agent exited cleanly (code 0). Watchdog done.');
      clearPid();
      process.exit(0);
    }

    // Crash — count and back off
    crashCount++;
    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, crashCount - 1), MAX_DELAY_MS);
    // Add jitter
    const jitter    = Math.floor(Math.random() * delay * 0.3);
    const actualDelay = delay + jitter;

    wlog(`Crash #${crashCount}. Restarting in ${(actualDelay / 1000).toFixed(1)}s...`);
    await sleep(actualDelay);
  }

  clearPid();
  wlog('Watchdog stopped.');
}

// ── Signal handling ───────────────────────────────────────────────────────────

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  wlog(`Received ${signal}. Shutting down...`);
  if (currentChild) {
    try { currentChild.kill('SIGTERM'); } catch {}
  }
  clearPid();
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGHUP',  () => {
  wlog('SIGHUP received — reloading (restarting child)');
  if (currentChild) { try { currentChild.kill('SIGTERM'); } catch {} }
});

// ── Run ───────────────────────────────────────────────────────────────────────

supervise().catch(err => {
  wlog(`Watchdog fatal error: ${err.message}`);
  clearPid();
  process.exit(1);
});
