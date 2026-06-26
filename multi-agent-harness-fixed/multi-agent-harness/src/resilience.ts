// src/resilience.ts
// Retry with exponential backoff + jitter.
// Circuit breaker per provider — stops calling a provider that keeps failing.

export interface RetryOptions {
  maxAttempts: number;       // total attempts (1 = no retry)
  baseDelayMs: number;       // starting backoff delay
  maxDelayMs: number;        // cap on backoff delay
  jitterMs: number;          // max random jitter added to each delay
  retryOn?: (err: unknown) => boolean; // custom predicate; default: always retry
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 16_000,
  jitterMs: 300,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt: number, opts: RetryOptions): number {
  // Exponential backoff: baseDelay * 2^(attempt-1), capped at maxDelay
  const exp = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
  const jitter = Math.random() * opts.jitterMs;
  return exp + jitter;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY,
  label = "task"
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const shouldRetry = opts.retryOn ? opts.retryOn(err) : true;
      if (!shouldRetry || attempt === opts.maxAttempts) break;

      const delay = backoffDelay(attempt, opts);
      console.warn(
        `  [retry] ${label} attempt ${attempt}/${opts.maxAttempts} failed. Retrying in ${Math.round(delay)}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastErr;
}

// ─── CIRCUIT BREAKER ──────────────────────────────────────────────────────────
// Tracks consecutive failures per provider.
// After failureThreshold failures, the breaker opens and rejects calls immediately.
// After resetTimeoutMs, moves to half-open: allows one trial call.
// On success in half-open → closed. On failure → open again.

type BreakerState = "closed" | "open" | "half-open";

interface BreakerRecord {
  state: BreakerState;
  failures: number;
  lastFailureTime: number;
}

export class CircuitBreakerRegistry {
  private breakers = new Map<string, BreakerRecord>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly resetTimeoutMs = 60_000
  ) {}

  private getOrCreate(id: string): BreakerRecord {
    if (!this.breakers.has(id)) {
      this.breakers.set(id, { state: "closed", failures: 0, lastFailureTime: 0 });
    }
    return this.breakers.get(id)!;
  }

  isOpen(id: string): boolean {
    const b = this.getOrCreate(id);

    if (b.state === "open") {
      if (Date.now() - b.lastFailureTime >= this.resetTimeoutMs) {
        b.state = "half-open";
        console.log(`  [circuit] ${id}: half-open — allowing trial call`);
        return false;
      }
      return true;
    }

    return false;
  }

  recordSuccess(id: string): void {
    const b = this.getOrCreate(id);
    b.failures = 0;
    b.state = "closed";
  }

  recordFailure(id: string): void {
    const b = this.getOrCreate(id);
    b.failures++;
    b.lastFailureTime = Date.now();

    if (b.state === "half-open" || b.failures >= this.failureThreshold) {
      b.state = "open";
      console.error(
        `  [circuit] ${id}: OPEN after ${b.failures} failure(s). Blocking for ${this.resetTimeoutMs / 1000}s`
      );
    }
  }

  status(): Record<string, BreakerRecord> {
    return Object.fromEntries(this.breakers.entries());
  }
}

// Singleton used across the harness
export const circuitBreakers = new CircuitBreakerRegistry(5, 60_000);
