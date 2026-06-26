"use strict";

const crypto = require("crypto");
const os     = require("os");
const path   = require("path");
const fs     = require("fs");
const { spawn } = require("child_process");
const runner = require("../../utils/runner");
const logger = require("../../utils/logger");
const { sanitizeStr, isValidRpc, isValidWsUrl, redactSecrets } = require("../../utils/sanitize");
const config = require("../../config");

function findSubstrateBin() {
  const bins = ["substrate-node-template", "substrate", "node-template", "peaq-node"];
  for (const bin of bins) {
    try {
      const result = require("child_process").spawnSync(bin, ["--version"], { shell: false });
      if (result.status === 0) return bin;
    } catch (e) { logger.debug(`[substrate] probe failed for '${bin}': ${e.message}`); }
  }
  return null;
}

async function startNode(dir, args, sendFn, wsId) {
  try {
    const bin = findSubstrateBin();
    if (!bin) throw new Error("No substrate node binary found. Install substrate-node-template or peaq-node and add to PATH.");
    const a = [];
    if (args.dev)         a.push("--dev");
    if (args.purge)       { a.push("--purge-chain"); if (!a.includes("--dev")) a.push("--dev"); }
    if (args.rpcExternal) a.push("--rpc-external");
    return await runner.run(bin, a, dir, sendFn, "Substrate Node", wsId);
  } catch (e) { logger.error("substrate node error: " + e.message); throw e; }
}

async function buildRuntime(dir, args, sendFn, wsId) {
  try {
    const a = ["build"];
    if (args.release) a.push("--release");
    return await runner.run("cargo", a, dir, sendFn, "Substrate Build", wsId);
  } catch (e) { logger.error("substrate build error: " + e.message); throw e; }
}

async function checkRuntime(dir, sendFn, wsId) {
  try {
    return await runner.run("cargo", ["check"], dir, sendFn, "Substrate Build", wsId);
  } catch (e) { logger.error("substrate check error: " + e.message); throw e; }
}

async function rpcCall(dir, args, sendFn, wsId) {
  try {
    if (!args.method) throw new Error("RPC method required");

    const url    = args.url && (isValidWsUrl(args.url) || isValidRpc(args.url))
                   ? sanitizeStr(args.url)
                   : config.NETWORKS.agung.ws;
    const method = sanitizeStr(args.method);

    let params = "[]";
    try {
      params = args.params ? JSON.stringify(JSON.parse(args.params)) : "[]";
    } catch {
      throw new Error("params must be a valid JSON array");
    }

    const script = `
const WebSocket = require('ws');
const ws = new WebSocket(${JSON.stringify(url)});
let resolved = false;
const timeout = setTimeout(() => {
  if (!resolved) {
    resolved = true;
    console.error('RPC call timeout after 10s');
    ws.close();
    process.exit(1);
  }
}, 10000);
ws.on('open', () => {
  ws.send(JSON.stringify({ id: 1, jsonrpc: '2.0', method: ${JSON.stringify(method)}, params: ${params} }));
});
ws.on('message', (data) => {
  if (resolved) return;
  resolved = true;
  clearTimeout(timeout);
  try { console.log(JSON.stringify(JSON.parse(data.toString()), null, 2)); }
  catch { console.log(data.toString()); }
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => {
  if (resolved) return;
  resolved = true;
  clearTimeout(timeout);
  console.error('WS Error: ' + e.message);
  process.exit(1);
});
`;
    const tmpFile = path.join(os.tmpdir(), `peaq_forge_rpc_${Date.now()}_${require("crypto").randomBytes(8).toString("hex")}.js`);
    try {
      fs.writeFileSync(tmpFile, script, { mode: 0o600 });
      return await runner.run("node", [tmpFile], dir, sendFn, "Substrate RPC", wsId);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch (e) { logger.error("substrate rpc error: " + e.message); throw e; }
}

module.exports = { startNode, buildRuntime, checkRuntime, rpcCall };
