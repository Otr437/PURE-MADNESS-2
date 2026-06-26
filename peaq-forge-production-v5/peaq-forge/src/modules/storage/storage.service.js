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

async function runScript(script, label, sendFn, wsId, dir) {
  const tmpFile = path.join(os.tmpdir(), `peaq_storage_${Date.now()}_${require("crypto").randomBytes(8).toString("hex")}.mjs`);
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

async function addItem(dir, args, sendFn, wsId) {
  try {
    if (!args.itemType) throw new Error("Item type (hex) required");
    const url      = validateUrl(args.url, args.network);
    const suri     = sanitizeStr(args.suri || "//Alice");
    const itemType = sanitizeStr(args.itemType);
    const value    = sanitizeStr(args.value || "0x");
    const script   = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)}, seed: ${JSON.stringify(suri)} });
  try {
    const result = await sdk.storage.addItem({ itemType: ${JSON.stringify(itemType)}, item: ${JSON.stringify(value)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    const result = await runScript(script, "Storage Add", sendFn, wsId, dir);
    log.record({ type: "storage_add", tool: "peaq-sdk", chain: "peaq", itemType, dir });
    return result;
  } catch (e) { logger.error("addItem error: " + redactSecrets(e.message)); throw e; }
}

async function getItem(dir, args, sendFn, wsId) {
  try {
    if (!args.itemType) throw new Error("Item type required");
    const url      = validateUrl(args.url, args.network);
    const address  = sanitizeStr(args.address || "");
    const itemType = sanitizeStr(args.itemType);
    const script   = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)} });
  try {
    const result = await sdk.storage.getItem({ itemType: ${JSON.stringify(itemType)}, address: ${JSON.stringify(address)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    return await runScript(script, "Storage Get", sendFn, wsId, dir);
  } catch (e) { logger.error("getItem error: " + e.message); throw e; }
}

async function updateItem(dir, args, sendFn, wsId) {
  try {
    if (!args.itemType) throw new Error("Item type required");
    const url      = validateUrl(args.url, args.network);
    const suri     = sanitizeStr(args.suri || "//Alice");
    const itemType = sanitizeStr(args.itemType);
    const value    = sanitizeStr(args.value || "0x");
    const script   = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)}, seed: ${JSON.stringify(suri)} });
  try {
    const result = await sdk.storage.updateItem({ itemType: ${JSON.stringify(itemType)}, item: ${JSON.stringify(value)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    return await runScript(script, "Storage Update", sendFn, wsId, dir);
  } catch (e) { logger.error("updateItem error: " + redactSecrets(e.message)); throw e; }
}

async function removeItem(dir, args, sendFn, wsId) {
  try {
    if (!args.itemType) throw new Error("Item type required");
    const url      = validateUrl(args.url, args.network);
    const suri     = sanitizeStr(args.suri || "//Alice");
    const itemType = sanitizeStr(args.itemType);
    const script   = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)}, seed: ${JSON.stringify(suri)} });
  try {
    const result = await sdk.storage.removeItem({ itemType: ${JSON.stringify(itemType)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    return await runScript(script, "Storage Remove", sendFn, wsId, dir);
  } catch (e) { logger.error("removeItem error: " + redactSecrets(e.message)); throw e; }
}

module.exports = { addItem, getItem, updateItem, removeItem };
