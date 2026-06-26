"use strict";

const deployLog      = require("../utils/deployLog");
const runner         = require("../utils/runner");
const networkService = require("../services/network.service");
const logger         = require("../utils/logger");
const path           = require("path");
const fs             = require("fs");
const os             = require("os");
const { sanitizePath } = require("../utils/sanitize");

// ── Deployments ───────────────────────────────────────────────────────────────

function getDeployments(req, res) {
  const all = deployLog.getAll();
  res.json({ deployments: all, count: all.length });
}

function clearDeployments(req, res) {
  deployLog.clear();
  logger.info(`Deploy log cleared by ${req.ip}`);
  res.json({ ok: true });
}

// ── Admin ─────────────────────────────────────────────────────────────────────

function getAdminStatus(req, res) {
  const mem = process.memoryUsage();
  res.json({
    status:          "ok",
    activeProcesses: runner.getActiveCount(),
    deployLogCount:  deployLog.getAll().length,
    platform:        process.platform,
    nodeVersion:     process.version,
    uptime:          Math.floor(process.uptime()),
    memory: {
      heapUsedMB:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB:       Math.round(mem.rss       / 1024 / 1024),
    },
    env: process.env.NODE_ENV || "development",
  });
}

function killAllProcesses(req, res) {
  const killed = runner.killAll();
  logger.info(`Admin kill-all from ${req.ip} — killed ${killed} processes`);
  res.json({ ok: true, killed });
}

// ── Network health ────────────────────────────────────────────────────────────

async function getNetworkHealth(req, res) {
  const results = await networkService.checkAllNetworks();
  res.json({ networks: results, ts: Date.now() });
}

async function getNetworkStatus(req, res) {
  const network = req.params.network;
  const result  = await networkService.checkNetwork(network);
  res.json(result);
}

// ── Config ────────────────────────────────────────────────────────────────────

const FILE_MAP = {
  peaq:      ["hardhat.config.js", "hardhat.config.ts"],
  hardhat:   ["hardhat.config.js", "hardhat.config.ts"],
  evm:       ["foundry.toml"],
  ink:       ["Cargo.toml"],
  substrate: ["Cargo.toml"],
  did:       ["hardhat.config.js", "hardhat.config.ts"],
};

const ALLOWED_CONFIG_EXTENSIONS = new Set([".js", ".ts", ".toml", ".json", ".md", ".txt"]);
const MAX_CONFIG_SIZE = 1024 * 1024;

function getConfig(req, res) {
  const dir   = req.query.dir ? sanitizePath(req.query.dir) : os.homedir();
  const chain = req.query.chain || "peaq";

  const candidates = FILE_MAP[chain] || FILE_MAP.peaq;
  let usePath = null;
  const rootDir = path.resolve(os.homedir());

  for (const filename of candidates) {
    const candidate = path.resolve(path.join(dir, filename));
    // A04: Ensure candidate stays under homedir
    if (!candidate.startsWith(rootDir + path.sep) && candidate !== rootDir) continue;
    if (fs.existsSync(candidate)) {
      // A04: No symlinks
      try { if (fs.lstatSync(candidate).isSymbolicLink()) continue; } catch { continue; }
      usePath = candidate;
      break;
    }
  }

  if (!usePath) return res.json({ exists: false, content: "", filename: candidates[0] });

  const ext = path.extname(usePath);
  if (!ALLOWED_CONFIG_EXTENSIONS.has(ext)) return res.status(400).json({ error: "File type not allowed" });

  const stat = fs.statSync(usePath);
  if (stat.size > MAX_CONFIG_SIZE) return res.status(400).json({ error: "Config file too large" });

  const content = fs.readFileSync(usePath, "utf8");
  if (/private.*key\s*[:=]/i.test(content) || /PEAQ_FORGE_TOKEN/i.test(content)) {
    return res.json({ exists: true, content: "// [REDACTED — contains sensitive data]", filename: path.basename(usePath) });
  }

  res.json({ exists: true, content, path: usePath, filename: path.basename(usePath) });
}

module.exports = {
  getDeployments,
  clearDeployments,
  getAdminStatus,
  killAllProcesses,
  getNetworkHealth,
  getNetworkStatus,
  getConfig,
};
