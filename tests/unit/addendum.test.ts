import { describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCodes, abortToAppError, abortable } from '../../src/errors.js';
import { redactUrl } from '../../src/logger.js';
import { RateLimiter } from '../../src/rateLimit.js';

describe('RateLimiter', () => {
  it('allows requests under the limit then blocks with a single code prefix', () => {
    const limiter = new RateLimiter(60_000, 2);
    expect(() => limiter.check('a')).not.toThrow();
    expect(() => limiter.check('a')).not.toThrow();
    expect(limiter.isLimited('a')).toBe(true);
    try {
      limiter.check('a');
    } catch (err) {
      expect((err as AppError).toClientMessage()).toMatch(/^RATE_LIMITED: Rate limit exceeded/);
    }
  });

  it('isolates clients and does not count isLimited as a hit', () => {
    const limiter = new RateLimiter(60_000, 1);
    expect(limiter.isLimited('client-1')).toBe(false);
    expect(() => limiter.check('client-1')).not.toThrow();
    expect(() => limiter.check('client-2')).not.toThrow();
    expect(() => limiter.check('client-1')).toThrow();
  });

  it('resets after the window and prunes expired buckets', () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(1000, 1);
      limiter.check('a');
      limiter.check('b');
      expect(limiter.size()).toBe(2);
      vi.advanceTimersByTime(1500);
      expect(limiter.isLimited('a')).toBe(false);
      limiter.check('c');
      expect(limiter.size()).toBe(1);
      limiter.clear();
      expect(limiter.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the number of tracked clients', () => {
    const limiter = new RateLimiter(60_000, 5, 3);
    for (const key of ['a', 'b', 'c', 'd', 'e']) limiter.check(key);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});

describe('errors', () => {
  it('maps abort reasons to TIMEOUT or CANCELLED', async () => {
    const timeout = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(abortToAppError(timeout).code).toBe(ErrorCodes.Timeout);
    const controller = new AbortController();
    controller.abort();
    expect(abortToAppError(controller.signal).code).toBe(ErrorCodes.Cancelled);
    const custom = new AbortController();
    custom.abort(new AppError(ErrorCodes.FetchFailed, 'x'));
    expect(abortToAppError(custom.signal).code).toBe(ErrorCodes.FetchFailed);
  });

  it('abortable resolves, rejects, and aborts', async () => {
    expect(await abortable(Promise.resolve(1))).toBe(1);
    expect(await abortable(Promise.resolve(2), new AbortController().signal)).toBe(2);
    await expect(abortable(Promise.reject(new Error('e')), new AbortController().signal)).rejects.toThrow('e');
    await expect(abortable(Promise.reject('str'), new AbortController().signal)).rejects.toThrow('str');
    const aborted = new AbortController();
    aborted.abort();
    await expect(abortable(new Promise(() => undefined), aborted.signal)).rejects.toMatchObject({ code: ErrorCodes.Cancelled });
    const later = new AbortController();
    const pending = abortable(new Promise(() => undefined), later.signal);
    later.abort();
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.Cancelled });
  });
});

describe('redactUrl (L10)', () => {
  it('drops query strings, fragments and credentials', () => {
    expect(redactUrl('https://u:p@example.com/path?token=secret#x')).toBe('https://example.com/path');
    expect(redactUrl('not a url')).toBe('[invalid-url]');
  });
});
