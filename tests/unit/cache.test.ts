import { describe, expect, it, vi } from 'vitest';
import { MemoryCache, cacheKeyFor } from '../../src/cache.js';

describe('MemoryCache', () => {
  it('stores and retrieves values within TTL', () => {
    const cache = new MemoryCache<string>(1000, 10);
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
    expect(cache.size()).toBe(1);
    expect(cache.defaultTtlMs).toBe(1000);
  });

  it('evicts least recently used when capacity is reached', () => {
    const cache = new MemoryCache<number>(10000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('does not evict when overwriting an existing key (L3)', () => {
    const cache = new MemoryCache<number>(10000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('b', 3);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(3);
  });

  it('returns undefined and purges expired keys; ttl 0 disables caching', async () => {
    const cache = new MemoryCache<string>(10, 10);
    cache.set('expireMe', 'hello');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.get('expireMe')).toBeUndefined();
    cache.set('never', 'x', 0);
    expect(cache.size()).toBe(0);
  });

  it('de-duplicates concurrent computations and respects shouldCache', async () => {
    const cache = new MemoryCache<number>(10000, 10);
    const compute = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
    const [a, b] = await Promise.all([cache.getOrCompute('k', compute), cache.getOrCompute('k', compute)]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ value: 42, cached: false });
    expect(b.value).toBe(42);
    expect((await cache.getOrCompute('k', compute)).cached).toBe(true);

    await cache.getOrCompute('skip', async () => 1, () => false);
    expect(cache.get('skip')).toBeUndefined();
    await expect(cache.getOrCompute('err', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
  });

  it('clears all items', () => {
    const cache = new MemoryCache<string>(1000, 10);
    cache.set('x', '1');
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('builds keys without fragments', () => {
    expect(cacheKeyFor('seo', new URL('https://e.test/a?b=1#frag'))).toBe('seo:https://e.test/a?b=1');
  });
});
