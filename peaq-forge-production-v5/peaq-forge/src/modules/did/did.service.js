"use strict";

const crypto = require("crypto");
const os     = require("os");
const path   = require("path");
const fs     = require("fs");
const runner = require("../../utils/runner");
const log    = require("../../utils/deployLog");
const logger = require("../../utils/logger");
const { sanitizeStr, isValidRpc, isValidWsUrl, redactSecrets } = require("../../utils/sanitize");
const config = require("../../config");

function getWsUrl(network) {
  return config.NETWORKS[network]?.ws || config.NETWORKS.agung.ws;
}

function validateUrl(url, network) {
  if (url && (isValidWsUrl(url) || isValidRpc(url))) return sanitizeStr(url);
  return getWsUrl(network || "agung");
}

async function runPeaqScript(script, label, sendFn, wsId, dir) {
  const tmpFile = path.join(os.tmpdir(), `peaq_did_${label.replace(/\s/g,"_")}_${Date.now()}.mjs`);
  try {
    fs.writeFileSync(tmpFile, script, { mode: 0o600 });
    return await runner.run("node", [tmpFile], dir || os.homedir(), sendFn, label, wsId);
  } catch (e) {
    logger.error(`${label} error: ` + redactSecrets(e.message || String(e)));
    throw e;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function createDID(dir, args, sendFn, wsId) {
  try {
    if (!args.name) throw new Error("DID name (hex) required");
    const url  = validateUrl(args.url, args.network);
    const suri = sanitizeStr(args.suri || "//Alice");
    const name = sanitizeStr(args.name);
    let doc    = args.document || '{"id":"did:peaq:machine"}';
    if (doc.startsWith("{")) {
      try { JSON.parse(doc); } catch { throw new Error("document must be valid JSON"); }
      doc = "0x" + Buffer.from(doc).toString("hex");
    }
    const script = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)}, seed: ${JSON.stringify(suri)} });
  try {
    const result = await sdk.did.createDid({ name: ${JSON.stringify(name)}, value: ${JSON.stringify(doc)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    const result = await runPeaqScript(script, "DID Create", sendFn, wsId, dir);
    log.record({ type: "did_create", tool: "peaq-sdk", chain: "peaq", name, dir });
    return result;
  } catch (e) { logger.error("createDID error: " + redactSecrets(e.message)); throw e; }
}

async function readDID(dir, args, sendFn, wsId) {
  try {
    if (!args.address && !args.name) throw new Error("address or name required");
    const url     = validateUrl(args.url, args.network);
    const address = sanitizeStr(args.address || "");
    const name    = sanitizeStr(args.name    || "");
    const script  = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)} });
  try {
    const result = await sdk.did.readDid({ name: ${JSON.stringify(name)}, address: ${JSON.stringify(address)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    return await runPeaqScript(script, "DID Read", sendFn, wsId, dir);
  } catch (e) { logger.error("readDID error: " + e.message); throw e; }
}

async function updateDID(dir, args, sendFn, wsId) {
  try {
    if (!args.name) throw new Error("DID name required");
    const url  = validateUrl(args.url, args.network);
    const suri = sanitizeStr(args.suri || "//Alice");
    const name = sanitizeStr(args.name);
    let doc    = args.document || "{}";
    if (doc.startsWith("{")) {
      try { JSON.parse(doc); } catch { throw new Error("document must be valid JSON"); }
      doc = "0x" + Buffer.from(doc).toString("hex");
    }
    const script = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)}, seed: ${JSON.stringify(suri)} });
  try {
    const result = await sdk.did.updateDid({ name: ${JSON.stringify(name)}, value: ${JSON.stringify(doc)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    return await runPeaqScript(script, "DID Update", sendFn, wsId, dir);
  } catch (e) { logger.error("updateDID error: " + redactSecrets(e.message)); throw e; }
}

async function removeDID(dir, args, sendFn, wsId) {
  try {
    if (!args.name) throw new Error("DID name required");
    const url  = validateUrl(args.url, args.network);
    const suri = sanitizeStr(args.suri || "//Alice");
    const name = sanitizeStr(args.name);
    const script = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)}, seed: ${JSON.stringify(suri)} });
  try {
    const result = await sdk.did.removeDid({ name: ${JSON.stringify(name)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    return await runPeaqScript(script, "DID Remove", sendFn, wsId, dir);
  } catch (e) { logger.error("removeDID error: " + redactSecrets(e.message)); throw e; }
}

module.exports = { createDID, readDID, updateDID, removeDID };
