// src/rate-limiter.ts
// Token-bucket rate limiter per provider.
// Prevents hammering any single provider and triggering 429s.
// Each provider gets its own bucket with configurable RPM (requests per minute).

export interface BucketConfig {
  rpm: number;            // max requests per minute
  burstCapacity?: number; // allow short bursts above steady rate (default = rpm)
}

// Conservative defaults (May 2026 free/tier-1 limits)
export const DEFAULT_PROVIDER_LIMITS: Record<string, BucketConfig> = {
  claude:   { rpm: 50,  burstCapacity: 5  },
  openai:   { rpm: 60,  burstCapacity: 10 },
  groq:     { rpm: 30,  burstCapacity: 5  },
  deepseek: { rpm: 60,  burstCapacity: 10 },
};

interface Bucket {
  tokens: number;
  lastRefillTime: number;
  rpm: number;
  capacity: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class RateLimiterRegistry {
  private buckets = new Map<string, Bucket>();

  register(provider: string, config: BucketConfig): void {
    const capacity = config.burstCapacity ?? config.rpm;
    this.buckets.set(provider, {
      tokens: capacity,
      lastRefillTime: Date.now(),
      rpm: config.rpm,
      capacity,
    });
  }

  private refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefillTime) / 1000 / 60; // minutes
    const newTokens = elapsed * bucket.rpm;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + newTokens);
    bucket.lastRefillTime = now;
  }

  // Acquires a token for the given provider. Waits if the bucket is empty.
  async acquire(provider: string): Promise<void> {
    if (!this.buckets.has(provider)) {
      const config = DEFAULT_PROVIDER_LIMITS[provider] ?? { rpm: 30 };
      this.register(provider, config);
    }

    const bucket = this.buckets.get(provider)!;

    while (true) {
      this.refill(bucket);

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }

      // Calculate how long until one token refills
      const msPerToken = (60 * 1000) / bucket.rpm;
      const waitMs = Math.ceil(msPerToken * (1 - bucket.tokens));
      console.log(
        `  [rate-limiter] ${provider}: bucket empty. Waiting ${waitMs}ms...`
      );
      await sleep(waitMs);
    }
  }

  status(): Record<string, { tokens: number; capacity: number; rpm: number }> {
    const out: Record<string, { tokens: number; capacity: number; rpm: number }> = {};
    for (const [provider, b] of this.buckets.entries()) {
      this.refill(b);
      out[provider] = {
        tokens: Math.round(b.tokens * 100) / 100,
        capacity: b.capacity,
        rpm: b.rpm,
      };
    }
    return out;
  }
}

// Singleton used across the harness
export const rateLimiter = new RateLimiterRegistry();

// Pre-register all four providers at startup
for (const [provider, config] of Object.entries(DEFAULT_PROVIDER_LIMITS)) {
  rateLimiter.register(provider, config);
}
