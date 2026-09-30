import { CONFIG } from './config.js';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Builds a cache key from a prefix and URL, ignoring the fragment.
 * @param prefix Namespace (e.g. "seo")
 * @param url Target URL
 * @returns Cache key
 */
export function cacheKeyFor(prefix: string, url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return `${prefix}:${copy.href}`;
}

/**
 * In-memory LRU TTL cache with in-flight request de-duplication.
 */
export class MemoryCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private inflight = new Map<string, Promise<T>>();
  private ttlMs: number;
  private maxEntries: number;

  /**
   * Initializes cache with TTL and max entries.
   * @param ttlMs Default time to live in milliseconds
   * @param maxEntries Maximum cached items
   */
  constructor(ttlMs = CONFIG.cache.ttlMs, maxEntries = CONFIG.cache.maxEntries) {
    this.ttlMs = ttlMs;
    this.maxEntries = Math.max(1, maxEntries);
  }

  get defaultTtlMs(): number {
    return this.ttlMs;
  }

  /**
   * Gets cached entry if present and not expired.
   * @param key Cache key
   * @returns Cached value or undefined
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  /**
   * Sets cached entry with expiration. Evicts the least recently used entry only for new keys.
   * @param key Cache key
   * @param data Payload to store
   * @param ttlMs Optional per-entry TTL
   */
  set(key: string, data: T, ttlMs = this.ttlMs): void {
    if (ttlMs <= 0) return;
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Returns a cached value or computes it once, sharing the pending promise with concurrent callers.
   * @param key Cache key
   * @param compute Producer
   * @param shouldCache Predicate deciding whether a computed value is stored
   * @returns Value plus whether it came from cache
   */
  async getOrCompute(
    key: string,
    compute: () => Promise<T>,
    shouldCache: (value: T) => boolean = () => true,
  ): Promise<{ value: T; cached: boolean }> {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };

    const pending = this.inflight.get(key);
    if (pending) return { value: await pending, cached: false };

    const promise = compute();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      if (shouldCache(value)) this.set(key, value);
      return { value, cached: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Clears all cache entries.
   */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  /**
   * Returns current cache size.
   * @returns number
   */
  size(): number {
    return this.cache.size;
  }
}

export const auditCache = new MemoryCache<unknown>();
