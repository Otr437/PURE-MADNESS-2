"use strict";

const runner = require("../../utils/runner");
const log    = require("../../utils/deployLog");
const logger = require("../../utils/logger");
const { sanitizeStr, sanitizeArgs, isValidRpc, redactSecrets } = require("../../utils/sanitize");

async function build(dir, args, sendFn, wsId) {
  try {
    const a = ["build"];
    if (args.optimize) a.push("--optimize");
    if (args.via_ir)   a.push("--via-ir");
    if (args.sizes)    a.push("--sizes");
    return await runner.run("forge", a, dir, sendFn, "Forge Build", wsId);
  } catch (e) { logger.error("forge build error: " + e.message); throw e; }
}

async function clean(dir, sendFn, wsId) {
  try {
    return await runner.run("forge", ["clean"], dir, sendFn, "Forge Clean", wsId);
  } catch (e) { logger.error("forge clean error: " + e.message); throw e; }
}

async function test(dir, args, sendFn, wsId) {
  try {
    const a = ["test"];
    if (args.filter)   a.push("--match-test",     sanitizeStr(args.filter));
    if (args.contract) a.push("--match-contract",  sanitizeStr(args.contract));
    if (args.verbose)  a.push("-vvv");
    if (args.gas)      a.push("--gas-report");
    if (args.fork_url) {
      if (!isValidRpc(args.fork_url)) throw new Error("fork_url must be https:// or localhost");
      a.push("--fork-url", sanitizeStr(args.fork_url));
    }
    return await runner.run("forge", a, dir, sendFn, "Forge Test", wsId);
  } catch (e) { logger.error("forge test error: " + e.message); throw e; }
}

async function create(dir, args, sendFn, wsId) {
  try {
    if (!args.contract) throw new Error("Contract path required e.g. src/Token.sol:Token");
    if (args.rpc_url && !isValidRpc(args.rpc_url)) throw new Error("rpc_url must be https:// or localhost");
    const a = ["create", sanitizeStr(args.contract)];
    if (args.rpc_url)          a.push("--rpc-url",       sanitizeStr(args.rpc_url));
    if (args.private_key)      a.push("--private-key",   sanitizeStr(args.private_key));
    if (args.constructor_args) { a.push("--constructor-args"); a.push(...sanitizeArgs(args.constructor_args.trim().split(/\s+/).filter(Boolean))); }
    const result  = await runner.run("forge", a, dir, sendFn, "Forge Create", wsId);
    const addrM   = (result.stdout + result.stderr).match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/i);
    if (addrM) {
      sendFn("contract_address", { address: addrM[1], chain: "evm", label: "Forge Create" });
      log.record({ type: "deploy", tool: "forge", chain: "peaq-evm", contractAddress: addrM[1], dir });
    }
    return result;
  } catch (e) { logger.error("forge create error: " + redactSecrets(e.message)); throw e; }
}

async function script(dir, args, sendFn, wsId) {
  try {
    if (!args.script) throw new Error("Script path required");
    if (args.rpc_url && !isValidRpc(args.rpc_url)) throw new Error("rpc_url must be https:// or localhost");
    const a = ["script", sanitizeStr(args.script)];
    if (args.rpc_url)     a.push("--rpc-url",     sanitizeStr(args.rpc_url));
    if (args.private_key) a.push("--private-key", sanitizeStr(args.private_key));
    if (args.broadcast)   a.push("--broadcast");
    if (args.slow)        a.push("--slow");
    return await runner.run("forge", a, dir, sendFn, "Forge Script", wsId);
  } catch (e) { logger.error("forge script error: " + redactSecrets(e.message)); throw e; }
}

async function castCall(dir, args, sendFn, wsId) {
  try {
    if (!args.to || !args.sig) throw new Error("to and sig required");
    if (args.rpc_url && !isValidRpc(args.rpc_url)) throw new Error("rpc_url must be https:// or localhost");
    const a = ["call", sanitizeStr(args.to), sanitizeStr(args.sig)];
    if (args.calldata) a.push(...sanitizeArgs(args.calldata.trim().split(/\s+/).filter(Boolean)));
    if (args.rpc_url)  a.push("--rpc-url", sanitizeStr(args.rpc_url));
    return await runner.run("cast", a, dir, sendFn, "Cast Call", wsId);
  } catch (e) { logger.error("cast call error: " + e.message); throw e; }
}

async function castSend(dir, args, sendFn, wsId) {
  try {
    if (!args.to || !args.sig) throw new Error("to and sig required");
    if (args.rpc_url && !isValidRpc(args.rpc_url)) throw new Error("rpc_url must be https:// or localhost");
    const a = ["send", sanitizeStr(args.to), sanitizeStr(args.sig)];
    if (args.calldata)    a.push(...sanitizeArgs(args.calldata.trim().split(/\s+/).filter(Boolean)));
    if (args.rpc_url)     a.push("--rpc-url",     sanitizeStr(args.rpc_url));
    if (args.private_key) a.push("--private-key", sanitizeStr(args.private_key));
    if (args.value)       a.push("--value",        sanitizeStr(args.value));
    return await runner.run("cast", a, dir, sendFn, "Cast Send", wsId);
  } catch (e) { logger.error("cast send error: " + redactSecrets(e.message)); throw e; }
}

async function castBalance(dir, args, sendFn, wsId) {
  try {
    if (!args.address) throw new Error("address required");
    if (args.rpc_url && !isValidRpc(args.rpc_url)) throw new Error("rpc_url must be https:// or localhost");
    const a = ["balance", sanitizeStr(args.address)];
    if (args.rpc_url) a.push("--rpc-url", sanitizeStr(args.rpc_url));
    if (args.ether)   a.push("--ether");
    return await runner.run("cast", a, dir, sendFn, "Cast Balance", wsId);
  } catch (e) { logger.error("cast balance error: " + e.message); throw e; }
}

async function anvil(dir, args, sendFn, wsId) {
  try {
    const a = [];
    if (args.port)       a.push("--port",       sanitizeStr(args.port));
    if (args.chain_id)   a.push("--chain-id",   sanitizeStr(args.chain_id));
    if (args.accounts)   a.push("--accounts",   sanitizeStr(args.accounts));
    if (args.block_time) a.push("--block-time",  sanitizeStr(args.block_time));
    if (args.fork_url) {
      if (!isValidRpc(args.fork_url)) throw new Error("fork_url must be https://");
      a.push("--fork-url", sanitizeStr(args.fork_url));
    }
    return await runner.run("anvil", a, dir, sendFn, "Anvil", wsId);
  } catch (e) { logger.error("anvil error: " + e.message); throw e; }
}

module.exports = { build, clean, test, create, script, castCall, castSend, castBalance, anvil };
