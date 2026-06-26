"use strict";

const WebSocket = require("ws");
const os        = require("os");
const crypto    = require("crypto");
const config    = require("../config");
const logger    = require("../utils/logger");
const runner    = require("../utils/runner");
const { sanitizeStr, sanitizeArgs, isValidRpc } = require("../utils/sanitize");
const { timingSafeCompare } = require("../middleware/auth");
const { validate }          = require("../validators");

const hardhat   = require("../modules/evm/hardhat.service");
const foundry   = require("../modules/foundry/foundry.service");
const ink       = require("../modules/ink/ink.service");
const substrate = require("../modules/substrate/substrate.service");
const did       = require("../modules/did/did.service");
const storage   = require("../modules/storage/storage.service");
const rbac      = require("../modules/rbac/rbac.service");
const mnft      = require("../modules/mnft/mnft.service");

const ALLOWED_CUSTOM = new Set(["forge","cast","anvil","npx","cargo","npm","node","ls","cat","pwd","echo"]);

const LOCALHOST_IPS = ["127.0.0.1","::1","::ffff:127.0.0.1"];

function verifyClient(info) {
  const ip     = info.req.socket.remoteAddress || "";
  const origin = info.origin || "";
  if (!LOCALHOST_IPS.includes(ip)) {
    logger.warn("WS rejected non-localhost IP: " + ip);
    return false;
  }
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    logger.warn("WS rejected bad origin: " + origin);
    return false;
  }
  return true;
}

let wss;
let wsIdCounter = 0;

function init(server) {
  wss = new WebSocket.Server({ server, verifyClient, maxPayload: 512 * 1024 });

  wss.on("connection", (ws, req) => {
    const wsId = ++wsIdCounter;
    let authed = false;
    let msgCount = 0;
    let windowStart = Date.now();
    const RATE_LIMIT  = 120;
    const WINDOW_MS   = 60000;
    let authFailCount = 0;
    const MAX_AUTH_FAILURES = 5; // A07: close connection after 5 bad tokens
    logger.info(`WS #${wsId} connected from ${req.socket.remoteAddress}`);

    function send(type, data) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, data, ts: Date.now() }));
      }
    }

    function sendFn(type, data) { send(type, data); }

    ws.on("message", async raw => {
      const now = Date.now();
      if (now - windowStart > WINDOW_MS) { msgCount = 0; windowStart = now; }
      if (++msgCount > RATE_LIMIT) {
        send("error", { message: "Rate limit exceeded. Slow down." });
        return;
      }
      let payload;
      try { payload = JSON.parse(raw.toString()); }
      catch { return send("error", { message: "Invalid JSON" }); }

      if (!authed) {
        if (payload.action === "auth" && timingSafeCompare(payload.token, config.AUTH_TOKEN)) {
          authed = true;
          authFailCount = 0;
          return send("authed", { message: "Authenticated" });
        }
        // A07: Brute-force protection — close after max failures
        authFailCount++;
        logger.warn(`WS #${wsId} auth failure ${authFailCount}/${MAX_AUTH_FAILURES}`);
        if (authFailCount >= MAX_AUTH_FAILURES) {
          send("error", { message: "Too many auth failures — connection closed" });
          return ws.terminate();
        }
        return send("error", { message: "Not authenticated" });
      }

      const { action, projectDir, args = {} } = payload;

      // ── Validate args against Joi schema before dispatch ─────────────────
      const { value: validArgs, error: validErr } = validate(action, args);
      if (validErr) {
        logger.warn(`WS #${wsId} validation failed for '${action}': ${validErr}`);
        return send("error", { message: `Validation error: ${validErr}` });
      }

      const dir = projectDir ? require("path").resolve(projectDir) : os.homedir();

      try {
        switch (action) {

          case "kill":
            if (runner.kill(wsId)) send("killed", { message: "Process terminated" });
            else send("info", { message: "No active process" });
            break;

          // ── peaq EVM / Hardhat ─────────────────────────────────────────────
          case "init_hardhat_peaq": await hardhat.initConfig(dir, validArgs, sendFn); break;
          case "peaq_compile":      await hardhat.compile(dir, sendFn, wsId); break;
          case "hardhat_clean":     await hardhat.clean(dir, sendFn, wsId); break;
          case "peaq_test":         await hardhat.test(dir, validArgs, sendFn, wsId); break;
          case "peaq_deploy":       await hardhat.deploy(dir, validArgs, sendFn, wsId); break;
          case "peaq_verify":       await hardhat.verify(dir, validArgs, sendFn, wsId); break;

          // ── Foundry ────────────────────────────────────────────────────────
          case "forge_build":        await foundry.build(dir, validArgs, sendFn, wsId); break;
          case "forge_clean":        await foundry.clean(dir, sendFn, wsId); break;
          case "forge_test":         await foundry.test(dir, validArgs, sendFn, wsId); break;
          case "forge_create":       await foundry.create(dir, validArgs, sendFn, wsId); break;
          case "forge_script":       await foundry.script(dir, validArgs, sendFn, wsId); break;
          case "cast_call":          await foundry.castCall(dir, validArgs, sendFn, wsId); break;
          case "cast_send":          await foundry.castSend(dir, validArgs, sendFn, wsId); break;
          case "peaq_cast_call":     await foundry.castCall(dir, validArgs, sendFn, wsId); break;
          case "peaq_cast_send":     await foundry.castSend(dir, validArgs, sendFn, wsId); break;
          case "peaq_cast_balance":  await foundry.castBalance(dir, validArgs, sendFn, wsId); break;
          case "anvil_start":        await foundry.anvil(dir, validArgs, sendFn, wsId); break;
          case "peaq_anvil":         await foundry.anvil(dir, validArgs, sendFn, wsId); break;

          // ── ink! ───────────────────────────────────────────────────────────
          case "ink_new":            await ink.newContract(dir, validArgs, sendFn, wsId); break;
          case "ink_build":          await ink.build(dir, validArgs, sendFn, wsId); break;
          case "ink_check":          await ink.check(dir, sendFn, wsId); break;
          case "ink_test":           await ink.test(dir, validArgs, sendFn, wsId); break;
          case "ink_instantiate":    await ink.instantiate(dir, validArgs, sendFn, wsId); break;
          case "ink_call":           await ink.call(dir, validArgs, sendFn, wsId); break;

          // ── Substrate ──────────────────────────────────────────────────────
          case "substrate_node":     await substrate.startNode(dir, validArgs, sendFn, wsId); break;
          case "substrate_build":    await substrate.buildRuntime(dir, validArgs, sendFn, wsId); break;
          case "substrate_check":    await substrate.checkRuntime(dir, sendFn, wsId); break;
          case "substrate_rpc_call": await substrate.rpcCall(dir, validArgs, sendFn, wsId); break;

          // ── peaq DID ───────────────────────────────────────────────────────
          case "did_create":         await did.createDID(dir, validArgs, sendFn, wsId); break;
          case "did_read":           await did.readDID(dir, validArgs, sendFn, wsId); break;
          case "did_update":         await did.updateDID(dir, validArgs, sendFn, wsId); break;
          case "did_remove":         await did.removeDID(dir, validArgs, sendFn, wsId); break;

          // ── peaq Storage ───────────────────────────────────────────────────
          case "storage_add":        await storage.addItem(dir, validArgs, sendFn, wsId); break;
          case "storage_get":        await storage.getItem(dir, validArgs, sendFn, wsId); break;
          case "storage_update":     await storage.updateItem(dir, validArgs, sendFn, wsId); break;
          case "storage_remove":     await storage.removeItem(dir, validArgs, sendFn, wsId); break;

          // ── peaq RBAC ──────────────────────────────────────────────────────
          case "rbac_add_role":      await rbac.addRole(dir, validArgs, sendFn, wsId); break;
          case "rbac_fetch_roles":   await rbac.fetchRoles(dir, validArgs, sendFn, wsId); break;
          case "rbac_assign_role":   await rbac.assignRoleToUser(dir, validArgs, sendFn, wsId); break;
          case "rbac_add_permission":await rbac.addPermission(dir, validArgs, sendFn, wsId); break;

          // ── Machine NFT ────────────────────────────────────────────────────
          case "mnft_owner":         await mnft.ownerOf(dir, validArgs, sendFn, wsId); break;
          case "mnft_uri_q":         await mnft.tokenURI(dir, validArgs, sendFn, wsId); break;
          case "mnft_did_q":         await mnft.getDID(dir, validArgs, sendFn, wsId); break;
          case "mnft_bind":          await mnft.bindDID(dir, validArgs, sendFn, wsId); break;

          // ── Custom sandbox ─────────────────────────────────────────────────
          case "custom": {
            const rawCmd = (args.command || "").trim();
            if (!rawCmd) throw new Error("Command required");
            const parts = rawCmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
            if (!parts.length) throw new Error("Empty command");
            const cmdName = parts[0].replace(/['"]/g, "");
            // A03: Block path traversal in command name
            if (cmdName.includes("/") || cmdName.includes("\\") || cmdName.includes("..")) {
              throw new Error("Command name must not contain path separators");
            }
            if (!ALLOWED_CUSTOM.has(cmdName)) throw new Error(`'${cmdName}' not allowed. Allowed: ${[...ALLOWED_CUSTOM].join(", ")}`);
            // A03: Block node eval/require — prevents arbitrary code execution
            if (cmdName === "node") {
              const nodeArgCheck = parts.slice(1).map(a => a.replace(/^['"']|['"']$/g, ""));
              const dangerousFlags = ["-e","--eval","-p","--print","-r","--require","--loader","--import"];
              if (nodeArgCheck.some(a => dangerousFlags.includes(a.split("=")[0]))) {
                throw new Error("node eval/require flags not allowed in custom commands");
              }
            }
            // A03: cat — restrict to files under homedir
            if (cmdName === "cat") {
              const { sanitizeFilePath } = require("../utils/sanitize");
              const catArgCheck = parts.slice(1).map(a => a.replace(/^['"']|['"']$/g, ""));
              for (const a of catArgCheck) {
                if (a.startsWith("-")) continue;
                try { sanitizeFilePath(a, require("os").homedir()); }
                catch { throw new Error(`cat: path not allowed outside home directory`); }
              }
            }
            const cmdArgs = parts.slice(1).map(a => a.replace(/^['"']|['"']$/g, "")).filter(a => !/[;&|`$><\n\r]/.test(a));
            await runner.run(cmdName, cmdArgs, dir, sendFn, `Custom: ${rawCmd}`, wsId);
            break;
          }

          default:
            send("error", { message: `Unknown action: ${action}` });
        }
      } catch (err) {
        const msg = err.error || err.message || String(err);
        logger.error(`WS #${wsId} action '${action}' failed: ${msg}`);
        send("command_failed", { message: msg });
      }
    });

    ws.on("close", () => {
      runner.kill(wsId);
      logger.info(`WS #${wsId} disconnected`);
    });

    ws.on("error", err => logger.error(`WS #${wsId} error: ${err.message}`));
  });

  return wss;
}

function getClientCount() {
  return wss ? wss.clients.size : 0;
}

module.exports = { init, getClientCount };
