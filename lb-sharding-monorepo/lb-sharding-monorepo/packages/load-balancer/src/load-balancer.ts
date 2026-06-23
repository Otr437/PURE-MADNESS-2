// ============================================================
// @lb-sharding/load-balancer — LoadBalancer
// ============================================================

import type {
  BackendNode,
  BalancingAlgorithm,
  LoadBalancerConfig,
  Logger,
  NodePool,
  RequestContext,
  Result,
  RoutingDecision,
  SystemEvent,
} from "@lb-sharding/core";
import { err, ok, generateId } from "@lb-sharding/core";
import { type Selector, createSelector } from "./algorithms.js";
import { CircuitBreakerRegistry } from "./circuit-breaker.js";
import { EventEmitter } from "node:events";

export interface LoadBalancerOptions {
  config: LoadBalancerConfig;
  pool: NodePool;
  logger: Logger;
}

export class LoadBalancer extends EventEmitter {
  private readonly pool: NodePool;
  private readonly selector: Selector;
  private readonly cbRegistry: CircuitBreakerRegistry;
  private readonly config: LoadBalancerConfig;
  private readonly logger: Logger;

  constructor({ config, pool, logger }: LoadBalancerOptions) {
    super();
    this.config = config;
    this.pool = pool;
    this.logger = logger.child({ component: "LoadBalancer", poolId: pool.id });
    this.selector = createSelector(config.algorithm);
    this.cbRegistry = new CircuitBreakerRegistry(
      config.circuitBreaker,
      this.logger,
      (event) => this.emitEvent(event),
    );
  }

  // ── Node Management ────────────────────────────────────────

  addNode(node: BackendNode): void {
    this.pool.nodes.push(node);
    this.selector.onNodePoolChange?.(this.pool.nodes);
    this.logger.info("Node added", { nodeId: node.id, host: node.host });
    this.emitEvent({ type: "node:added", timestamp: Date.now(), payload: { nodeId: node.id } });
  }

  removeNode(nodeId: string): void {
    const idx = this.pool.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) return;
    this.pool.nodes.splice(idx, 1);
    this.cbRegistry.remove(nodeId);
    this.selector.onNodePoolChange?.(this.pool.nodes);
    this.logger.info("Node removed", { nodeId });
    this.emitEvent({ type: "node:removed", timestamp: Date.now(), payload: { nodeId } });
  }

  updateNodeStatus(nodeId: string, status: BackendNode["status"]): void {
    const node = this.pool.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const prev = node.status;
    node.status = status;
    node.lastStatusChange = Date.now();
    this.logger.info("Node status changed", { nodeId, from: prev, to: status });
    this.emitEvent({
      type: "node:status_change",
      timestamp: Date.now(),
      payload: { nodeId, from: prev, to: status },
    });
  }

  updateNodeMetrics(
    nodeId: string,
    metrics: Partial<Pick<BackendNode, "activeConnections" | "responseTimeMs" | "totalRequests" | "failedRequests">>,
  ): void {
    const node = this.pool.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    Object.assign(node, metrics);
  }

  // ── Routing ────────────────────────────────────────────────

  /**
   * Select a node for the given request context.
   * Respects circuit breakers and retries.
   */
  route(ctx: RequestContext): Result<RoutingDecision> {
    const start = Date.now();
    const triedNodes = new Set<string>();
    const maxAttempts = this.config.retries.maxAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Filter out already-tried nodes and open circuit-broken nodes
      const eligibleNodes = this.pool.nodes.filter(
        (n) =>
          !triedNodes.has(n.id) &&
          (n.status === "healthy" || n.status === "degraded") &&
          this.cbRegistry.get(n.id).allowRequest(),
      );

      if (eligibleNodes.length === 0) {
        this.logger.warn("No eligible nodes available", {
          requestId: ctx.id,
          attempt,
          totalNodes: this.pool.nodes.length,
          triedCount: triedNodes.size,
        });
        return err(new Error(`No eligible nodes available after ${attempt - 1} attempt(s)`));
      }

      const node = this.selector.select({ nodes: eligibleNodes, ctx });
      if (!node) {
        return err(new Error("Selector returned null"));
      }

      triedNodes.add(node.id);
      // Increment active connections optimistically
      node.activeConnections++;
      node.totalRequests++;

      this.logger.debug("Routing request", {
        requestId: ctx.id,
        nodeId: node.id,
        algorithm: this.config.algorithm,
        attempt,
      });

      return ok({
        node,
        algorithm: this.config.algorithm,
        attempt,
        durationMs: Date.now() - start,
      });
    }

    return err(new Error(`Exhausted ${maxAttempts} routing attempts`));
  }

  /**
   * Must be called after the upstream request completes.
   * Updates EMA response time, circuit breaker, connection count.
   */
  recordResult(
    nodeId: string,
    success: boolean,
    latencyMs: number,
  ): void {
    const node = this.pool.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    node.activeConnections = Math.max(0, node.activeConnections - 1);

    // Exponential moving average for response time (α ≈ 0.1)
    const alpha = 0.1;
    node.responseTimeMs = alpha * latencyMs + (1 - alpha) * node.responseTimeMs;

    const cb = this.cbRegistry.get(nodeId);
    if (success) {
      cb.recordSuccess();
    } else {
      node.failedRequests++;
      cb.recordFailure();
    }
  }

  // ── Getters ────────────────────────────────────────────────

  get algorithm(): BalancingAlgorithm {
    return this.config.algorithm;
  }

  get nodes(): readonly BackendNode[] {
    return this.pool.nodes;
  }

  get healthyNodeCount(): number {
    return this.pool.nodes.filter(
      (n) => n.status === "healthy" || n.status === "degraded",
    ).length;
  }

  circuitBreakerStats() {
    return this.cbRegistry.stats();
  }

  poolStats() {
    const nodes = this.pool.nodes;
    const healthy = nodes.filter((n) => n.status === "healthy").length;
    const degraded = nodes.filter((n) => n.status === "degraded").length;
    const totalConns = nodes.reduce((s, n) => s + n.activeConnections, 0);
    const avgRt = nodes.length
      ? nodes.reduce((s, n) => s + n.responseTimeMs, 0) / nodes.length
      : 0;
    return { total: nodes.length, healthy, degraded, totalConns, avgResponseTimeMs: avgRt };
  }

  // ── Internal ───────────────────────────────────────────────

  private emitEvent(event: SystemEvent): void {
    this.emit(event.type, event);
    this.emit("*", event);
  }

  /** Graceful drain — stop routing new requests to a node */
  drainNode(nodeId: string): void {
    this.updateNodeStatus(nodeId, "draining");
  }

  /** Create a node with sane defaults */
  static createNode(
    partial: Pick<BackendNode, "host" | "port"> & Partial<BackendNode>,
  ): BackendNode {
    return {
      id: partial.id ?? generateId("node"),
      host: partial.host,
      port: partial.port,
      protocol: partial.protocol ?? "http",
      weight: partial.weight ?? 1,
      status: partial.status ?? "healthy",
      metadata: partial.metadata ?? {},
      lastStatusChange: Date.now(),
      activeConnections: 0,
      totalRequests: 0,
      failedRequests: 0,
      responseTimeMs: 0,
      tags: partial.tags ?? [],
    };
  }
}
