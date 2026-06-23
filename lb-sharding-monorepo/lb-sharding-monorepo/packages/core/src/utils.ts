// ============================================================
// @lb-sharding/core — Utilities
// ============================================================

import { createHash, randomBytes } from "node:crypto";

// ── ID Generation ─────────────────────────────────────────────

export function generateId(prefix = ""): string {
  const rand = randomBytes(8).toString("hex");
  const ts = Date.now().toString(36);
  return prefix ? `${prefix}_${ts}${rand}` : `${ts}${rand}`;
}

// ── Hashing ──────────────────────────────────────────────────

/**
 * Deterministic 32-bit hash of a string key.
 * Uses SHA-256 internally but truncates to 32 bits for ring use.
 */
export function hash32(key: string): number {
  const buf = createHash("sha256").update(key).digest();
  // Read first 4 bytes as unsigned 32-bit int (big-endian)
  return ((buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!) >>> 0;
}

/**
 * MurmurHash3 32-bit — fast, good distribution, for hot paths.
 */
export function murmur3(key: string, seed = 0): number {
  let h = seed;
  const data = Buffer.from(key, "utf8");
  const len = data.length;
  const remainder = len & 3;
  const bytes = len - remainder;
  let i = 0;

  const C1 = 0xcc9e2d51;
  const C2 = 0x1b873593;

  while (i < bytes) {
    let k =
      ((data[i]! & 0xff)) |
      ((data[i + 1]! & 0xff) << 8) |
      ((data[i + 2]! & 0xff) << 16) |
      ((data[i + 3]! & 0xff) << 24);
    i += 4;
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  let k = 0;
  if (remainder >= 3) k ^= (data[i + 2]! & 0xff) << 16;
  if (remainder >= 2) k ^= (data[i + 1]! & 0xff) << 8;
  if (remainder >= 1) {
    k ^= data[i]! & 0xff;
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    h ^= k;
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ── Consistent Hash Ring ──────────────────────────────────────

interface RingEntry {
  token: number;
  nodeId: string;
  vnode: number;
}

export class ConsistentHashRing {
  private ring: RingEntry[] = [];
  private readonly vnodeCount: number;

  constructor(vnodeCount = 150) {
    this.vnodeCount = vnodeCount;
  }

  addNode(nodeId: string): void {
    for (let v = 0; v < this.vnodeCount; v++) {
      const token = murmur3(`${nodeId}#vn${v}`);
      this.ring.push({ token, nodeId, vnode: v });
    }
    this.ring.sort((a, b) => a.token - b.token);
  }

  removeNode(nodeId: string): void {
    this.ring = this.ring.filter((e) => e.nodeId !== nodeId);
  }

  getNode(key: string): string | null {
    if (this.ring.length === 0) return null;
    const hash = murmur3(key);
    // Binary search for the first node with token >= hash
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid]!.token < hash) lo = mid + 1;
      else hi = mid;
    }
    // Wrap around
    const entry = this.ring[lo % this.ring.length];
    return entry?.nodeId ?? null;
  }

  /** Return N distinct nodes walking clockwise from key */
  getNodes(key: string, count: number): string[] {
    if (this.ring.length === 0) return [];
    const hash = murmur3(key);
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid]!.token < hash) lo = mid + 1;
      else hi = mid;
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (let i = 0; i < this.ring.length && result.length < count; i++) {
      const entry = this.ring[(lo + i) % this.ring.length];
      if (entry && !seen.has(entry.nodeId)) {
        seen.add(entry.nodeId);
        result.push(entry.nodeId);
      }
    }
    return result;
  }

  get size(): number {
    return new Set(this.ring.map((e) => e.nodeId)).size;
  }

  getTokenDistribution(): Map<string, number> {
    const dist = new Map<string, number>();
    for (const entry of this.ring) {
      dist.set(entry.nodeId, (dist.get(entry.nodeId) ?? 0) + 1);
    }
    return dist;
  }
}

// ── Exponential Moving Average ────────────────────────────────

export class EMA {
  private value: number;
  private readonly alpha: number;

  constructor(initialValue = 0, windowSize = 10) {
    this.value = initialValue;
    // Typical EMA alpha: 2 / (window + 1)
    this.alpha = 2 / (windowSize + 1);
  }

  update(sample: number): number {
    this.value = this.alpha * sample + (1 - this.alpha) * this.value;
    return this.value;
  }

  get current(): number {
    return this.value;
  }
}

// ── Rolling Window Counter ────────────────────────────────────

export class RollingWindow {
  private readonly buckets: number[];
  private readonly windowMs: number;
  private readonly bucketCount: number;
  private lastRotateTime: number;
  private currentBucket: number;

  constructor(windowMs = 10_000, bucketCount = 10) {
    this.windowMs = windowMs;
    this.bucketCount = bucketCount;
    this.buckets = new Array<number>(bucketCount).fill(0);
    this.lastRotateTime = Date.now();
    this.currentBucket = 0;
  }

  private rotate(): void {
    const now = Date.now();
    const elapsed = now - this.lastRotateTime;
    const bucketMs = this.windowMs / this.bucketCount;
    const steps = Math.min(
      Math.floor(elapsed / bucketMs),
      this.bucketCount
    );
    for (let i = 0; i < steps; i++) {
      this.currentBucket = (this.currentBucket + 1) % this.bucketCount;
      this.buckets[this.currentBucket] = 0;
    }
    this.lastRotateTime = now;
  }

  increment(by = 1): void {
    this.rotate();
    this.buckets[this.currentBucket]! += by;
  }

  sum(): number {
    this.rotate();
    return this.buckets.reduce((a, b) => a + b, 0);
  }

  rate(): number {
    return this.sum() / (this.windowMs / 1000);
  }
}

// ── Percentile Tracker (t-digest lite) ──────────────────────

export class PercentilesTracker {
  private readonly samples: number[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 1000) {
    this.maxSamples = maxSamples;
  }

  record(value: number): void {
    if (this.samples.length >= this.maxSamples) {
      // Evict oldest
      this.samples.splice(0, 1);
    }
    // Insert sorted
    let lo = 0;
    let hi = this.samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.samples[mid]! < value) lo = mid + 1;
      else hi = mid;
    }
    this.samples.splice(lo, 0, value);
  }

  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const idx = Math.floor((p / 100) * (this.samples.length - 1));
    return this.samples[idx] ?? 0;
  }

  p50(): number { return this.percentile(50); }
  p95(): number { return this.percentile(95); }
  p99(): number { return this.percentile(99); }
}

// ── Sleep ─────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Clamp ─────────────────────────────────────────────────────

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
