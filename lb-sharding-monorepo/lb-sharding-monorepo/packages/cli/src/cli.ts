#!/usr/bin/env node
// ============================================================
// @lb-sharding/cli — lbctl command-line tool
// ============================================================

import { parseArgs } from "node:util";
import * as readline from "node:readline";

const VERSION = "1.0.0";

const HELP = `
lbctl v${VERSION} — Load Balancer & Shard Manager CLI

USAGE
  lbctl <command> [options]

COMMANDS
  status                  Show pool and shard status
  nodes list              List all nodes
  nodes add               Add a node interactively
  nodes remove <id>       Remove a node by ID
  nodes drain <id>        Drain a node gracefully
  shards list             List all shards
  shards rebalance        Force shard rebalance
  metrics                 Print current metrics (Prometheus format)
  health <host:port>      One-shot health check against a host
  config show             Print active configuration
  help                    Show this help

OPTIONS
  --api-url <url>         Gateway API base URL (default: http://localhost:9000)
  --json                  Output as JSON
  --version               Print version

EXAMPLES
  lbctl nodes list --api-url http://lb.internal:9000
  lbctl nodes drain node_abc123
  lbctl shards rebalance
  lbctl metrics
`.trim();

// ── Args ───────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "api-url": { type: "string", default: "http://localhost:9000" },
    json: { type: "boolean", default: false },
    version: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: false,
});

const API = (values["api-url"] as string) ?? "http://localhost:9000";
const JSON_OUT = values["json"] as boolean;

// ── Output helpers ────────────────────────────────────────

function out(data: unknown): void {
  if (JSON_OUT) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function die(msg: string): never {
  console.error(`\x1b[31mERROR\x1b[0m ${msg}`);
  process.exit(1);
}

// ── API client ────────────────────────────────────────────

async function api(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    die(`API ${method} ${path} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Prompt helper ─────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ── Table renderer ────────────────────────────────────────

function table(rows: Record<string, unknown>[], cols: string[]): void {
  if (rows.length === 0) { console.log("(no results)"); return; }
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))
  );
  const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const header = cols.map((c, i) => ` ${c.padEnd(widths[i]!)} `).join("│");
  console.log("┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐");
  console.log("│" + header + "│");
  console.log("├" + sep + "┤");
  for (const row of rows) {
    const line = cols.map((c, i) => ` ${String(row[c] ?? "").padEnd(widths[i]!)} `).join("│");
    console.log("│" + line + "│");
  }
  console.log("└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘");
}

// ── Commands ──────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const data = await api("/admin/status") as Record<string, unknown>;
  out(data);
}

async function cmdNodesList(): Promise<void> {
  const data = await api("/admin/nodes") as { nodes: Record<string, unknown>[] };
  if (JSON_OUT) { out(data); return; }
  table(data.nodes, ["id", "host", "port", "status", "weight", "activeConnections", "responseTimeMs"]);
}

async function cmdNodesAdd(): Promise<void> {
  const host = await prompt("Host: ");
  const portStr = await prompt("Port: ");
  const weight = await prompt("Weight [1]: ");
  const protocol = await prompt("Protocol [http]: ");
  const body = {
    host,
    port: parseInt(portStr, 10),
    weight: weight ? parseInt(weight, 10) : 1,
    protocol: protocol || "http",
  };
  const result = await api("/admin/nodes", "POST", body);
  out(result);
}

async function cmdNodesRemove(id: string): Promise<void> {
  if (!id) die("Node ID required");
  await api(`/admin/nodes/${id}`, "DELETE");
  out(`Node ${id} removed.`);
}

async function cmdNodesDrain(id: string): Promise<void> {
  if (!id) die("Node ID required");
  await api(`/admin/nodes/${id}/drain`, "POST");
  out(`Node ${id} is draining.`);
}

async function cmdShardsList(): Promise<void> {
  const data = await api("/admin/shards") as { shards: Record<string, unknown>[] };
  if (JSON_OUT) { out(data); return; }
  table(data.shards, ["id", "token", "primaryNodeId", "status", "keyCount", "dataSize"]);
}

async function cmdShardsRebalance(): Promise<void> {
  const result = await api("/admin/shards/rebalance", "POST");
  out(result);
}

async function cmdMetrics(): Promise<void> {
  const res = await fetch(`${API}/metrics`);
  if (!res.ok) die(`HTTP ${res.status}`);
  const text = await res.text();
  console.log(text);
}

async function cmdHealth(target: string): Promise<void> {
  if (!target) die("host:port required");
  const [host, portStr] = target.split(":");
  const port = parseInt(portStr ?? "80", 10);
  const url = `http://${host}:${port}/health`;
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const ms = Date.now() - start;
    if (JSON_OUT) {
      out({ host, port, status: res.status, latencyMs: ms, healthy: res.ok });
    } else {
      const icon = res.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(`${icon} ${host}:${port} → HTTP ${res.status} (${ms}ms)`);
    }
  } catch (e) {
    if (JSON_OUT) {
      out({ host, port, healthy: false, error: (e as Error).message });
    } else {
      console.log(`\x1b[31m✗\x1b[0m ${host}:${port} → ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

async function cmdConfigShow(): Promise<void> {
  const data = await api("/admin/config");
  out(data);
}

// ── Router ────────────────────────────────────────────────

async function main(): Promise<void> {
  if (values["version"]) { console.log(`lbctl v${VERSION}`); return; }
  if (values["help"] || positionals.length === 0) { console.log(HELP); return; }

  const [cmd, sub, arg] = positionals;

  try {
    if (cmd === "status") { await cmdStatus(); return; }
    if (cmd === "metrics") { await cmdMetrics(); return; }
    if (cmd === "health") { await cmdHealth(sub ?? ""); return; }
    if (cmd === "config" && sub === "show") { await cmdConfigShow(); return; }

    if (cmd === "nodes") {
      if (sub === "list" || !sub) { await cmdNodesList(); return; }
      if (sub === "add") { await cmdNodesAdd(); return; }
      if (sub === "remove") { await cmdNodesRemove(arg ?? ""); return; }
      if (sub === "drain") { await cmdNodesDrain(arg ?? ""); return; }
    }

    if (cmd === "shards") {
      if (sub === "list" || !sub) { await cmdShardsList(); return; }
      if (sub === "rebalance") { await cmdShardsRebalance(); return; }
    }

    die(`Unknown command: ${cmd}. Run 'lbctl help' for usage.`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      die(`Cannot connect to gateway at ${API}. Is it running?`);
    }
    throw e;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
