import { CONFIG } from './config.js';
import { AppError, ErrorCodes } from './errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_BUCKETS = 10_000;

/**
 * Fixed-window in-memory rate limiter with periodic pruning of expired buckets.
 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly maxBuckets: number;
  private readonly buckets = new Map<string, Bucket>();
  private lastPrune = Date.now();

  constructor(
    windowMs = CONFIG.http.rateLimitWindowMs,
    max = CONFIG.http.rateLimitMax,
    maxBuckets = DEFAULT_MAX_BUCKETS,
  ) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxBuckets = maxBuckets;
  }

  private prune(now: number): void {
    if (now - this.lastPrune >= this.windowMs) {
      for (const [key, bucket] of this.buckets) {
        if (now >= bucket.resetAt) this.buckets.delete(key);
      }
      this.lastPrune = now;
    }
    while (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  private activeBucket(clientKey: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(clientKey);
    if (bucket && now >= bucket.resetAt) {
      this.buckets.delete(clientKey);
      return undefined;
    }
    return bucket;
  }

  /**
   * Returns true when the client has exhausted its budget (does not count a hit).
   * @param clientKey Client identifier
   * @returns boolean
   */
  isLimited(clientKey: string): boolean {
    const bucket = this.activeBucket(clientKey, Date.now());
    return bucket !== undefined && bucket.count >= this.max;
  }

  /**
   * Records a hit.
   * @param clientKey Client identifier
   * @throws AppError RATE_LIMITED when exceeded
   */
  check(clientKey: string): void {
    const now = Date.now();
    let bucket = this.activeBucket(clientKey, now);
    if (!bucket) {
      this.prune(now);
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(clientKey, bucket);
    }
    bucket.count += 1;
    if (bucket.count > this.max) {
      throw new AppError(
        ErrorCodes.RateLimited,
        `Rate limit exceeded (${this.max} requests per ${Math.round(this.windowMs / 1000)}s)`,
      );
    }
  }

  size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }
}
