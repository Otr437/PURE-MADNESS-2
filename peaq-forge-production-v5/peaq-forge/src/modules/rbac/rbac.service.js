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
  const tmpFile = path.join(os.tmpdir(), `peaq_rbac_${Date.now()}_${require("crypto").randomBytes(8).toString("hex")}.mjs`);
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

async function addRole(dir, args, sendFn, wsId) {
  try {
    if (!args.roleId)   throw new Error("roleId (hex) required");
    if (!args.roleName) throw new Error("roleName required");
    const url      = validateUrl(args.url, args.network);
    const suri     = sanitizeStr(args.suri || "//Alice");
    const roleId   = sanitizeStr(args.roleId);
    const roleName = sanitizeStr(args.roleName);
    const script   = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)}, seed: ${JSON.stringify(suri)} });
  try {
    const result = await sdk.rbac.addRole({ roleId: ${JSON.stringify(roleId)}, name: ${JSON.stringify(roleName)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    const result = await runScript(script, "RBAC Add Role", sendFn, wsId, dir);
    log.record({ type: "rbac_add_role", tool: "peaq-sdk", chain: "peaq", roleId, dir });
    return result;
  } catch (e) { logger.error("addRole error: " + redactSecrets(e.message)); throw e; }
}

async function fetchRoles(dir, args, sendFn, wsId) {
  try {
    const url     = validateUrl(args.url, args.network);
    const address = sanitizeStr(args.address || "");
    const script  = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)} });
  try {
    const result = await sdk.rbac.fetchRoles({ owner: ${JSON.stringify(address)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    return await runScript(script, "RBAC Fetch Roles", sendFn, wsId, dir);
  } catch (e) { logger.error("fetchRoles error: " + e.message); throw e; }
}

async function assignRoleToUser(dir, args, sendFn, wsId) {
  try {
    if (!args.roleId) throw new Error("roleId required");
    if (!args.userId) throw new Error("userId required");
    const url    = validateUrl(args.url, args.network);
    const suri   = sanitizeStr(args.suri || "//Alice");
    const roleId = sanitizeStr(args.roleId);
    const userId = sanitizeStr(args.userId);
    const script = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)}, seed: ${JSON.stringify(suri)} });
  try {
    const result = await sdk.rbac.assignRoleToUser({ roleId: ${JSON.stringify(roleId)}, userId: ${JSON.stringify(userId)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    return await runScript(script, "RBAC Assign Role", sendFn, wsId, dir);
  } catch (e) { logger.error("assignRoleToUser error: " + redactSecrets(e.message)); throw e; }
}

async function addPermission(dir, args, sendFn, wsId) {
  try {
    if (!args.permissionId)   throw new Error("permissionId required");
    if (!args.permissionName) throw new Error("permissionName required");
    const url            = validateUrl(args.url, args.network);
    const suri           = sanitizeStr(args.suri || "//Alice");
    const permissionId   = sanitizeStr(args.permissionId);
    const permissionName = sanitizeStr(args.permissionName);
    const script         = `
import { Sdk } from '@peaq-network/sdk';
async function main() {
  const sdk = await Sdk.createInstance({ baseUrl: ${JSON.stringify(url)}, seed: ${JSON.stringify(suri)} });
  try {
    const result = await sdk.rbac.addPermission({ permissionId: ${JSON.stringify(permissionId)}, name: ${JSON.stringify(permissionName)} });
    const safeResult = JSON.parse(JSON.stringify({ success: true, result }).replace(/0x[0-9a-fA-F]{60,}/g, '[REDACTED]'));
    console.log(JSON.stringify(safeResult, null, 2));
  } finally { await sdk.disconnect(); }
}
main().catch(e => { console.error(JSON.stringify({ success: false, error: e.message })); process.exit(1); });
`;
    return await runScript(script, "RBAC Add Permission", sendFn, wsId, dir);
  } catch (e) { logger.error("addPermission error: " + redactSecrets(e.message)); throw e; }
}

module.exports = { addRole, fetchRoles, assignRoleToUser, addPermission };
