// ============================================================
// @lb-sharding/health-checker — Multi-mode health checking
// ============================================================

import { EventEmitter } from "node:events";
import * as net from "node:net";
import type {
  BackendNode,
  HealthCheckConfig,
  HealthCheckResult,
  Logger,
  SystemEvent,
} from "@lb-sharding/core";
import { sleep } from "@lb-sharding/core";

// ── Probe interface ──────────────────────────────────────────

export interface Probe {
  check(node: BackendNode, config: HealthCheckConfig): Promise<HealthCheckResult>;
}

// ── HTTP Probe ────────────────────────────────────────────────

export class HttpProbe implements Probe {
  async check(node: BackendNode, config: HealthCheckConfig): Promise<HealthCheckResult> {
    const start = Date.now();
    const url = `${node.protocol}://${node.host}:${node.port}${config.path ?? "/health"}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { "User-Agent": "lb-sharding/health-checker" },
      });
      const latencyMs = Date.now() - start;
      const expectedStatus = config.expectedStatus ?? 200;
      let healthy = res.status === expectedStatus;

      if (healthy && config.expectedBody) {
        const body = await res.text();
        healthy = body.includes(config.expectedBody);
      }

      return {
        nodeId: node.id,
        healthy,
        latencyMs,
        statusCode: res.status,
        checkedAt: Date.now(),
      };
    } catch (e) {
      return {
        nodeId: node.id,
        healthy: false,
        latencyMs: Date.now() - start,
        error: (e as Error).message,
        checkedAt: Date.now(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── TCP Probe ─────────────────────────────────────────────────

export class TcpProbe implements Probe {
  check(node: BackendNode, config: HealthCheckConfig): Promise<HealthCheckResult> {
    const start = Date.now();
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: node.host, port: node.port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({
          nodeId: node.id,
          healthy: false,
          latencyMs: Date.now() - start,
          error: "TCP connection timed out",
          checkedAt: Date.now(),
        });
      }, config.timeoutMs);

      socket.on("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          nodeId: node.id,
          healthy: true,
          latencyMs: Date.now() - start,
          checkedAt: Date.now(),
        });
      });

      socket.on("error", (e) => {
        clearTimeout(timer);
        resolve({
          nodeId: node.id,
          healthy: false,
          latencyMs: Date.now() - start,
          error: e.message,
          checkedAt: Date.now(),
        });
      });
    });
  }
}

// ── gRPC Probe (HTTP/2 reflection) ───────────────────────────

export class GrpcProbe implements Probe {
  async check(node: BackendNode, config: HealthCheckConfig): Promise<HealthCheckResult> {
    // Use gRPC health check protocol via HTTP/2
    // Falls back to HTTP check of /grpc.health.v1.Health/Check
    const httpProbe = new HttpProbe();
    return httpProbe.check(
      { ...node, protocol: "http" },
      { ...config, path: config.path ?? "/grpc.health.v1.Health/Check", expectedStatus: 200 },
    );
  }
}

// ── Probe factory ─────────────────────────────────────────────

function createProbe(type: HealthCheckConfig["type"]): Probe {
  switch (type) {
    case "http":
    case "https":
      return new HttpProbe();
    case "tcp":
      return new TcpProbe();
    case "grpc":
      return new GrpcProbe();
    default:
      return new HttpProbe();
  }
}

// ── Per-node tracker ─────────────────────────────────────────

interface NodeHealthState {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastResult: HealthCheckResult | null;
}

// ── HealthChecker ─────────────────────────────────────────────

export interface HealthCheckerOptions {
  config: HealthCheckConfig;
  logger: Logger;
}

export type StatusChangeHandler = (
  nodeId: string,
  healthy: boolean,
  result: HealthCheckResult,
) => void;

export class HealthChecker extends EventEmitter {
  private readonly config: HealthCheckConfig;
  private readonly probe: Probe;
  private readonly logger: Logger;
  private readonly nodeStates = new Map<string, NodeHealthState>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;

  constructor({ config, logger }: HealthCheckerOptions) {
    super();
    this.config = config;
    this.probe = createProbe(config.type);
    this.logger = logger.child({ component: "HealthChecker" });
  }

  start(nodes: BackendNode[]): void {
    if (this.running) return;
    this.running = true;
    for (const node of nodes) {
      this.watch(node);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  watch(node: BackendNode): void {
    if (this.timers.has(node.id)) return;
    if (!this.nodeStates.has(node.id)) {
      this.nodeStates.set(node.id, {
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastResult: null,
      });
    }

    // Run once immediately
    void this.runCheck(node);

    const timer = setInterval(
      () => void this.runCheck(node),
      this.config.intervalMs,
    );
    this.timers.set(node.id, timer);
  }

  unwatch(nodeId: string): void {
    const timer = this.timers.get(nodeId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(nodeId);
    }
    this.nodeStates.delete(nodeId);
  }

  private async runCheck(node: BackendNode): Promise<void> {
    const result = await this.probe.check(node, this.config);
    const state = this.nodeStates.get(node.id);
    if (!state) return;

    const prevResult = state.lastResult;
    state.lastResult = result;

    if (result.healthy) {
      state.consecutiveFailures = 0;
      state.consecutiveSuccesses++;
      if (
        state.consecutiveSuccesses >= this.config.healthyThreshold &&
        (prevResult === null || !prevResult.healthy)
      ) {
        this.logger.info("Node recovered", { nodeId: node.id, latencyMs: result.latencyMs });
        this.emit("recovered", node.id, result);
        this.emitSystemEvent("health_check:recovered", node.id, result);
      }
    } else {
      state.consecutiveSuccesses = 0;
      state.consecutiveFailures++;
      this.logger.warn("Health check failed", {
        nodeId: node.id,
        error: result.error,
        consecutiveFailures: state.consecutiveFailures,
      });
      if (state.consecutiveFailures >= this.config.unhealthyThreshold) {
        this.emit("unhealthy", node.id, result);
        this.emitSystemEvent("health_check:failed", node.id, result);
      }
    }

    this.emit("result", result);
  }

  private emitSystemEvent(
    type: SystemEvent["type"],
    nodeId: string,
    result: HealthCheckResult,
  ): void {
    const event: SystemEvent = {
      type,
      timestamp: Date.now(),
      payload: { nodeId, latencyMs: result.latencyMs, error: result.error ?? null },
    };
    this.emit("system_event", event);
  }

  lastResult(nodeId: string): HealthCheckResult | null {
    return this.nodeStates.get(nodeId)?.lastResult ?? null;
  }

  async checkOnce(node: BackendNode): Promise<HealthCheckResult> {
    return this.probe.check(node, this.config);
  }
}
