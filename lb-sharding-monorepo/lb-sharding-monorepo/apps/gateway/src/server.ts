// ============================================================
// apps/gateway — Main Server Entry Point
// ============================================================

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { getLogger } from "@lb-sharding/core";
import type { RequestContext } from "@lb-sharding/core";
import { LoadBalancer } from "@lb-sharding/load-balancer";
import { ShardManager } from "@lb-sharding/shard-manager";
import { HealthChecker } from "@lb-sharding/health-checker";
import { MetricsRegistry } from "@lb-sharding/metrics";

import { loadConfig } from "./config.js";
import { ProxyHandler } from "./proxy.js";
import { AdminServer } from "./admin.js";
import { MetricsServer } from "./metrics-server.js";

// ── Bootstrap ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = getLogger({
    level: (process.env["LOG_LEVEL"] as "debug" | "info" | "warn" | "error") ?? "info",
    name: "gateway",
    pretty: process.env["NODE_ENV"] !== "production",
  });

  logger.info("Starting gateway", {
    port: config.server.port,
    adminPort: config.server.adminPort,
    metricsPort: config.server.metricsPort,
    algorithm: config.loadBalancer.algorithm,
    sharding: config.sharding.enabled,
  });

  // ── Metrics registry ──────────────────────────────────────
  const metrics = new MetricsRegistry(logger);

  // ── Seed nodes from env ───────────────────────────────────
  // BACKEND_NODES=host1:port1,host2:port2
  const seedNodes = (process.env["BACKEND_NODES"] ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry, i) => {
      const [host, portStr] = entry.trim().split(":");
      return LoadBalancer.createNode({
        host: host ?? "localhost",
        port: parseInt(portStr ?? "3000", 10),
        weight: 1,
        tags: [],
      });
    });

  if (seedNodes.length === 0) {
    logger.warn("No BACKEND_NODES configured — add nodes via admin API");
  }

  // ── Load balancer ─────────────────────────────────────────
  const pool = { id: "default", name: "default", nodes: seedNodes, metadata: {} };
  const lb = new LoadBalancer({ config: config.loadBalancer, pool, logger });

  lb.on("*", (event) => {
    logger.debug("LB event", { type: event.type });
  });

  // ── Shard manager ─────────────────────────────────────────
  let shardManager: ShardManager | null = null;
  if (config.sharding.enabled) {
    shardManager = new ShardManager({
      config: config.sharding.config,
      nodes: seedNodes,
      logger,
    });
    logger.info("Sharding enabled", { strategy: config.sharding.config.strategy });
  }

  // ── Health checker ────────────────────────────────────────
  const healthChecker = new HealthChecker({
    config: config.loadBalancer.healthCheck,
    logger,
  });

  healthChecker.on("unhealthy", (nodeId: string) => {
    logger.warn("Node marked unhealthy", { nodeId });
    lb.updateNodeStatus(nodeId, "unhealthy");
    metrics.healthyNodes.dec();
  });

  healthChecker.on("recovered", (nodeId: string) => {
    logger.info("Node recovered", { nodeId });
    lb.updateNodeStatus(nodeId, "healthy");
    metrics.healthyNodes.inc();
  });

  if (seedNodes.length > 0) {
    healthChecker.start(seedNodes);
    metrics.healthyNodes.set(seedNodes.length);
  }

  // ── Proxy ─────────────────────────────────────────────────
  const proxy = new ProxyHandler(config, logger);

  // ── Main HTTP server ──────────────────────────────────────
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const ctx: RequestContext = {
      id: randomUUID(),
      clientIp: extractClientIp(req),
      method: req.method ?? "GET",
      path: req.url?.split("?")[0] ?? "/",
      headers: flattenHeaders(req.headers),
      startTime: Date.now(),
      attempt: 1,
      shardKey: extractShardKey(req),
    };

    // Route via load balancer
    const routeResult = lb.route(ctx);
    if (!routeResult.ok) {
      logger.warn("Routing failed", { requestId: ctx.id, error: routeResult.error.message });
      if (!res.headersSent) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Service Unavailable", requestId: ctx.id }));
      }
      metrics.totalErrors.inc();
      return;
    }

    const { node } = routeResult.value;
    res.setHeader("X-Request-Id", ctx.id);
    res.setHeader("X-Served-By", node.id);

    const result = await proxy.forward(ctx, node, req, res);

    // Record metrics
    lb.recordResult(node.id, result.success, result.latencyMs);
    metrics.recordRequest(node.id, result.latencyMs, result.success, node.activeConnections);
    metrics.activeConnections.set(lb.nodes.reduce((s, n) => s + n.activeConnections, 0));

    logger.debug("Request completed", {
      requestId: ctx.id,
      nodeId: node.id,
      status: result.statusCode,
      latencyMs: result.latencyMs,
      method: ctx.method,
      path: ctx.path,
    });
  });

  // ── Admin + Metrics servers ───────────────────────────────
  const adminServer = new AdminServer(lb, shardManager, metrics, config, logger);
  const metricsServer = new MetricsServer(metrics, config, logger);

  // ── Start all servers ─────────────────────────────────────
  await Promise.all([
    new Promise<void>((resolve) => {
      server.listen(config.server.port, config.server.host, () => {
        logger.info("Proxy server listening", { port: config.server.port });
        resolve();
      });
    }),
    adminServer.listen(),
    metricsServer.listen(),
  ]);

  // ── Graceful shutdown ─────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    healthChecker.stop();

    // Drain — stop accepting new connections
    server.close();
    await adminServer.close();
    await metricsServer.close();
    proxy.destroy();
    shardManager?.destroy();

    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("uncaughtException", (e) => {
    logger.fatal("Uncaught exception", { error: e.message, stack: e.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal("Unhandled rejection", { reason: String(reason) });
    process.exit(1);
  });
}

// ── Helpers ───────────────────────────────────────────────────

function extractClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim() ?? "unknown";
  return req.socket.remoteAddress ?? "unknown";
}

function extractShardKey(req: IncomingMessage): string | undefined {
  const url = req.url ?? "";
  // Check X-Shard-Key header first, then parse from path
  const header = req.headers["x-shard-key"];
  if (typeof header === "string") return header;
  // e.g. /api/users/12345 — use the last path segment
  const parts = url.split("?")[0]?.split("/").filter(Boolean);
  return parts?.at(-1);
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
  }
  return out;
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
