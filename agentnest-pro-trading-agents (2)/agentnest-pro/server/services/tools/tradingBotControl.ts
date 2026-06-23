/**
 * tradingBotControl tool — operates the user's existing STRATS strategy
 * bots (cross-exchange-arb, triangular-arb, cash-carry, dca, grid,
 * trend-following, momentum-scalp, mean-reversion, seasonal) as child
 * processes. This tool does NOT reimplement any strategy logic — the real
 * logic lives in the user's own scripts under STRATEGY_SCRIPTS_ROOT. This
 * tool only manages process lifecycle, config injection, and log capture.
 *
 * SAFETY MODEL — both modes, configurable per agent:
 *   - Default mode is DRY_RUN=true (signal/paper mode). This is what every
 *     one of the 9 specialty agents gets unless explicitly elevated.
 *   - Live trading (DRY_RUN=false) only happens if ALL of the following hold:
 *       1. The global setting LIVE_TRADING_ENABLED is exactly "true"
 *          (a master kill switch independent of any single agent).
 *       2. The calling agent's `capabilities` column includes "liveTrading"
 *          (this is what makes it configurable per agent — granted via
 *          PATCH /api/agents/:id { capabilities: [...] }).
 *       3. The task that triggered this tool call required approval and
 *          was approved (tasks.requires_approval=1 -> status must already
 *          be 'approved'/'running' by the time the ReAct loop reaches this
 *          tool — enforced upstream by the existing task pipeline, and
 *          re-checked here defensively).
 *       4. A financial_accounts row of type 'exchange' exists to supply
 *          real API credentials.
 *   - If any condition fails, the bot is launched with DRY_RUN=true
 *     regardless of what was requested, and the tool says so explicitly
 *     in its output rather than silently downgrading.
 */

import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs   from "fs";
import { registerTool, type ToolResult } from "./index.js";
import { queries, logEntry } from "../../db/index.js";
import { decrypt } from "../crypto.js";
import { broadcast } from "../../websocket/index.js";
import { getStrategyMeta, listStrategyIds } from "../strategies/registry.js";

interface RunningBot {
  proc:       ChildProcess;
  strategyId: string;
  agentId:    string | null;
  taskId:     string;
  dryRun:     boolean;
  startedAt:  number;
  logTail:    string[];
}

// Keyed by `${strategyId}:${agentId ?? "unassigned"}` — one running instance
// per strategy per agent at a time.
const runningBots = new Map<string, RunningBot>();

const MAX_LOG_TAIL = 200;

function botKey(strategyId: string, agentId: string | null): string {
  return `${strategyId}:${agentId ?? "unassigned"}`;
}

function getSettingValue(key: string, fallback = ""): string {
  const row = queries.getSetting.get(key) as any;
  return row?.value ?? fallback;
}

/**
 * Decide whether this call is allowed to run live, and explain why if not.
 * Never throws — always returns a definitive allow/deny plus a human reason.
 */
function resolveLiveEligibility(agentId: string | null, taskId: string, requestedLive: boolean): { live: boolean; reason: string } {
  if (!requestedLive) {
    return { live: false, reason: "Signal/paper mode requested." };
  }

  const killSwitch = getSettingValue("LIVE_TRADING_ENABLED", "false").toLowerCase();
  if (killSwitch !== "true") {
    return { live: false, reason: "Global LIVE_TRADING_ENABLED setting is not \"true\" — running in dry-run." };
  }

  if (!agentId) {
    return { live: false, reason: "No agent_id associated with this task — cannot verify live-trading capability grant. Running in dry-run." };
  }

  const agent = queries.getAgentById.get(agentId) as any;
  if (!agent) {
    return { live: false, reason: "Agent record not found — running in dry-run." };
  }

  let caps: string[] = [];
  try { caps = JSON.parse(agent.capabilities || "[]"); } catch { caps = []; }
  if (!caps.includes("liveTrading")) {
    return { live: false, reason: `Agent "${agent.name}" does not have the "liveTrading" capability granted. Running in dry-run. Grant it via PATCH /api/agents/${agentId} with capabilities including "liveTrading".` };
  }

  const task = queries.getTaskById.get(taskId) as any;
  if (!task) {
    return { live: false, reason: "Task record not found — running in dry-run." };
  }
  if (task.requires_approval && task.status !== "approved" && task.status !== "running") {
    return { live: false, reason: `Task ${taskId} requires human approval and has not been approved yet (status: ${task.status}). Running in dry-run.` };
  }

  const accounts = (queries.getAllAccounts.all() as any[]).filter(a => a.type === "exchange");
  if (accounts.length === 0) {
    return { live: false, reason: "No financial_accounts of type \"exchange\" are configured — running in dry-run." };
  }

  return { live: true, reason: "All live-trading gates passed (kill switch on, agent capability granted, task approved, exchange account present)." };
}

/**
 * Build the env block for the child process: base process.env, then the
 * strategy's documented defaults, then any caller overrides, then the
 * non-negotiable DRY_RUN value decided by resolveLiveEligibility, then
 * decrypted exchange credentials (never logged, never echoed in output).
 */
function buildEnv(strategyId: string, overrides: Record<string, string>, live: boolean): Record<string, string> {
  const meta = getStrategyMeta(strategyId)!;
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  for (const p of meta.envParams) {
    env[p.envVar] = p.defaultValue;
  }
  for (const [k, v] of Object.entries(overrides)) {
    env[k] = String(v);
  }
  // DRY_RUN is decided by the gate above — caller-supplied overrides cannot
  // flip this; it is intentionally set AFTER the override loop.
  env.DRY_RUN = live ? "false" : "true";

  if (live) {
    const accounts = (queries.getAllAccounts.all() as any[]).filter(a => a.type === "exchange");
    // Convention: account.name "A" or "B" maps to EXCHANGE_A_/EXCHANGE_B_ env
    // prefixes used by the scripts. address_or_id = API key, spend_key = API secret.
    accounts.slice(0, 2).forEach((acct, idx) => {
      const prefix = idx === 0 ? "EXCHANGE_A" : "EXCHANGE_B";
      try {
        env[`${prefix}_API_KEY`]    = decrypt(acct.address_or_id);
        env[`${prefix}_API_SECRET`] = acct.spend_key ? decrypt(acct.spend_key) : "";
        env[`${prefix}_NAME`]       = acct.name;
      } catch {
        // If decryption fails, leave the credential env vars unset rather
        // than passing garbage to a live-trading process.
      }
    });
  }

  return env;
}

registerTool({
  name:        "tradingBotControl",
  description: "Start, stop, or check the status of one of the 9 STRATS trading-strategy bot processes (cross-exchange-arb, triangular-arb, cash-and-carry, dca, grid, trend-following, momentum-scalp, mean-reversion, seasonal). Defaults to dry-run/paper mode — live order placement requires an explicit liveTrading capability grant on this agent, the global kill switch, and an approved task.",
  parameters: {
    action:     { type: "string", description: `One of: "start", "stop", "status", "logs". Strategy ids: ${listStrategyIds().join(", ")}`, required: true },
    strategyId: { type: "string", description: "Which strategy bot to operate, e.g. \"grid\" or \"cross-exchange-arb\"", required: true },
    live:       { type: "boolean", description: "Request live order placement instead of dry-run. Will be denied and downgraded to dry-run if the live-trading gates are not satisfied — the tool output will say why." },
    config:     { type: "object", description: "Optional env var overrides for this run, e.g. { \"GRID_LOWER\": \"75000\", \"GRID_UPPER\": \"95000\" }. Keys must match the strategy's documented env params." },
  },

  async execute(args, taskId, agentId): Promise<ToolResult> {
    const action     = String(args.action ?? "").trim();
    const strategyId = String(args.strategyId ?? "").trim();
    const meta        = getStrategyMeta(strategyId);

    if (!meta) {
      return { success: false, output: "", error: `Unknown strategyId "${strategyId}". Valid ids: ${listStrategyIds().join(", ")}` };
    }

    const key = botKey(strategyId, agentId);

    if (action === "status") {
      const running = runningBots.get(key);
      if (!running) {
        return { success: true, output: `${meta.label}: not running.` };
      }
      const uptimeSec = Math.round((Date.now() - running.startedAt) / 1000);
      return {
        success: true,
        output: `${meta.label}: RUNNING (pid ${running.proc.pid}, mode ${running.dryRun ? "DRY-RUN" : "LIVE"}, uptime ${uptimeSec}s)\nLast log lines:\n${running.logTail.slice(-10).join("\n") || "(no output yet)"}`,
      };
    }

    if (action === "logs") {
      const running = runningBots.get(key);
      if (!running) {
        return { success: true, output: `${meta.label}: not running, no logs.` };
      }
      return { success: true, output: running.logTail.join("\n") || "(no output yet)" };
    }

    if (action === "stop") {
      const running = runningBots.get(key);
      if (!running) {
        return { success: true, output: `${meta.label}: not running — nothing to stop.` };
      }
      running.proc.kill("SIGTERM");
      runningBots.delete(key);
      logEntry(taskId, agentId, `Stopped ${meta.label} (pid ${running.proc.pid})`, "warning", "finance");
      return { success: true, output: `${meta.label} stopped (pid ${running.proc.pid}).` };
    }

    if (action === "start") {
      if (runningBots.has(key)) {
        return { success: false, output: "", error: `${meta.label} is already running for this agent. Stop it first.` };
      }

      const scriptsRoot = getSettingValue("STRATEGY_SCRIPTS_ROOT", "");
      if (!scriptsRoot) {
        return {
          success: false, output: "",
          error: "Setting STRATEGY_SCRIPTS_ROOT is not configured. Set it (PUT /api/settings/STRATEGY_SCRIPTS_ROOT) to the absolute path of the STRATS folder on this machine before starting any bot.",
        };
      }

      const scriptFullPath = path.join(scriptsRoot, meta.scriptPath);
      if (!fs.existsSync(scriptFullPath)) {
        return {
          success: false, output: "",
          error: `Script not found at ${scriptFullPath}. Check STRATEGY_SCRIPTS_ROOT and that the STRATS folder structure is intact.`,
        };
      }

      const requestedLive = args.live === true;
      const { live, reason } = resolveLiveEligibility(agentId, taskId, requestedLive);

      const overrides: Record<string, string> = {};
      if (args.config && typeof args.config === "object") {
        for (const [k, v] of Object.entries(args.config as Record<string, any>)) {
          overrides[k] = String(v);
        }
      }

      const env = buildEnv(strategyId, overrides, live);

      let proc: ChildProcess;
      try {
        proc = spawn("node", [scriptFullPath], {
          cwd: path.dirname(scriptFullPath),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        return { success: false, output: "", error: `Failed to spawn process: ${err.message}` };
      }

      const running: RunningBot = {
        proc, strategyId, agentId, taskId,
        dryRun: !live, startedAt: Date.now(), logTail: [],
      };
      runningBots.set(key, running);

      const pushLog = (chunk: Buffer, isError: boolean) => {
        const text = chunk.toString("utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          running.logTail.push(line);
          if (running.logTail.length > MAX_LOG_TAIL) running.logTail.shift();
          logEntry(taskId, agentId, `[${meta.label}] ${line}`, isError ? "error" : "info", "finance");
        }
        broadcast("TASK_UPDATED", { id: taskId, last_obs: `[${meta.label}] ${text.slice(0, 200)}` });
      };

      proc.stdout?.on("data", (chunk: Buffer) => pushLog(chunk, false));
      proc.stderr?.on("data", (chunk: Buffer) => pushLog(chunk, true));
      proc.on("exit", (code) => {
        logEntry(taskId, agentId, `${meta.label} exited with code ${code}`, code === 0 ? "info" : "error", "finance");
        runningBots.delete(key);
      });
      proc.on("error", (err) => {
        logEntry(taskId, agentId, `${meta.label} process error: ${err.message}`, "error", "finance");
        runningBots.delete(key);
      });

      logEntry(taskId, agentId, `Started ${meta.label} (pid ${proc.pid}, mode ${live ? "LIVE" : "DRY-RUN"})`, "command", "finance");

      return {
        success: true,
        output: `${meta.label} started (pid ${proc.pid}).\nMode: ${live ? "LIVE — real orders will be placed" : "DRY-RUN — no real orders will be placed"}\nGate decision: ${reason}\nRisk guards active in this bot: ${meta.riskGuards.join("; ")}`,
      };
    }

    return { success: false, output: "", error: `Unknown action "${action}". Use start, stop, status, or logs.` };
  },
});
