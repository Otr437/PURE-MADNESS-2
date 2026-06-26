"use strict";

const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const logger = require("./logger");
const { redactSecrets } = require("./sanitize");

const LOG_FILE    = process.env.PEAQ_FORGE_LOG_FILE || path.join(os.homedir(), ".peaq_forge_deployments.json");
const BACKUP_FILE = LOG_FILE + ".backup";
const MAX_ENTRIES = 500;

let deployLog = [];

function load() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE, "utf8");
      deployLog = JSON.parse(raw);
      logger.info(`Deploy log loaded: ${deployLog.length} entries`);
    }
  } catch (e) {
    logger.error("Failed to load deploy log: " + e.message);
    // Try backup
    try {
      if (fs.existsSync(BACKUP_FILE)) {
        deployLog = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
        logger.info("Deploy log restored from backup");
      }
    } catch (be) {
      logger.error("Backup restore failed: " + be.message);
      deployLog = [];
    }
  }
  return deployLog;
}

function save() {
  try {
    const data = JSON.stringify(deployLog.slice(-MAX_ENTRIES), null, 2);
    // Backup existing file before overwrite
    if (fs.existsSync(LOG_FILE)) {
      fs.copyFileSync(LOG_FILE, BACKUP_FILE);
    }
    // Atomic write: write to tmp file then rename — prevents corruption on crash mid-write
    const tmpFile = LOG_FILE + ".tmp";
    fs.writeFileSync(tmpFile, data, { mode: 0o600 });
    fs.renameSync(tmpFile, LOG_FILE);
  } catch (e) {
    logger.error("Failed to save deploy log: " + e.message);
    // Clean up tmp if it exists
    try { fs.unlinkSync(LOG_FILE + ".tmp"); } catch {}
  }
}

function record(entry) {
  try {
    // Never log private keys or seeds
    const safe = {};
    for (const [k, v] of Object.entries(entry)) {
      if (/private|key|seed|suri|mnemonic/i.test(k)) continue;
      safe[k] = typeof v === "string" ? redactSecrets(v) : v;
    }
    deployLog.push({ ...safe, ts: Date.now() });
    save();
  } catch (e) {
    logger.error("Failed to record deployment: " + e.message);
  }
}

function getAll() {
  try {
    return deployLog.slice().reverse();
  } catch (e) {
    logger.error("Failed to get deployments: " + e.message);
    return [];
  }
}

function clear() {
  try {
    deployLog = [];
    save();
    logger.info("Deploy log cleared");
  } catch (e) {
    logger.error("Failed to clear deploy log: " + e.message);
  }
}

load();

module.exports = { record, getAll, clear, load };
