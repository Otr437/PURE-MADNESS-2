// ============================================================
// apps/gateway — Admin API Server
// ============================================================

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoadBalancer } from "@lb-sharding/load-balancer";
import type { ShardManager } from "@lb-sharding/shard-manager";
import type { MetricsRegistry } from "@lb-sharding/metrics";
import type { Logger } from "@lb-sharding/core";
import { generateId } from "@lb-sharding/core";
import type { GatewayConfig } from "./config.js";

// ── Tiny router ───────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; }

function parseRoute(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; });
  return { regex: new RegExp(`^${src}$`), keys };
}

// ── Helpers ───────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => { data += c.toString(); });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// ── Admin Server ──────────────────────────────────────────────

export class AdminServer {
  private readonly server: http.Server;
  private readonly routes: Route[] = [];
  private readonly logger: Logger;

  constructor(
    private readonly lb: LoadBalancer,
    private readonly shardManager: ShardManager | null,
    private readonly metrics: MetricsRegistry,
    private readonly config: GatewayConfig,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "AdminServer" });
    this.server = http.createServer((req, res) => void this.dispatch(req, res));
    this.registerRoutes();
  }

  private add(method: string, pattern: string, handler: Handler): void {
    const { regex, keys } = parseRoute(pattern);
    this.routes.push({ method, pattern: regex, keys, handler });
  }

  private registerRoutes(): void {
    // Status
    this.add("GET", "/admin/status", async (_req, res) => {
      json(res, 200, {
        uptime: process.uptime(),
        pid: process.pid,
        pool: this.lb.poolStats(),
        circuitBreakers: this.lb.circuitBreakerStats(),
        shards: this.shardManager?.stats() ?? null,
        algorithm: this.lb.algorithm,
      });
    });

    // Config
    this.add("GET", "/admin/config", async (_req, res) => {
      json(res, 200, this.config);
    });

    // Nodes — list
    this.add("GET", "/admin/nodes", async (_req, res) => {
      json(res, 200, { nodes: this.lb.nodes });
    });

    // Nodes — add
    this.add("POST", "/admin/nodes", async (req, res) => {
      const body = await readBody(req) as Record<string, unknown>;
      if (!body["host"] || !body["port"]) {
        json(res, 400, { error: "host and port required" }); return;
      }
      const node = (await import("@lb-sharding/load-balancer")).LoadBalancer.createNode({
        host: String(body["host"]),
        port: Number(body["port"]),
        weight: Number(body["weight"] ?? 1),
        protocol: (body["protocol"] as "http" | "https") ?? "http",
        tags: (body["tags"] as string[]) ?? [],
      });
      this.lb.addNode(node);
      this.shardManager?.addNode(node);
      this.logger.info("Node added via admin API", { nodeId: node.id });
      json(res, 201, node);
    });

    // Nodes — remove
    this.add("DELETE", "/admin/nodes/:id", async (_req, res, { id }) => {
      this.lb.removeNode(id!);
      this.shardManager?.removeNode(id!);
      json(res, 200, { removed: id });
    });

    // Nodes — drain
    this.add("POST", "/admin/nodes/:id/drain", async (_req, res, { id }) => {
      this.lb.drainNode(id!);
      json(res, 200, { draining: id });
    });

    // Nodes — metrics
    this.add("GET", "/admin/nodes/:id/metrics", async (_req, res, { id }) => {
      const snap = this.metrics.nodeSnapshot(id!);
      if (!snap) { json(res, 404, { error: "Node not found" }); return; }
      json(res, 200, snap);
    });

    // Shards — list
    this.add("GET", "/admin/shards", async (_req, res) => {
      if (!this.shardManager) { json(res, 404, { error: "Sharding not enabled" }); return; }
      json(res, 200, { shards: this.shardManager.currentMap.shards, stats: this.shardManager.stats() });
    });

    // Shards — rebalance
    this.add("POST", "/admin/shards/rebalance", async (_req, res) => {
      if (!this.shardManager) { json(res, 404, { error: "Sharding not enabled" }); return; }
      this.shardManager.forceRebalance();
      json(res, 200, { rebalanced: true, stats: this.shardManager.stats() });
    });

    // Shard resolve
    this.add("GET", "/admin/shards/resolve/:key", async (_req, res, { key }) => {
      if (!this.shardManager) { json(res, 404, { error: "Sharding not enabled" }); return; }
      const result = this.shardManager.resolve(key!);
      json(res, result ? 200 : 404, result ?? { error: "No shard found" });
    });

    // Pool metrics
    this.add("GET", "/admin/metrics", async (_req, res) => {
      const nodeIds = this.lb.nodes.map((n) => n.id);
      json(res, 200, {
        nodes: this.metrics.allNodeSnapshots(),
        pool: this.metrics.poolSnapshot(this.config.server.host, nodeIds),
        totals: {
          requests: this.metrics.totalRequests.get(),
          errors: this.metrics.totalErrors.get(),
        },
      });
    });

    // Health
    this.add("GET", "/health", async (_req, res) => {
      json(res, 200, { ok: true, healthy: this.lb.healthyNodeCount });
    });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url?.split("?")[0] ?? "/";
    const method = req.method?.toUpperCase() ?? "GET";

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => { params[k] = match[i + 1] ?? ""; });
      try {
        await route.handler(req, res, params);
      } catch (e) {
        this.logger.error("Admin handler error", { error: (e as Error).message, url });
        if (!res.headersSent) json(res, 500, { error: "Internal server error" });
      }
      return;
    }

    json(res, 404, { error: "Not found", path: url });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.server.adminPort, this.config.server.host, () => {
        this.logger.info("Admin server listening", {
          port: this.config.server.adminPort,
          host: this.config.server.host,
        });
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((e) => (e ? reject(e) : resolve()));
    });
  }
}
