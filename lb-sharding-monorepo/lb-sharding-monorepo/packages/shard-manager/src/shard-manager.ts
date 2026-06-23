// ============================================================
// @lb-sharding/shard-manager — ShardManager
// ============================================================

import { EventEmitter } from "node:events";
import type {
  BackendNode,
  Logger,
  ShardConfig,
  ShardMap,
  ShardingResult,
  SystemEvent,
} from "@lb-sharding/core";
import { generateId } from "@lb-sharding/core";
import { type ShardStrategy, createShardStrategy } from "./strategies.js";

export interface ShardManagerOptions {
  config: ShardConfig;
  nodes: BackendNode[];
  logger: Logger;
}

export class ShardManager extends EventEmitter {
  private map: ShardMap;
  private nodes: BackendNode[];
  private readonly strategy: ShardStrategy;
  private readonly config: ShardConfig;
  private readonly logger: Logger;
  private rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({ config, nodes, logger }: ShardManagerOptions) {
    super();
    this.config = config;
    this.nodes = [...nodes];
    this.logger = logger.child({ component: "ShardManager", strategy: config.strategy });
    this.strategy = createShardStrategy(config.strategy);
    this.map = this.strategy.buildShardMap(this.nodes, this.config);
    this.logger.info("ShardMap built", {
      shards: this.map.shards.length,
      nodes: this.nodes.length,
      version: this.map.version,
    });
  }

  // ── Resolution ─────────────────────────────────────────────

  resolve(key: string): ShardingResult | null {
    return this.strategy.resolve(key, this.map, this.nodes);
  }

  // ── Node Management ────────────────────────────────────────

  addNode(node: BackendNode): void {
    if (this.nodes.find((n) => n.id === node.id)) return;
    this.nodes.push(node);
    this.logger.info("Node added to shard manager", { nodeId: node.id });
    this.scheduleRebalance();
  }

  removeNode(nodeId: string): void {
    this.nodes = this.nodes.filter((n) => n.id !== nodeId);
    this.logger.info("Node removed from shard manager", { nodeId });
    this.scheduleRebalance("immediate");
  }

  updateNode(nodeId: string, updates: Partial<BackendNode>): void {
    const idx = this.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) return;
    this.nodes[idx] = { ...this.nodes[idx]!, ...updates };
  }

  // ── Rebalance ──────────────────────────────────────────────

  private scheduleRebalance(mode: "debounced" | "immediate" = "debounced"): void {
    if (this.rebalanceTimer) clearTimeout(this.rebalanceTimer);
    const delay = mode === "immediate" ? 0 : 2_000;
    this.rebalanceTimer = setTimeout(() => {
      this.rebalanceTimer = null;
      this.doRebalance();
    }, delay);
  }

  private doRebalance(): void {
    const before = this.imbalanceScore();
    const newMap = this.strategy.rebalance(this.map, this.nodes, this.config);
    const after = this.computeImbalance(newMap);

    this.logger.info("Rebalance completed", {
      version: newMap.version,
      shards: newMap.shards.length,
      imbalanceBefore: before.toFixed(3),
      imbalanceAfter: after.toFixed(3),
    });

    this.map = newMap;
    const event: SystemEvent = {
      type: "pool:rebalanced",
      timestamp: Date.now(),
      payload: { version: newMap.version, shards: newMap.shards.length },
    };
    this.emit("rebalanced", newMap);
    this.emit("system_event", event);
  }

  forceRebalance(): void {
    this.doRebalance();
  }

  // ── Migration ──────────────────────────────────────────────

  beginMigration(shardId: string): void {
    const shard = this.map.shards.find((s) => s.id === shardId);
    if (!shard) throw new Error(`Shard ${shardId} not found`);
    shard.status = "migrating";
    this.logger.info("Shard migration started", { shardId });
  }

  completeMigration(shardId: string, newPrimaryNodeId: string): void {
    const shard = this.map.shards.find((s) => s.id === shardId);
    if (!shard) throw new Error(`Shard ${shardId} not found`);
    const oldPrimary = shard.primaryNodeId;
    shard.primaryNodeId = newPrimaryNodeId;
    shard.status = "active";
    this.map.nodeToShards = this.rebuildNodeToShards();
    this.map.version++;
    this.map.updatedAt = Date.now();
    this.logger.info("Shard migration completed", { shardId, from: oldPrimary, to: newPrimaryNodeId });
    const event: SystemEvent = {
      type: "shard:migrated",
      timestamp: Date.now(),
      payload: { shardId, from: oldPrimary, to: newPrimaryNodeId },
    };
    this.emit("migrated", shardId, newPrimaryNodeId);
    this.emit("system_event", event);
  }

  // ── Stats ──────────────────────────────────────────────────

  imbalanceScore(): number {
    return this.computeImbalance(this.map);
  }

  private computeImbalance(map: ShardMap): number {
    if (this.nodes.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const s of map.shards) {
      counts.set(s.primaryNodeId, (counts.get(s.primaryNodeId) ?? 0) + 1);
    }
    const values = [...counts.values()];
    if (values.length === 0) return 0;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length;
    return Math.sqrt(variance) / (avg || 1);
  }

  private rebuildNodeToShards(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const s of this.map.shards) {
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

  get currentMap(): Readonly<ShardMap> { return this.map; }
  get nodeCount(): number { return this.nodes.length; }
  get shardCount(): number { return this.map.shards.length; }

  stats() {
    return {
      version: this.map.version,
      shards: this.shardCount,
      nodes: this.nodeCount,
      strategy: this.config.strategy,
      imbalanceScore: this.imbalanceScore(),
      updatedAt: this.map.updatedAt,
    };
  }

  destroy(): void {
    if (this.rebalanceTimer) clearTimeout(this.rebalanceTimer);
  }
}
