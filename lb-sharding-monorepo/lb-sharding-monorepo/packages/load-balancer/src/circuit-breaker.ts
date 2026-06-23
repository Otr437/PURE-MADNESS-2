// ============================================================
// @lb-sharding/load-balancer — Circuit Breaker
// ============================================================

import type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  Logger,
  SystemEvent,
} from "@lb-sharding/core";
import { RollingWindow } from "@lb-sharding/core";

export type CircuitBreakerEventHandler = (event: SystemEvent) => void;

export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private readonly failures: RollingWindow;
  private readonly requests: RollingWindow;
  private halfOpenAttempts = 0;
  private lastStateChange = Date.now();
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly nodeId: string,
    private readonly config: CircuitBreakerConfig,
    private readonly logger: Logger,
    private readonly onEvent?: CircuitBreakerEventHandler,
  ) {
    const windowMs = 60_000;
    this.failures = new RollingWindow(windowMs, 12);
    this.requests = new RollingWindow(windowMs, 12);
  }

  /** Returns true if the request is allowed through */
  allowRequest(): boolean {
    switch (this.state) {
      case "closed":
        return true;
      case "open":
        return false;
      case "half-open":
        return this.halfOpenAttempts < this.config.halfOpenRequests;
    }
  }

  /** Call on successful response */
  recordSuccess(): void {
    this.requests.increment();
    if (this.state === "half-open") {
      this.halfOpenAttempts++;
      const needed = this.config.halfOpenRequests;
      if (this.halfOpenAttempts >= needed) {
        this.transitionTo("closed");
      }
    }
  }

  /** Call on failed response */
  recordFailure(): void {
    this.requests.increment();
    this.failures.increment();

    if (this.state === "half-open") {
      // Any failure in half-open re-opens immediately
      this.transitionTo("open");
      return;
    }

    if (this.state === "closed") {
      const total = this.requests.sum();
      if (total >= this.config.windowSize) {
        const rate = this.failures.sum() / total;
        if (rate >= this.config.failureThreshold) {
          this.transitionTo("open");
        }
      }
    }
  }

  get currentState(): CircuitBreakerState {
    return this.state;
  }

  get failureRate(): number {
    const total = this.requests.sum();
    if (total === 0) return 0;
    return this.failures.sum() / total;
  }

  private transitionTo(next: CircuitBreakerState): void {
    const prev = this.state;
    this.state = next;
    this.lastStateChange = Date.now();
    this.halfOpenAttempts = 0;

    const eventType =
      next === "open" ? "circuit:opened" :
      next === "closed" ? "circuit:closed" :
      "circuit:half_open";

    this.logger.warn(`Circuit breaker transition`, {
      nodeId: this.nodeId,
      from: prev,
      to: next,
      failureRate: this.failureRate,
    });

    this.onEvent?.({
      type: eventType,
      timestamp: Date.now(),
      payload: { nodeId: this.nodeId, from: prev, to: next },
    });

    if (next === "open") {
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = setTimeout(() => {
        this.transitionTo("half-open");
      }, this.config.recoveryTimeMs);
    }
  }

  destroy(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
  }
}

// ── Per-pool Circuit Breaker Registry ────────────────────────

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly logger: Logger,
    private readonly onEvent?: CircuitBreakerEventHandler,
  ) {}

  get(nodeId: string): CircuitBreaker {
    let cb = this.breakers.get(nodeId);
    if (!cb) {
      cb = new CircuitBreaker(nodeId, this.config, this.logger, this.onEvent);
      this.breakers.set(nodeId, cb);
    }
    return cb;
  }

  remove(nodeId: string): void {
    this.breakers.get(nodeId)?.destroy();
    this.breakers.delete(nodeId);
  }

  stats(): Record<string, { state: CircuitBreakerState; failureRate: number }> {
    const out: Record<string, { state: CircuitBreakerState; failureRate: number }> = {};
    for (const [id, cb] of this.breakers) {
      out[id] = { state: cb.currentState, failureRate: cb.failureRate };
    }
    return out;
  }
}
