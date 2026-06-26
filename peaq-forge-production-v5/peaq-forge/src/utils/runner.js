"use strict";

const { spawn } = require("child_process");
const path      = require("path");
const fs        = require("fs");
const os        = require("os");
const logger    = require("./logger");

const IS_WIN = process.platform === "win32";
const HOME   = os.homedir();

function buildPath() {
  const extra = IS_WIN ? [
    `${HOME}\\.cargo\\bin`,
    `${HOME}\\AppData\\Roaming\\npm`,
    `${HOME}\\.foundry\\bin`
  ] : [
    `${HOME}/.cargo/bin`,
    `${HOME}/.foundry/bin`,
    `/usr/local/bin`,
    `/opt/homebrew/bin`,
    `${HOME}/.npm-global/bin`,
    `/usr/bin`
  ];
  return [process.env.PATH, ...extra].filter(Boolean).join(IS_WIN ? ";" : ":");
}

const ENV_PATH = buildPath();

function resolveCmd(cmd) {
  if (!IS_WIN) return cmd;
  return ["npx","npm","node"].includes(cmd) ? `${cmd}.cmd` : cmd;
}

const activeProcs = new Map();

// Default process timeout: 10 minutes for builds/compiles, override per call
const DEFAULT_TIMEOUT_MS = parseInt(process.env.PROCESS_TIMEOUT_MS || "600000", 10);

function run(cmd, args, cwd, sendFn, label, wsId, envOverride = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    // Input validation
    if (!cmd || typeof cmd !== "string") {
      const err = "run(): cmd must be a non-empty string";
      logger.error(err);
      return reject({ error: err });
    }
    if (!Array.isArray(args)) {
      const err = "run(): args must be an array";
      logger.error(err);
      return reject({ error: err });
    }

    // Validate and sanitize all args — no shell injection
    const safeArgs = args.map(a => String(a)).filter(a => !/[;&|`$<>\n\r]/.test(a));

    // Sanitize env override values — no shell chars in values
    const safeEnvOverride = {};
    for (const [k, v] of Object.entries(envOverride || {})) {
      if (typeof k === "string" && /^[A-Z_][A-Z0-9_]*$/i.test(k)) {
        safeEnvOverride[k] = String(v).replace(/[\n\r\0]/g, "");
      }
    }

    // Fallback cwd to HOME if dir does not exist
    const effectiveCwd = cwd && fs.existsSync(cwd) ? cwd : HOME;

    sendFn("start", { label, cmd: `${cmd} ${safeArgs.join(" ")}`, cwd: effectiveCwd });
    logger.info(`[runner] ${cmd} ${safeArgs.join(" ")} in ${effectiveCwd}`);

    let proc;
    try {
      proc = spawn(resolveCmd(cmd), safeArgs, {
        cwd:   effectiveCwd,
        shell: false, // NEVER use shell:true — prevents shell injection
        // A05: Never spread all process.env into children — whitelist safe vars only
        // This prevents PEAQ_FORGE_TOKEN, internal secrets from leaking to child processes
        env: {
          // Shell/runtime essentials
          PATH:     ENV_PATH,
          HOME:     process.env.HOME     || os.homedir(),
          USER:     process.env.USER     || "",
          LOGNAME:  process.env.LOGNAME  || "",
          SHELL:    process.env.SHELL    || "",
          LANG:     process.env.LANG     || "en_US.UTF-8",
          TERM:     "dumb",
          FORCE_COLOR: "0",
          // Node/npm
          NODE_ENV:    process.env.NODE_ENV    || "production",
          NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE || "",
          // Rust/Cargo
          CARGO_HOME:   process.env.CARGO_HOME  || "",
          RUSTUP_HOME:  process.env.RUSTUP_HOME || "",
          // Foundry
          FOUNDRY_DIR: process.env.FOUNDRY_DIR || "",
          // Hardhat/peaq — only pass RPC overrides, never the forge token
          PEAQ_MAINNET_RPC: process.env.PEAQ_MAINNET_RPC || "",
          PEAQ_AGUNG_RPC:   process.env.PEAQ_AGUNG_RPC   || "",
          PEAQ_KREST_RPC:   process.env.PEAQ_KREST_RPC   || "",
          PEAQ_MAINNET_WS:  process.env.PEAQ_MAINNET_WS  || "",
          PEAQ_AGUNG_WS:    process.env.PEAQ_AGUNG_WS    || "",
          PEAQ_KREST_WS:    process.env.PEAQ_KREST_WS    || "",
          // Windows compat
          USERPROFILE:   process.env.USERPROFILE  || "",
          APPDATA:       process.env.APPDATA       || "",
          LOCALAPPDATA:  process.env.LOCALAPPDATA  || "",
          TEMP:          process.env.TEMP          || "",
          TMP:           process.env.TMP           || "",
          SystemRoot:    process.env.SystemRoot     || "",
          COMSPEC:       process.env.COMSPEC        || "",
          // Caller-supplied overrides (validated by Joi before reaching here)
          ...safeEnvOverride,
        },
      });
    } catch (spawnErr) {
      const msg = `Failed to spawn '${cmd}': ${spawnErr.message}`;
      logger.error(`[runner] ${msg}`);
      sendFn("error", { message: msg, label });
      return reject({ error: msg });
    }

    if (wsId) activeProcs.set(wsId, proc);

    // DoS protection: kill process if it exceeds timeout
    const timeoutHandle = setTimeout(() => {
      logger.warn(`[runner] Process timeout (${timeoutMs}ms) for '${cmd}' — sending SIGTERM`);
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
      sendFn("error", { message: `Process timed out after ${Math.round(timeoutMs/1000)}s`, label });
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB cap per stream — DoS protection
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdout.on("data", d => {
      try {
        const text = d.toString();
        if (!stdoutTruncated) {
          stdout += text;
          if (stdout.length > MAX_OUTPUT_BYTES) {
            stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
            stdoutTruncated = true;
            sendFn("stderr", { text: "[OUTPUT TRUNCATED — 10MB limit reached]", label });
            logger.warn(`[runner] stdout truncated at 10MB for '${cmd}'`);
          }
        }
        const safe = text.replace(/0x[0-9a-fA-F]{60,}/g, "[REDACTED]");
        safe.split("\n").forEach(l => { if (l.trim()) sendFn("stdout", { text: l, label }); });
      } catch (e) { logger.error("[runner] stdout handler error: " + e.message); }
    });

    proc.stderr.on("data", d => {
      try {
        const text = d.toString();
        if (!stderrTruncated) {
          stderr += text;
          if (stderr.length > MAX_OUTPUT_BYTES) {
            stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
            stderrTruncated = true;
            logger.warn(`[runner] stderr truncated at 10MB for '${cmd}'`);
          }
        }
        const safe = text.replace(/0x[0-9a-fA-F]{60,}/g, "[REDACTED]");
        safe.split("\n").forEach(l => { if (l.trim()) sendFn("stderr", { text: l, label }); });
      } catch (e) { logger.error("[runner] stderr handler error: " + e.message); }
    });

    proc.on("close", code => {
      clearTimeout(timeoutHandle);
      if (wsId) activeProcs.delete(wsId);
      sendFn("done", { code, label, stdout, stderr });
      if (code === 0) resolve({ stdout, stderr, code });
      else reject({ stdout, stderr, code });
    });

    proc.on("error", err => {
      clearTimeout(timeoutHandle);
      if (wsId) activeProcs.delete(wsId);
      const msg = err.code === "ENOENT"
        ? `'${cmd}' not found. Install it and ensure it is on your PATH.`
        : err.message;
      sendFn("error", { message: msg, label });
      logger.error(`[runner] spawn error for '${cmd}': ${msg}`);
      reject({ error: msg });
    });
  });
}

function kill(wsId) {
  const proc = activeProcs.get(wsId);
  if (proc) {
    try { proc.kill("SIGTERM"); } catch (e) { logger.warn("[runner] kill SIGTERM failed: " + e.message); }
    activeProcs.delete(wsId);
    return true;
  }
  return false;
}

function killAll() {
  let count = 0;
  for (const [id, proc] of activeProcs.entries()) {
    try { proc.kill("SIGTERM"); count++; } catch (e) { logger.warn("[runner] killAll failed for " + id + ": " + e.message); }
  }
  activeProcs.clear();
  return count;
}

function getActiveCount() { return activeProcs.size; }

module.exports = { run, kill, killAll, getActiveCount, HOME };
