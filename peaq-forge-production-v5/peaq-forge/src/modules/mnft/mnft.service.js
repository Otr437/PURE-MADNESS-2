"use strict";

const runner = require("../../utils/runner");
const log    = require("../../utils/deployLog");
const logger = require("../../utils/logger");
const { sanitizeStr, isValidRpc, isEthAddress, redactSecrets } = require("../../utils/sanitize");
const config = require("../../config");

function getRpc(args) {
  if (args.rpc && isValidRpc(args.rpc)) return sanitizeStr(args.rpc);
  return config.NETWORKS.agung.rpc;
}

async function ownerOf(dir, args, sendFn, wsId) {
  try {
    if (!args.contract) throw new Error("Contract address required");
    if (!args.tokenId)  throw new Error("Token ID required");
    const rpc = getRpc(args);
    return await runner.run("cast", [
      "call", sanitizeStr(args.contract),
      "ownerOf(uint256)(address)",
      sanitizeStr(args.tokenId),
      "--rpc-url", rpc
    ], dir, sendFn, "mNFT ownerOf", wsId);
  } catch (e) { logger.error("ownerOf error: " + e.message); throw e; }
}

async function tokenURI(dir, args, sendFn, wsId) {
  try {
    if (!args.contract) throw new Error("Contract address required");
    if (!args.tokenId)  throw new Error("Token ID required");
    const rpc = getRpc(args);
    return await runner.run("cast", [
      "call", sanitizeStr(args.contract),
      "tokenURI(uint256)(string)",
      sanitizeStr(args.tokenId),
      "--rpc-url", rpc
    ], dir, sendFn, "mNFT tokenURI", wsId);
  } catch (e) { logger.error("tokenURI error: " + e.message); throw e; }
}

async function getDID(dir, args, sendFn, wsId) {
  try {
    if (!args.contract) throw new Error("Contract address required");
    if (!args.tokenId)  throw new Error("Token ID required");
    const rpc = getRpc(args);
    return await runner.run("cast", [
      "call", sanitizeStr(args.contract),
      "getDid(uint256)(bytes32)",
      sanitizeStr(args.tokenId),
      "--rpc-url", rpc
    ], dir, sendFn, "mNFT getDID", wsId);
  } catch (e) { logger.error("getDID error: " + e.message); throw e; }
}

async function bindDID(dir, args, sendFn, wsId) {
  try {
    if (!args.contract) throw new Error("Contract address required");
    if (!args.tokenId)  throw new Error("Token ID required");
    const rpc = getRpc(args);
    const a   = [
      "send", sanitizeStr(args.contract),
      "bindDid(uint256,bytes32)(bool)",
      sanitizeStr(args.tokenId),
      sanitizeStr(args.did || "0x0000000000000000000000000000000000000000000000000000000000000000"),
      "--rpc-url", rpc
    ];
    // Private key — never log it
    if (args.privateKey) a.push("--private-key", sanitizeStr(args.privateKey));
    const result = await runner.run("cast", a, dir, sendFn, "mNFT Bind DID", wsId);
    log.record({ type: "mnft_bind", tool: "cast", chain: "peaq-evm", contract: args.contract, tokenId: args.tokenId, dir });
    return result;
  } catch (e) { logger.error("bindDID error: " + redactSecrets(e.message)); throw e; }
}

module.exports = { ownerOf, tokenURI, getDID, bindDID };
