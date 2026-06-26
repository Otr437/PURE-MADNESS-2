// src/concurrency.ts
// Semaphore-based concurrency limiter.
// Caps how many agent calls run simultaneously regardless of how many tasks exist.
// Prevents memory exhaustion and thundering-herd on providers.

export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  stats(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }
}

// Wraps Promise.all with a concurrency cap — drop-in replacement.
// concurrentAll(tasks, 5, fn) runs fn on each task, max 5 at a time.
export async function concurrentAll<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const sem = new Semaphore(concurrency);
  return Promise.all(items.map((item, i) => sem.run(() => fn(item, i))));
}

// Default concurrency limits per provider (conservative — tune to your tier)
export const DEFAULT_CONCURRENCY: Record<string, number> = {
  claude:   5,
  openai:   10,
  groq:     5,
  deepseek: 8,
};

// Per-provider semaphore registry
export class ConcurrencyRegistry {
  private semaphores = new Map<string, Semaphore>();

  constructor(private defaults: Record<string, number> = DEFAULT_CONCURRENCY) {}

  get(provider: string): Semaphore {
    if (!this.semaphores.has(provider)) {
      const limit = this.defaults[provider] ?? 5;
      this.semaphores.set(provider, new Semaphore(limit));
    }
    return this.semaphores.get(provider)!;
  }

  async run<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    return this.get(provider).run(fn);
  }

  stats(): Record<string, ReturnType<Semaphore["stats"]>> {
    const out: Record<string, ReturnType<Semaphore["stats"]>> = {};
    for (const [provider, sem] of this.semaphores.entries()) {
      out[provider] = sem.stats();
    }
    return out;
  }
}

// Singleton
export const concurrencyRegistry = new ConcurrencyRegistry();
