"use strict";

const path   = require("path");
const fs     = require("fs");
const runner = require("../../utils/runner");
const log    = require("../../utils/deployLog");
const logger = require("../../utils/logger");
const { sanitizeStr, sanitizePath, isValidRpc, isValidWsUrl, redactSecrets } = require("../../utils/sanitize");

async function newContract(dir, args, sendFn, wsId) {
  try {
    if (!args.name) throw new Error("Contract name required");
    const name = sanitizeStr(args.name).replace(/[^a-zA-Z0-9_]/g, "_");
    if (!name) throw new Error("Invalid contract name");
    return await runner.run("cargo", ["contract", "new", name], dir, sendFn, "ink! New", wsId);
  } catch (e) { logger.error("ink new error: " + e.message); throw e; }
}

async function build(dir, args, sendFn, wsId) {
  try {
    const a = ["contract", "build"];
    if (args.release) a.push("--release");
    return await runner.run("cargo", a, dir, sendFn, "ink! Build", wsId);
  } catch (e) { logger.error("ink build error: " + e.message); throw e; }
}

async function check(dir, sendFn, wsId) {
  try {
    return await runner.run("cargo", ["contract", "check"], dir, sendFn, "ink! Check", wsId);
  } catch (e) { logger.error("ink check error: " + e.message); throw e; }
}

async function test(dir, args, sendFn, wsId) {
  try {
    const a = ["test"];
    if (args.filter) a.push(sanitizeStr(args.filter));
    return await runner.run("cargo", a, dir, sendFn, "ink! Test", wsId);
  } catch (e) { logger.error("ink test error: " + e.message); throw e; }
}

async function instantiate(dir, args, sendFn, wsId) {
  try {
    if (!args.wasmFile) throw new Error(".contract file path required");
    // A04: Restrict .contract file to within homedir
    const { sanitizeFilePath: sfp } = require("../../utils/sanitize");
    let safeFile;
    try { safeFile = sfp(args.wasmFile, require("os").homedir()); }
    catch { throw new Error("File path not allowed"); }
    if (!fs.existsSync(safeFile)) throw new Error("File not found");
    // Symlink check
    const wfStat = fs.lstatSync(safeFile);
    if (wfStat.isSymbolicLink()) throw new Error("Symlinks not allowed");
    if (!safeFile.endsWith(".contract")) throw new Error("Only .contract files allowed");

    const url = args.url && isValidWsUrl(args.url) ? sanitizeStr(args.url) : "wss://wss.agung.peaq.network";
    const suri = sanitizeStr(args.suri || "//Alice");

    const a = [
      "contract", "instantiate",
      "--manifest-path", path.join(sanitizePath(dir), "Cargo.toml"),
      "--constructor", sanitizeStr(args.constructor || "new"),
      "--suri", suri,
      "--url", url,
    ];
    if (args.args) a.push("--args", sanitizeStr(args.args));

    const result = await runner.run("cargo", a, dir, sendFn, "ink! Instantiate", wsId);
    const out = result.stdout + result.stderr;
    const m   = out.match(/contract\s+account\s+id:\s*([A-Za-z0-9]+)/i)
             || out.match(/([5-9A-HJ-NP-Za-km-z]{47,48})/);
    if (m) {
      sendFn("contract_address", { address: m[1], chain: "ink", label: "ink! Instantiate" });
      log.record({ type: "instantiate", tool: "cargo-contract", chain: "ink", contractAddress: m[1], dir });
    }
    return result;
  } catch (e) { logger.error("ink instantiate error: " + redactSecrets(e.message)); throw e; }
}

async function call(dir, args, sendFn, wsId) {
  try {
    if (!args.contract) throw new Error("Contract address required");
    if (!args.message)  throw new Error("Message (function name) required");
    const url  = args.url && isValidWsUrl(args.url) ? sanitizeStr(args.url) : "wss://wss.agung.peaq.network";
    const suri = sanitizeStr(args.suri || "//Alice");
    const a    = [
      "contract", "call",
      "--contract", sanitizeStr(args.contract),
      "--message",  sanitizeStr(args.message),
      "--suri",     suri,
      "--url",      url,
    ];
    if (args.args)   a.push("--args",    sanitizeStr(args.args));
    if (args.dryRun) a.push("--dry-run");
    return await runner.run("cargo", a, dir, sendFn, "ink! Call", wsId);
  } catch (e) { logger.error("ink call error: " + redactSecrets(e.message)); throw e; }
}

module.exports = { newContract, build, check, test, instantiate, call };
