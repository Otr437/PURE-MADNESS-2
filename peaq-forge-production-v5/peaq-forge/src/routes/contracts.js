"use strict";

const router = require("express").Router();
const path   = require("path");
const fs     = require("fs");
const os     = require("os");
const { sanitizePath, sanitizeFilePath } = require("../utils/sanitize");
const logger = require("../utils/logger");

const ALLOWED_EXTENSIONS = new Set([".json"]);

function walkDir(dir, ext, depth = 0) {
  if (depth > 4) return [];
  let results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        // A04: Skip symlinked directories to prevent traversal outside targetDir
        try { if (fs.lstatSync(fp).isSymbolicLink()) continue; } catch { continue; }
        results = results.concat(walkDir(fp, ext, depth + 1));
      } else if (
        e.name.endsWith(ext) &&
        !e.name.endsWith(".dbg.json") &&
        !e.name.includes("metadata") &&
        !e.name.includes("build-info")
      ) {
        try {
          const stat = fs.statSync(fp);
          if (stat.size > 10 * 1024 * 1024) continue; // skip files over 10MB
          const p = JSON.parse(fs.readFileSync(fp, "utf8"));
          // Only include actual contract artifacts that have abi or bytecode
          if (!Array.isArray(p.abi) && !p.bytecode && !p.deployedBytecode) continue;
          results.push({
            name:       e.name.replace(ext, ""),
            path:       fp,
            filename:   e.name,
            sizeKb:     Math.round(stat.size / 1024 * 10) / 10,
            abiEntries: Array.isArray(p.abi) ? p.abi.length : null,
          });
        } catch (parseErr) {
          // Skip unparseable files silently
        }
      }
    }
  } catch (e) {
    logger.warn("walkDir error in " + dir + ": " + e.message);
  }
  return results;
}

router.get("/", (req, res) => {
  try {
    const projectDir = req.query.dir ? sanitizePath(req.query.dir) : os.homedir();
    const chain      = req.query.chain || "peaq";

    let targetDir, ext;
    if (chain === "peaq" || chain === "hardhat") {
      const hDir = path.join(projectDir, "artifacts");
      const fDir = path.join(projectDir, "out");
      if      (fs.existsSync(hDir)) { targetDir = hDir; ext = ".json"; }
      else if (fs.existsSync(fDir)) { targetDir = fDir; ext = ".json"; }
      else return res.json({ contracts: [], error: "No artifacts/ or out/ dir found. Run compile first." });
    } else if (chain === "evm") {
      targetDir = path.join(projectDir, "out");
      ext = ".json";
      if (!fs.existsSync(targetDir)) return res.json({ contracts: [], error: "No out/ dir. Run forge build first." });
    } else {
      return res.status(400).json({ contracts: [], error: "chain must be peaq, hardhat, or evm" });
    }

    const contracts = walkDir(targetDir, ext);
    res.json({ contracts, targetDir });
  } catch (e) {
    logger.error("Contracts route error: " + e.message);
    res.status(500).json({ contracts: [], error: "Failed to load contracts" });
  }
});

router.get("/abi", (req, res) => {
  try {
    if (!req.query.path) return res.status(400).json({ error: "path required" });

    // A04: Enforce path stays under homedir — prevents reading arbitrary system files
    let sp;
    try {
      sp = sanitizeFilePath(req.query.path, os.homedir());
    } catch {
      return res.status(400).json({ error: "Path not allowed" });
    }

    // Validate extension
    if (!ALLOWED_EXTENSIONS.has(path.extname(sp))) {
      return res.status(400).json({ error: "Only .json files allowed" });
    }

    // Validate file exists and is a regular file (not symlink escaping root)
    if (!fs.existsSync(sp)) return res.status(404).json({ error: "File not found" });
    const stat = fs.lstatSync(sp); // lstatSync catches symlinks
    if (stat.isSymbolicLink()) return res.status(400).json({ error: "Symlinks not allowed" });
    if (!stat.isFile()) return res.status(400).json({ error: "Not a file" });
    if (stat.size > 10 * 1024 * 1024) return res.status(400).json({ error: "File too large" });

    const abiContent = JSON.parse(fs.readFileSync(sp, "utf8"));
    res.json({ abi: abiContent.abi || [] });
  } catch (e) {
    logger.error("ABI route error: " + e.message);
    res.status(500).json({ error: "Failed to load ABI" });
  }
});

module.exports = router;
