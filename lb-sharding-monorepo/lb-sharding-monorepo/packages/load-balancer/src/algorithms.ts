// ============================================================
// @lb-sharding/load-balancer — Algorithm Implementations
// ============================================================

import type {
  BackendNode,
  BalancingAlgorithm,
  RequestContext,
} from "@lb-sharding/core";
import { murmur3, ConsistentHashRing } from "@lb-sharding/core";

export interface AlgorithmContext {
  ctx: RequestContext;
  nodes: BackendNode[];
}

export interface Selector {
  readonly algorithm: BalancingAlgorithm;
  select(context: AlgorithmContext): BackendNode | null;
  /** Called when a node is added/removed */
  onNodePoolChange?(nodes: BackendNode[]): void;
}

// ── Helpers ───────────────────────────────────────────────────

function healthyNodes(nodes: BackendNode[]): BackendNode[] {
  return nodes.filter((n) => n.status === "healthy" || n.status === "degraded");
}

// ── 1. Round Robin ────────────────────────────────────────────

export class RoundRobinSelector implements Selector {
  readonly algorithm = "round-robin" as const;
  private counter = 0;

  select({ nodes }: AlgorithmContext): BackendNode | null {
    const pool = healthyNodes(nodes);
    if (pool.length === 0) return null;
    const node = pool[this.counter % pool.length];
    this.counter = (this.counter + 1) % Number.MAX_SAFE_INTEGER;
    return node ?? null;
  }
}

// ── 2. Weighted Round Robin ───────────────────────────────────
//  Uses the Smooth Weighted Round-Robin (SWRR) algorithm — O(n) per pick,
//  zero jitter, supports dynamic weight updates.

interface WeightedNode {
  node: BackendNode;
  currentWeight: number;
  effectiveWeight: number;
}

export class WeightedRoundRobinSelector implements Selector {
  readonly algorithm = "weighted-round-robin" as const;
  private state = new Map<string, WeightedNode>();

  private ensureState(nodes: BackendNode[]): void {
    // Add new nodes
    for (const node of nodes) {
      if (!this.state.has(node.id)) {
        this.state.set(node.id, {
          node,
          currentWeight: 0,
          effectiveWeight: node.weight,
        });
      } else {
        // Update weight if changed
        const s = this.state.get(node.id)!;
        s.node = node;
        s.effectiveWeight = node.weight;
      }
    }
    // Remove stale nodes
    for (const id of this.state.keys()) {
      if (!nodes.find((n) => n.id === id)) this.state.delete(id);
    }
  }

  select({ nodes }: AlgorithmContext): BackendNode | null {
    const pool = healthyNodes(nodes);
    if (pool.length === 0) return null;
    this.ensureState(pool);

    let best: WeightedNode | null = null;
    let totalWeight = 0;

    for (const s of this.state.values()) {
      if (!pool.find((n) => n.id === s.node.id)) continue;
      s.currentWeight += s.effectiveWeight;
      totalWeight += s.effectiveWeight;
      if (!best || s.currentWeight > best.currentWeight) best = s;
    }

    if (!best) return null;
    best.currentWeight -= totalWeight;
    return best.node;
  }

  onNodePoolChange(nodes: BackendNode[]): void {
    this.ensureState(nodes);
  }
}

// ── 3. Least Connections ──────────────────────────────────────

export class LeastConnectionsSelector implements Selector {
  readonly algorithm = "least-connections" as const;

  select({ nodes }: AlgorithmContext): BackendNode | null {
    const pool = healthyNodes(nodes);
    if (pool.length === 0) return null;
    let best = pool[0]!;
    for (let i = 1; i < pool.length; i++) {
      const n = pool[i]!;
      // Weighted least-connections: connections / weight
      const scoreN = n.weight > 0 ? n.activeConnections / n.weight : Infinity;
      const scoreBest = best.weight > 0 ? best.activeConnections / best.weight : Infinity;
      if (scoreN < scoreBest) best = n;
    }
    return best;
  }
}

// ── 4. Least Response Time ────────────────────────────────────

export class LeastResponseTimeSelector implements Selector {
  readonly algorithm = "least-response-time" as const;

  select({ nodes }: AlgorithmContext): BackendNode | null {
    const pool = healthyNodes(nodes);
    if (pool.length === 0) return null;
    // Score = responseTimeMs * (activeConnections + 1)
    let best = pool[0]!;
    let bestScore = best.responseTimeMs * (best.activeConnections + 1);
    for (let i = 1; i < pool.length; i++) {
      const n = pool[i]!;
      const score = n.responseTimeMs * (n.activeConnections + 1);
      if (score < bestScore) {
        best = n;
        bestScore = score;
      }
    }
    return best;
  }
}

// ── 5. IP Hash ────────────────────────────────────────────────

export class IpHashSelector implements Selector {
  readonly algorithm = "ip-hash" as const;

  select({ nodes, ctx }: AlgorithmContext): BackendNode | null {
    const pool = healthyNodes(nodes);
    if (pool.length === 0) return null;
    const hash = murmur3(ctx.clientIp);
    return pool[hash % pool.length] ?? null;
  }
}

// ── 6. Consistent Hash ────────────────────────────────────────

export class ConsistentHashSelector implements Selector {
  readonly algorithm = "consistent-hash" as const;
  private ring = new ConsistentHashRing(150);
  private knownNodes = new Set<string>();

  private syncRing(nodes: BackendNode[]): void {
    const current = new Set(nodes.map((n) => n.id));
    // Add new
    for (const n of nodes) {
      if (!this.knownNodes.has(n.id)) {
        this.ring.addNode(n.id);
        this.knownNodes.add(n.id);
      }
    }
    // Remove gone
    for (const id of this.knownNodes) {
      if (!current.has(id)) {
        this.ring.removeNode(id);
        this.knownNodes.delete(id);
      }
    }
  }

  select({ nodes, ctx }: AlgorithmContext): BackendNode | null {
    const pool = healthyNodes(nodes);
    if (pool.length === 0) return null;
    this.syncRing(pool);
    const key = ctx.shardKey ?? ctx.clientIp;
    const nodeId = this.ring.getNode(key);
    if (!nodeId) return null;
    return pool.find((n) => n.id === nodeId) ?? pool[0] ?? null;
  }

  onNodePoolChange(nodes: BackendNode[]): void {
    this.syncRing(healthyNodes(nodes));
  }
}

// ── 7. Random ─────────────────────────────────────────────────

export class RandomSelector implements Selector {
  readonly algorithm = "random" as const;

  select({ nodes }: AlgorithmContext): BackendNode | null {
    const pool = healthyNodes(nodes);
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }
}

// ── 8. Power of Two Choices (Resource-Based) ─────────────────
//  Picks 2 random nodes and selects the better one — O(1) with
//  near-optimal load distribution. "Resource-based" in this
//  implementation uses combined CPU+memory if available.

export class ResourceBasedSelector implements Selector {
  readonly algorithm = "resource-based" as const;

  private score(n: BackendNode): number {
    // Normalised score — lower is better
    const connScore = n.activeConnections;
    const rtScore = n.responseTimeMs / 100;
    const cpuScore = (n.metadata["cpu"] ? parseFloat(n.metadata["cpu"]) : 0) * 10;
    return connScore + rtScore + cpuScore;
  }

  select({ nodes }: AlgorithmContext): BackendNode | null {
    const pool = healthyNodes(nodes);
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0] ?? null;

    // Power of two random choices
    const i = Math.floor(Math.random() * pool.length);
    let j = Math.floor(Math.random() * (pool.length - 1));
    if (j >= i) j++;
    const a = pool[i]!;
    const b = pool[j]!;
    return this.score(a) <= this.score(b) ? a : b;
  }
}

// ── 9. Sticky Session ─────────────────────────────────────────

export class StickySessionSelector implements Selector {
  readonly algorithm = "sticky-session" as const;
  /** sessionId → nodeId */
  private readonly sessions = new Map<string, { nodeId: string; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly fallback: Selector;

  constructor(ttlMs = 300_000, fallback: Selector = new RoundRobinSelector()) {
    this.ttlMs = ttlMs;
    this.fallback = fallback;
  }

  private getSessionId(ctx: RequestContext): string | null {
    return ctx.headers["x-session-id"] ?? ctx.headers["cookie"]?.match(/lb_session=([^;]+)/)?.[1] ?? null;
  }

  select(context: AlgorithmContext): BackendNode | null {
    const { nodes, ctx } = context;
    const pool = healthyNodes(nodes);
    if (pool.length === 0) return null;

    const sessionId = this.getSessionId(ctx);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session && session.expiresAt > Date.now()) {
        const node = pool.find((n) => n.id === session.nodeId);
        if (node) {
          // Refresh TTL
          session.expiresAt = Date.now() + this.ttlMs;
          return node;
        }
      }
      // Session expired or node gone — pick a new one
      const chosen = this.fallback.select(context);
      if (chosen && sessionId) {
        this.sessions.set(sessionId, {
          nodeId: chosen.id,
          expiresAt: Date.now() + this.ttlMs,
        });
      }
      return chosen;
    }

    return this.fallback.select(context);
  }

  /** Prune expired sessions */
  prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}

// ── Selector Factory ──────────────────────────────────────────

export function createSelector(algorithm: BalancingAlgorithm): Selector {
  switch (algorithm) {
    case "round-robin": return new RoundRobinSelector();
    case "weighted-round-robin": return new WeightedRoundRobinSelector();
    case "least-connections": return new LeastConnectionsSelector();
    case "least-response-time": return new LeastResponseTimeSelector();
    case "ip-hash": return new IpHashSelector();
    case "consistent-hash": return new ConsistentHashSelector();
    case "random": return new RandomSelector();
    case "resource-based": return new ResourceBasedSelector();
    case "sticky-session": return new StickySessionSelector();
    default:
      throw new Error(`Unknown algorithm: ${algorithm as string}`);
  }
}
