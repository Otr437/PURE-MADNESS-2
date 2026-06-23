// ============================================================
// @lb-sharding/metrics — Prometheus-compatible Metrics
// ============================================================

import type { NodeMetrics, PoolMetrics, Logger } from "@lb-sharding/core";
import { PercentilesTracker, RollingWindow } from "@lb-sharding/core";

// ── Counter ───────────────────────────────────────────────────

export class Counter {
  private value = 0;
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labels: Record<string, string> = {},
  ) {}
  inc(by = 1): void { this.value += by; }
  get(): number { return this.value; }
  reset(): void { this.value = 0; }
}

// ── Gauge ─────────────────────────────────────────────────────

export class Gauge {
  private value = 0;
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labels: Record<string, string> = {},
  ) {}
  set(v: number): void { this.value = v; }
  inc(by = 1): void { this.value += by; }
  dec(by = 1): void { this.value -= by; }
  get(): number { return this.value; }
}

// ── Histogram ─────────────────────────────────────────────────

export class Histogram {
  private readonly tracker: PercentilesTracker;
  private count = 0;
  private sum = 0;

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labels: Record<string, string> = {},
    maxSamples = 1000,
  ) {
    this.tracker = new PercentilesTracker(maxSamples);
  }

  observe(value: number): void {
    this.tracker.record(value);
    this.count++;
    this.sum += value;
  }

  p50(): number { return this.tracker.p50(); }
  p95(): number { return this.tracker.p95(); }
  p99(): number { return this.tracker.p99(); }
  getCount(): number { return this.count; }
  getSum(): number { return this.sum; }
  mean(): number { return this.count > 0 ? this.sum / this.count : 0; }
}

// ── NodeMetricsCollector ──────────────────────────────────────

export class NodeMetricsCollector {
  private readonly requestCounter: RollingWindow;
  private readonly errorCounter: RollingWindow;
  private readonly latencyHistogram: Histogram;
  private readonly connectionsGauge: Gauge;

  constructor(public readonly nodeId: string) {
    this.requestCounter = new RollingWindow(60_000, 12);
    this.errorCounter = new RollingWindow(60_000, 12);
    this.latencyHistogram = new Histogram(`node_latency_ms`, `Latency in ms`, { node: nodeId });
    this.connectionsGauge = new Gauge(`node_connections`, `Active connections`, { node: nodeId });
  }

  recordRequest(latencyMs: number, success: boolean, connections: number): void {
    this.requestCounter.increment();
    if (!success) this.errorCounter.increment();
    this.latencyHistogram.observe(latencyMs);
    this.connectionsGauge.set(connections);
  }

  snapshot(nodeId: string): NodeMetrics {
    const total = this.requestCounter.sum();
    return {
      nodeId,
      timestamp: Date.now(),
      requestsPerSecond: this.requestCounter.rate(),
      errorRate: total > 0 ? this.errorCounter.sum() / total : 0,
      p50LatencyMs: this.latencyHistogram.p50(),
      p95LatencyMs: this.latencyHistogram.p95(),
      p99LatencyMs: this.latencyHistogram.p99(),
      activeConnections: this.connectionsGauge.get(),
    };
  }
}

// ── MetricsRegistry ───────────────────────────────────────────

export class MetricsRegistry {
  private readonly nodeCollectors = new Map<string, NodeMetricsCollector>();
  private readonly history: NodeMetrics[] = [];
  private readonly maxHistory: number;
  private readonly logger: Logger;

  // Global counters
  readonly totalRequests = new Counter("lb_requests_total", "Total requests routed");
  readonly totalErrors = new Counter("lb_errors_total", "Total routing errors");
  readonly activeConnections = new Gauge("lb_active_connections", "Current active connections");
  readonly healthyNodes = new Gauge("lb_healthy_nodes", "Currently healthy nodes");

  constructor(logger: Logger, maxHistory = 10_000) {
    this.logger = logger.child({ component: "MetricsRegistry" });
    this.maxHistory = maxHistory;
  }

  forNode(nodeId: string): NodeMetricsCollector {
    let c = this.nodeCollectors.get(nodeId);
    if (!c) {
      c = new NodeMetricsCollector(nodeId);
      this.nodeCollectors.set(nodeId, c);
    }
    return c;
  }

  removeNode(nodeId: string): void {
    this.nodeCollectors.delete(nodeId);
  }

  recordRequest(nodeId: string, latencyMs: number, success: boolean, connections: number): void {
    this.forNode(nodeId).recordRequest(latencyMs, success, connections);
    this.totalRequests.inc();
    if (!success) this.totalErrors.inc();

    const snap = this.forNode(nodeId).snapshot(nodeId);
    this.history.push(snap);
    if (this.history.length > this.maxHistory) this.history.splice(0, 1);
  }

  nodeSnapshot(nodeId: string): NodeMetrics | null {
    const c = this.nodeCollectors.get(nodeId);
    return c ? c.snapshot(nodeId) : null;
  }

  allNodeSnapshots(): NodeMetrics[] {
    return [...this.nodeCollectors.keys()].map((id) => this.forNode(id).snapshot(id));
  }

  poolSnapshot(poolId: string, nodeIds: string[]): PoolMetrics {
    const snaps = nodeIds
      .map((id) => this.nodeSnapshot(id))
      .filter((s): s is NodeMetrics => s !== null);

    const total = snaps.length;
    return {
      poolId,
      timestamp: Date.now(),
      totalNodes: total,
      healthyNodes: this.healthyNodes.get(),
      totalRps: snaps.reduce((s, n) => s + n.requestsPerSecond, 0),
      avgErrorRate: total > 0 ? snaps.reduce((s, n) => s + n.errorRate, 0) / total : 0,
      avgLatencyMs: total > 0 ? snaps.reduce((s, n) => s + n.p50LatencyMs, 0) / total : 0,
    };
  }

  historyFor(nodeId: string, limitMs = 60_000): NodeMetrics[] {
    const cutoff = Date.now() - limitMs;
    return this.history.filter((m) => m.nodeId === nodeId && m.timestamp >= cutoff);
  }

  // ── Prometheus exposition format ──────────────────────────

  toPrometheus(): string {
    const lines: string[] = [];

    const emit = (name: string, help: string, type: string, value: number, labels: Record<string, string> = {}) => {
      const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",");
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name}${labelStr ? `{${labelStr}}` : ""} ${value}`);
    };

    emit("lb_requests_total", "Total requests routed", "counter", this.totalRequests.get());
    emit("lb_errors_total", "Total routing errors", "counter", this.totalErrors.get());
    emit("lb_active_connections", "Active connections", "gauge", this.activeConnections.get());
    emit("lb_healthy_nodes", "Healthy nodes", "gauge", this.healthyNodes.get());

    for (const [nodeId, collector] of this.nodeCollectors) {
      const snap = collector.snapshot(nodeId);
      const l = { node: nodeId };
      emit("lb_node_rps", "Requests per second", "gauge", snap.requestsPerSecond, l);
      emit("lb_node_error_rate", "Error rate", "gauge", snap.errorRate, l);
      emit("lb_node_p50_ms", "P50 latency ms", "gauge", snap.p50LatencyMs, l);
      emit("lb_node_p95_ms", "P95 latency ms", "gauge", snap.p95LatencyMs, l);
      emit("lb_node_p99_ms", "P99 latency ms", "gauge", snap.p99LatencyMs, l);
      emit("lb_node_connections", "Active connections", "gauge", snap.activeConnections, l);
    }

    return lines.join("\n") + "\n";
  }
}
