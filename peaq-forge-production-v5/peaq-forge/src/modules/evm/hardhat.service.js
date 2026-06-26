"use strict";

const path     = require("path");
const fs       = require("fs");
const runner   = require("../../utils/runner");
const log      = require("../../utils/deployLog");
const { sanitizeStr, sanitizePath, sanitizeArgs, isValidRpc, redactSecrets } = require("../../utils/sanitize");
const config   = require("../../config");
const logger   = require("../../utils/logger");

function generateHardhatConfig(rpc, chainId) {
  const safeRpc     = isValidRpc(rpc) ? rpc : config.NETWORKS.agung.rpc;
  const safeChainId = parseInt(chainId, 10) || 9990;
  // A03: JSON.stringify all user-supplied values before injecting into JS template
  // This prevents quote injection (e.g. https://evil.com/", chainId: 1})
  const rpcJson      = JSON.stringify(safeRpc);
  const mainnetJson  = JSON.stringify(config.NETWORKS.mainnet.rpc);
  const agungJson    = JSON.stringify(config.NETWORKS.agung.rpc);
  const krestJson    = JSON.stringify(config.NETWORKS.krest.rpc);
  return `require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    peaq:   { url: ${mainnetJson}, chainId: 3338, accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [] },
    agung:  { url: ${agungJson},   chainId: 9990, accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [] },
    krest:  { url: ${krestJson},   chainId: 2241, accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [] },
    custom: { url: ${rpcJson}, chainId: ${safeChainId}, accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [] },
    local:  { url: "http://127.0.0.1:8545", chainId: 4242 },
  },
  etherscan: {
    apiKey: { peaq: "no-key-needed", agung: "no-key-needed" },
    customChains: [
      { network: "peaq",  chainId: 3338, urls: { apiURL: "https://peaq.subscan.io/api",  browserURL: "https://peaq.subscan.io"  } },
      { network: "agung", chainId: 9990, urls: { apiURL: "https://agung.subscan.io/api", browserURL: "https://agung.subscan.io" } },
    ],
  },
};
`;
}

async function initConfig(dir, args, sendFn) {
  try {
    const rpc     = args.rpc && isValidRpc(args.rpc) ? sanitizeStr(args.rpc) : config.NETWORKS.agung.rpc;
    const chainId = args.chainId || "9990";
    const content = generateHardhatConfig(rpc, chainId);
    const cfgPath = path.join(sanitizePath(dir), "hardhat.config.js");
    fs.writeFileSync(cfgPath, content, { mode: 0o644 });
    logger.info("Generated hardhat.config.js at " + cfgPath);
    sendFn("info",   { message: "Generated hardhat.config.js at " + cfgPath });
    sendFn("stdout", { text: content, label: "Hardhat Init" });
    sendFn("done",   { code: 0, label: "Hardhat Init", stdout: content, stderr: "" });
  } catch (e) {
    logger.error("initConfig error: " + e.message);
    sendFn("error", { message: "Failed to generate config: " + e.message });
  }
}

async function compile(dir, sendFn, wsId) {
  try {
    return await runner.run("npx", ["hardhat", "compile"], dir, sendFn, "Peaq Compile", wsId);
  } catch (e) {
    logger.error("compile error: " + redactSecrets(e.message || String(e)));
    throw e;
  }
}

async function clean(dir, sendFn, wsId) {
  try {
    return await runner.run("npx", ["hardhat", "clean"], dir, sendFn, "Hardhat Clean", wsId);
  } catch (e) {
    logger.error("clean error: " + e.message);
    throw e;
  }
}

async function test(dir, args, sendFn, wsId) {
  try {
    const a = ["hardhat", "test"];
    if (args.grep)     a.push("--grep",    sanitizeStr(args.grep));
    if (args.network)  a.push("--network", sanitizeStr(args.network));
    if (args.parallel) a.push("--parallel");
    if (args.gas)      a.push("--reporter", "gas");
    return await runner.run("npx", a, dir, sendFn, "Peaq Test", wsId);
  } catch (e) {
    logger.error("test error: " + e.message);
    throw e;
  }
}

async function deploy(dir, args, sendFn, wsId) {
  try {
    if (!args.script) throw new Error("Deploy script path required");
    const net    = sanitizeStr(args.network || "agung");
    const script = sanitizeStr(args.script);
    const a      = ["hardhat", "run", script, "--network", net === "custom" ? "custom" : net];

    // env_override: extra process env vars passed to the child (e.g. MULTISIG_OWNERS)
    const envOverride = {};
    if (args.env_override && typeof args.env_override === "object") {
      for (const [k, v] of Object.entries(args.env_override)) {
        const sk = sanitizeStr(String(k));
        if (/^[A-Z_][A-Z0-9_]*$/i.test(sk)) envOverride[sk] = sanitizeStr(String(v));
      }
    }

    const result = await runner.run("npx", a, dir, sendFn, "Peaq Deploy", wsId, envOverride);
    const out = result.stdout + result.stderr;
    const m   = out.match(/(?:deployed|address)[^0x]+(0x[0-9a-fA-F]{40})/i)
             || out.match(/(0x[0-9a-fA-F]{40})/);
    if (m) {
      sendFn("contract_address", { address: m[1], chain: "peaq", label: "Peaq Deploy" });
      log.record({ type: "deploy", tool: "hardhat", chain: "peaq", contractAddress: m[1], network: net, dir });
    }
    return result;
  } catch (e) {
    logger.error("deploy error: " + e.message);
    throw e;
  }
}

async function verify(dir, args, sendFn, wsId) {
  try {
    if (!args.address) throw new Error("Contract address required");
    const a = ["hardhat", "verify", sanitizeStr(args.address)];
    if (args.network) a.push("--network", sanitizeStr(args.network));
    if (args.args)    a.push(...sanitizeArgs(args.args.trim().split(/\s+/).filter(Boolean)));
    return await runner.run("npx", a, dir, sendFn, "Peaq Verify", wsId);
  } catch (e) {
    logger.error("verify error: " + e.message);
    throw e;
  }
}

module.exports = { initConfig, compile, clean, test, deploy, verify };
