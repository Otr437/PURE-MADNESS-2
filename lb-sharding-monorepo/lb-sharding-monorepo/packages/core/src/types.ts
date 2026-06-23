// ============================================================
// @lb-sharding/core — Production Types & Interfaces
// ============================================================

// ── Node / Backend ──────────────────────────────────────────

export type NodeStatus = "healthy" | "degraded" | "unhealthy" | "draining" | "offline";
export type Protocol = "http" | "https" | "tcp" | "grpc";

export interface BackendNode {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: Protocol;
  weight: number;          // mutable for weighted algorithms
  status: NodeStatus;
  metadata: Record<string, string>;
  /** epoch ms of last status change */
  lastStatusChange: number;
  /** current active connections */
  activeConnections: number;
  /** cumulative requests handled */
  totalRequests: number;
  /** cumulative failed requests */
  failedRequests: number;
  /** average response time in ms (EMA) */
  responseTimeMs: number;
  /** tags for affinity-routing (e.g. region, tier) */
  tags: string[];
}

export interface NodePool {
  readonly id: string;
  readonly name: string;
  nodes: BackendNode[];
  metadata: Record<string, string>;
}

// ── Load Balancer ────────────────────────────────────────────

export type BalancingAlgorithm =
  | "round-robin"
  | "weighted-round-robin"
  | "least-connections"
  | "least-response-time"
  | "ip-hash"
  | "consistent-hash"
  | "random"
  | "resource-based"
  | "sticky-session";

export interface LoadBalancerConfig {
  algorithm: BalancingAlgorithm;
  healthCheck: HealthCheckConfig;
  retries: RetryConfig;
  circuitBreaker: CircuitBreakerConfig;
  sticky?: StickySessionConfig;
  timeout: TimeoutConfig;
}

export interface TimeoutConfig {
  connectMs: number;
  readMs: number;
  writeMs: number;
  idleMs: number;
}

export interface RetryConfig {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  retryableStatusCodes: number[];
}

export interface StickySessionConfig {
  cookieName: string;
  ttlSeconds: number;
  fallback: BalancingAlgorithm;
}

// ── Circuit Breaker ──────────────────────────────────────────

export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** failure rate threshold (0–1) to open the circuit */
  failureThreshold: number;
  /** number of requests in the rolling window */
  windowSize: number;
  /** ms to wait before transitioning open → half-open */
  recoveryTimeMs: number;
  /** calls allowed in half-open state */
  halfOpenRequests: number;
}

export interface CircuitBreakerState_ {
  state: CircuitBreakerState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  lastStateChange: number;
}

// ── Health Check ─────────────────────────────────────────────

export type HealthCheckType = "http" | "tcp" | "grpc" | "custom";

export interface HealthCheckConfig {
  type: HealthCheckType;
  intervalMs: number;
  timeoutMs: number;
  /** consecutive failures before marking unhealthy */
  unhealthyThreshold: number;
  /** consecutive successes before marking healthy again */
  healthyThreshold: number;
  path?: string;            // for HTTP checks
  expectedStatus?: number;  // for HTTP checks
  expectedBody?: string;    // optional body match
}

export interface HealthCheckResult {
  nodeId: string;
  healthy: boolean;
  latencyMs: number;
  statusCode?: number;
  error?: string;
  checkedAt: number;
}

// ── Sharding ─────────────────────────────────────────────────

export type ShardingStrategy =
  | "consistent-hash"
  | "range"
  | "directory"
  | "modulo"
  | "geographic"
  | "custom";

export interface ShardConfig {
  readonly id: string;
  readonly strategy: ShardingStrategy;
  readonly replicationFactor: number;
  readonly virtualNodes: number;   // vnodes for consistent hashing
  readonly shardCount: number;
  rebalanceThreshold: number;      // 0–1, triggers rebalance when imbalance exceeds
}

export interface Shard {
  readonly id: string;
  /** hash-ring position (0 – 2^32-1) */
  readonly token: number;
  primaryNodeId: string;
  replicaNodeIds: string[];
  keyRange?: { min: string; max: string };
  status: "active" | "migrating" | "offline";
  dataSize: number;  // bytes
  keyCount: number;
}

export interface ShardMap {
  readonly configId: string;
  shards: Shard[];
  /** nodeId → shard IDs it owns */
  nodeToShards: Map<string, string[]>;
  version: number;
  updatedAt: number;
}

export interface ShardingResult {
  shardId: string;
  primaryNode: BackendNode;
  replicaNodes: BackendNode[];
  token: number;
}

// ── Metrics ──────────────────────────────────────────────────

export interface NodeMetrics {
  nodeId: string;
  timestamp: number;
  requestsPerSecond: number;
  errorRate: number;           // 0–1
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  activeConnections: number;
  cpuUsage?: number;           // 0–1 if available
  memoryUsage?: number;        // bytes if available
}

export interface PoolMetrics {
  poolId: string;
  timestamp: number;
  totalNodes: number;
  healthyNodes: number;
  totalRps: number;
  avgErrorRate: number;
  avgLatencyMs: number;
}

// ── Events ───────────────────────────────────────────────────

export type SystemEventType =
  | "node:added"
  | "node:removed"
  | "node:status_change"
  | "circuit:opened"
  | "circuit:closed"
  | "circuit:half_open"
  | "shard:migrated"
  | "shard:rebalanced"
  | "pool:rebalanced"
  | "health_check:failed"
  | "health_check:recovered";

export interface SystemEvent {
  type: SystemEventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

// ── Request Context ──────────────────────────────────────────

export interface RequestContext {
  readonly id: string;
  readonly clientIp: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly startTime: number;
  attempt: number;
  /** shard key extracted from request (optional) */
  shardKey?: string;
  /** preferred node tags for affinity */
  affinityTags?: string[];
}

export interface RoutingDecision {
  node: BackendNode;
  shard?: Shard;
  algorithm: BalancingAlgorithm;
  attempt: number;
  durationMs: number;
}

// ── Common Result ────────────────────────────────────────────

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<E extends Error = Error>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ── Logger interface ─────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}
