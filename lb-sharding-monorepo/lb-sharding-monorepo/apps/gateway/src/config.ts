// ============================================================
// apps/gateway — Configuration
// ============================================================

import type { BalancingAlgorithm, HealthCheckConfig, LoadBalancerConfig, ShardConfig, ShardingStrategy } from "@lb-sharding/core";

export interface GatewayConfig {
  server: {
    host: string;
    port: number;
    adminPort: number;
    metricsPort: number;
  };
  loadBalancer: LoadBalancerConfig;
  sharding: {
    enabled: boolean;
    config: ShardConfig;
  };
  proxy: {
    keepAlive: boolean;
    maxSockets: number;
    requestTimeoutMs: number;
  };
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  return v !== undefined ? v === "true" || v === "1" : fallback;
}

export function loadConfig(): GatewayConfig {
  const healthCheck: HealthCheckConfig = {
    type: env("HEALTH_CHECK_TYPE", "http") as HealthCheckConfig["type"],
    intervalMs: envInt("HEALTH_CHECK_INTERVAL_MS", 10_000),
    timeoutMs: envInt("HEALTH_CHECK_TIMEOUT_MS", 3_000),
    unhealthyThreshold: envInt("HEALTH_UNHEALTHY_THRESHOLD", 3),
    healthyThreshold: envInt("HEALTH_HEALTHY_THRESHOLD", 2),
    path: env("HEALTH_CHECK_PATH", "/health"),
    expectedStatus: envInt("HEALTH_CHECK_STATUS", 200),
  };

  const loadBalancer: LoadBalancerConfig = {
    algorithm: env("LB_ALGORITHM", "round-robin") as BalancingAlgorithm,
    healthCheck,
    retries: {
      maxAttempts: envInt("LB_MAX_RETRIES", 3),
      backoffMs: envInt("LB_BACKOFF_MS", 50),
      backoffMultiplier: 2,
      maxBackoffMs: 2_000,
      retryableStatusCodes: [502, 503, 504],
    },
    circuitBreaker: {
      failureThreshold: 0.5,
      windowSize: 20,
      recoveryTimeMs: envInt("CB_RECOVERY_MS", 30_000),
      halfOpenRequests: 3,
    },
    timeout: {
      connectMs: envInt("TIMEOUT_CONNECT_MS", 3_000),
      readMs: envInt("TIMEOUT_READ_MS", 30_000),
      writeMs: envInt("TIMEOUT_WRITE_MS", 10_000),
      idleMs: envInt("TIMEOUT_IDLE_MS", 60_000),
    },
    sticky: envBool("LB_STICKY", false)
      ? { cookieName: "lb_session", ttlSeconds: 300, fallback: "round-robin" }
      : undefined,
  };

  const shardConfig: ShardConfig = {
    id: "default-shard-config",
    strategy: env("SHARD_STRATEGY", "consistent-hash") as ShardingStrategy,
    replicationFactor: envInt("SHARD_REPLICATION_FACTOR", 2),
    virtualNodes: envInt("SHARD_VIRTUAL_NODES", 150),
    shardCount: envInt("SHARD_COUNT", 64),
    rebalanceThreshold: 0.2,
  };

  return {
    server: {
      host: env("HOST", "0.0.0.0"),
      port: envInt("PORT", 8080),
      adminPort: envInt("ADMIN_PORT", 9000),
      metricsPort: envInt("METRICS_PORT", 9090),
    },
    loadBalancer,
    sharding: {
      enabled: envBool("SHARDING_ENABLED", false),
      config: shardConfig,
    },
    proxy: {
      keepAlive: envBool("PROXY_KEEPALIVE", true),
      maxSockets: envInt("PROXY_MAX_SOCKETS", 512),
      requestTimeoutMs: envInt("PROXY_REQUEST_TIMEOUT_MS", 30_000),
    },
  };
}
