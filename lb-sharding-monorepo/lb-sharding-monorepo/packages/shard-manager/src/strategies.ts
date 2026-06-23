// ============================================================
// @lb-sharding/shard-manager — Sharding Strategies
// ============================================================

import type {
  BackendNode,
  Shard,
  ShardConfig,
  ShardMap,
  ShardingResult,
  ShardingStrategy,
  Logger,
} from "@lb-sharding/core";
import { ConsistentHashRing, murmur3, generateId } from "@lb-sharding/core";

// ── Strategy Interface ────────────────────────────────────────

export interface ShardStrategy {
  readonly type: ShardingStrategy;
  buildShardMap(nodes: BackendNode[], config: ShardConfig): ShardMap;
  resolve(key: string, map: ShardMap, nodes: BackendNode[]): ShardingResult | null;
  rebalance(map: ShardMap, nodes: BackendNode[], config: ShardConfig): ShardMap;
}

// ── Helpers ───────────────────────────────────────────────────

function pickReplicas(
  primaryId: string,
  nodes: BackendNode[],
  factor: number,
): string[] {
  const others = nodes.filter((n) => n.id !== primaryId && n.status !== "offline");
  // Pick `factor - 1` replicas spread across different hosts when possible
  const replicas: string[] = [];
  const usedHosts = new Set<string>();
  usedHosts.add(nodes.find((n) => n.id === primaryId)?.host ?? "");

  for (const n of others) {
    if (replicas.length >= factor - 1) break;
    if (!usedHosts.has(n.host)) {
      usedHosts.add(n.host);
      replicas.push(n.id);
    }
  }
  // Fill remaining without host diversity constraint
  for (const n of others) {
    if (replicas.length >= factor - 1) break;
    if (!replicas.includes(n.id)) replicas.push(n.id);
  }
  return replicas;
}

function buildNodeToShards(shards: Shard[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const s of shards) {
    const arr = m.get(s.primaryNodeId) ?? [];
    arr.push(s.id);
    m.set(s.primaryNodeId, arr);
    for (const r of s.replicaNodeIds) {
      const ra = m.get(r) ?? [];
      ra.push(s.id);
      m.set(r, ra);
    }
  }
  return m;
}

// ── 1. Consistent Hash Strategy ──────────────────────────────

export class ConsistentHashStrategy implements ShardStrategy {
  readonly type = "consistent-hash" as const;

  buildShardMap(nodes: BackendNode[], config: ShardConfig): ShardMap {
    const ring = new ConsistentHashRing(config.virtualNodes);
    const healthy = nodes.filter((n) => n.status !== "offline");
    for (const n of healthy) ring.addNode(n.id);

    const shards: Shard[] = [];
    const totalTokens = 2 ** 32;
    const tokensPerShard = Math.floor(totalTokens / config.shardCount);

    for (let i = 0; i < config.shardCount; i++) {
      const token = i * tokensPerShard;
      const primaryId = ring.getNode(`shard-${i}`) ?? healthy[0]?.id ?? "";
      const replicaIds = pickReplicas(primaryId, healthy, config.replicationFactor);

      shards.push({
        id: generateId("shard"),
        token,
        primaryNodeId: primaryId,
        replicaNodeIds: replicaIds,
        status: "active",
        dataSize: 0,
        keyCount: 0,
      });
    }

    return {
      configId: config.id,
      shards,
      nodeToShards: buildNodeToShards(shards),
      version: 1,
      updatedAt: Date.now(),
    };
  }

  resolve(key: string, map: ShardMap, nodes: BackendNode[]): ShardingResult | null {
    if (map.shards.length === 0) return null;
    const token = murmur3(key);

    // Walk ring clockwise from token
    const sorted = [...map.shards].sort((a, b) => a.token - b.token);
    let shard = sorted.find((s) => s.token >= token) ?? sorted[0];
    if (!shard) return null;

    // Handle migrating shards — fall to next active
    let attempts = sorted.length;
    while (shard.status !== "active" && attempts-- > 0) {
      const idx = sorted.indexOf(shard);
      shard = sorted[(idx + 1) % sorted.length]!;
    }

    const primary = nodes.find((n) => n.id === shard!.primaryNodeId);
    if (!primary) return null;
    const replicas = shard.replicaNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is BackendNode => n !== undefined);

    return { shardId: shard.id, primaryNode: primary, replicaNodes: replicas, token };
  }

  rebalance(map: ShardMap, nodes: BackendNode[], config: ShardConfig): ShardMap {
    // Rebuild with updated node list
    const newMap = this.buildShardMap(nodes, config);
    newMap.version = map.version + 1;
    return newMap;
  }
}

// ── 2. Range Strategy ─────────────────────────────────────────

export class RangeStrategy implements ShardStrategy {
  readonly type = "range" as const;

  buildShardMap(nodes: BackendNode[], config: ShardConfig): ShardMap {
    const healthy = nodes.filter((n) => n.status !== "offline");
    const count = config.shardCount;
    const step = Math.floor((2 ** 32) / count);
    const shards: Shard[] = [];

    for (let i = 0; i < count; i++) {
      const nodeIdx = i % healthy.length;
      const primaryId = healthy[nodeIdx]?.id ?? "";
      const min = (i * step).toString(16).padStart(8, "0");
      const max = ((i + 1) * step - 1).toString(16).padStart(8, "0");

      shards.push({
        id: generateId("shard"),
        token: i * step,
        primaryNodeId: primaryId,
        replicaNodeIds: pickReplicas(primaryId, healthy, config.replicationFactor),
        keyRange: { min, max },
        status: "active",
        dataSize: 0,
        keyCount: 0,
      });
    }

    return {
      configId: config.id,
      shards,
      nodeToShards: buildNodeToShards(shards),
      version: 1,
      updatedAt: Date.now(),
    };
  }

  resolve(key: string, map: ShardMap, nodes: BackendNode[]): ShardingResult | null {
    const token = murmur3(key);
    const shard = map.shards
      .filter((s) => s.status === "active")
      .find((s) => token >= s.token && token < s.token + Math.floor((2 ** 32) / map.shards.length))
      ?? map.shards.find((s) => s.status === "active");

    if (!shard) return null;
    const primary = nodes.find((n) => n.id === shard.primaryNodeId);
    if (!primary) return null;
    const replicas = shard.replicaNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is BackendNode => n !== undefined);

    return { shardId: shard.id, primaryNode: primary, replicaNodes: replicas, token };
  }

  rebalance(map: ShardMap, nodes: BackendNode[], config: ShardConfig): ShardMap {
    const newMap = this.buildShardMap(nodes, config);
    newMap.version = map.version + 1;
    return newMap;
  }
}

// ── 3. Modulo Strategy ────────────────────────────────────────

export class ModuloStrategy implements ShardStrategy {
  readonly type = "modulo" as const;

  buildShardMap(nodes: BackendNode[], config: ShardConfig): ShardMap {
    const healthy = nodes.filter((n) => n.status !== "offline");
    const shards: Shard[] = [];

    for (let i = 0; i < config.shardCount; i++) {
      const primaryId = healthy[i % healthy.length]?.id ?? "";
      shards.push({
        id: generateId("shard"),
        token: i,
        primaryNodeId: primaryId,
        replicaNodeIds: pickReplicas(primaryId, healthy, config.replicationFactor),
        status: "active",
        dataSize: 0,
        keyCount: 0,
      });
    }

    return {
      configId: config.id,
      shards,
      nodeToShards: buildNodeToShards(shards),
      version: 1,
      updatedAt: Date.now(),
    };
  }

  resolve(key: string, map: ShardMap, nodes: BackendNode[]): ShardingResult | null {
    const idx = murmur3(key) % map.shards.length;
    const shard = map.shards[idx];
    if (!shard || shard.status !== "active") return null;
    const primary = nodes.find((n) => n.id === shard.primaryNodeId);
    if (!primary) return null;
    const replicas = shard.replicaNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is BackendNode => n !== undefined);
    return { shardId: shard.id, primaryNode: primary, replicaNodes: replicas, token: idx };
  }

  rebalance(map: ShardMap, nodes: BackendNode[], config: ShardConfig): ShardMap {
    const newMap = this.buildShardMap(nodes, config);
    newMap.version = map.version + 1;
    return newMap;
  }
}

// ── 4. Directory Strategy ─────────────────────────────────────

export class DirectoryStrategy implements ShardStrategy {
  readonly type = "directory" as const;
  /** key prefix → shardId */
  private readonly directory = new Map<string, string>();

  buildShardMap(nodes: BackendNode[], config: ShardConfig): ShardMap {
    const healthy = nodes.filter((n) => n.status !== "offline");
    const shards: Shard[] = [];

    for (let i = 0; i < config.shardCount; i++) {
      const primaryId = healthy[i % healthy.length]?.id ?? "";
      shards.push({
        id: `shard-${i}`,
        token: i,
        primaryNodeId: primaryId,
        replicaNodeIds: pickReplicas(primaryId, healthy, config.replicationFactor),
        status: "active",
        dataSize: 0,
        keyCount: 0,
      });
    }

    return {
      configId: config.id,
      shards,
      nodeToShards: buildNodeToShards(shards),
      version: 1,
      updatedAt: Date.now(),
    };
  }

  /** Explicitly map a key prefix to a shard */
  mapKeyToShard(keyPrefix: string, shardId: string): void {
    this.directory.set(keyPrefix, shardId);
  }

  resolve(key: string, map: ShardMap, nodes: BackendNode[]): ShardingResult | null {
    // Check directory first
    let shardId: string | undefined;
    for (const [prefix, sid] of this.directory) {
      if (key.startsWith(prefix)) { shardId = sid; break; }
    }

    const shard = shardId
      ? map.shards.find((s) => s.id === shardId)
      : map.shards[murmur3(key) % map.shards.length];

    if (!shard || shard.status !== "active") return null;
    const primary = nodes.find((n) => n.id === shard.primaryNodeId);
    if (!primary) return null;
    const replicas = shard.replicaNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is BackendNode => n !== undefined);
    return { shardId: shard.id, primaryNode: primary, replicaNodes: replicas, token: shard.token };
  }

  rebalance(map: ShardMap, nodes: BackendNode[], config: ShardConfig): ShardMap {
    const newMap = this.buildShardMap(nodes, config);
    newMap.version = map.version + 1;
    return newMap;
  }
}

// ── Strategy Factory ──────────────────────────────────────────

export function createShardStrategy(strategy: ShardingStrategy): ShardStrategy {
  switch (strategy) {
    case "consistent-hash": return new ConsistentHashStrategy();
    case "range":           return new RangeStrategy();
    case "modulo":          return new ModuloStrategy();
    case "directory":       return new DirectoryStrategy();
    case "geographic":      return new ConsistentHashStrategy(); // extend for geo
    case "custom":          return new ConsistentHashStrategy(); // plug-in override
    default:
      throw new Error(`Unknown sharding strategy: ${strategy as string}`);
  }
}
