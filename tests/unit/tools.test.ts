import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchResult } from '../../src/types.js';
import { fetchResultFixture } from '../helpers.js';

const safeFetchMock = vi.hoisted(() => vi.fn<(url: string, opts?: unknown) => Promise<FetchResult>>());
vi.mock('../../src/fetcher.js', () => ({ safeFetch: safeFetchMock }));

const { auditCache } = await import('../../src/cache.js');
const { CONFIG } = await import('../../src/config.js');
const { clearRobotsCache } = await import('../../src/robots.js');
const { ALL_TOOLS } = await import('../../src/tools/index.js');
const { createProgressReporter } = await import('../../src/tools/common.js');

const tool = (name: string) => {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(name);
  return found;
};
const text = (r: { content: Array<{ type: string; text?: string }> }) => (r.content[0] as { text: string }).text;

describe('tool handlers', () => {
  beforeEach(() => {
    auditCache.clear();
    clearRobotsCache();
    safeFetchMock.mockReset();
  });

  afterEach(() => {
    CONFIG.network.respectRobotsTxt = false;
    CONFIG.network.totalTimeoutMs = 45_000;
  });

  it('rejects SSRF payloads before fetching', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/', 'http://internal.example/']) {
      const result = await tool('audit_security').handler({ url, format: 'markdown' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Validation Error: SSRF_BLOCKED');
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('runs a page audit, caches it and marks cached markdown', async () => {
    safeFetchMock.mockResolvedValue(fetchResultFixture());
    const first = await tool('audit_seo').handler({ url: 'https://example.com/#a', format: 'markdown' });
    expect(first.isError).toBeUndefined();
    expect(text(first)).toContain('# 🔍 SEO Audit Report');
    const second = await tool('audit_seo').handler({ url: 'https://example.com/#b', format: 'markdown' });
    expect(text(second)).toMatch(/^> ℹ️ \*Results served from cache \(TTL: 5 min\)/);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const json = await tool('audit_seo').handler({ url: 'https://example.com/', format: 'json' });
    expect(JSON.parse(text(json)).url).toBe('https://example.com/');
  });

  it.each(['audit_seo', 'audit_security', 'audit_tracking', 'audit_accessibility', 'audit_performance', 'audit_full'])(
    '%s returns HTTP_ERROR for non-2xx targets (M2)',
    async (name) => {
      safeFetchMock.mockResolvedValue(fetchResultFixture({ status: 403, statusText: 'Forbidden' }));
      const result = await tool(name).handler({ url: 'https://example.com/', format: 'markdown' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('HTTP_ERROR: Target responded with HTTP 403 Forbidden');
      expect(text(result)).toContain('block automated clients');
    },
  );

  it('rejects non-HTML for HTML engines but still audits security headers', async () => {
    safeFetchMock.mockResolvedValue(fetchResultFixture({ contentType: 'application/pdf', body: '%PDF-1.7' }));
    const seo = await tool('audit_seo').handler({ url: 'https://example.com/file.pdf', format: 'markdown' });
    expect(seo.isError).toBe(true);
    expect(text(seo)).toContain('NOT_HTML');
    const sec = await tool('audit_security').handler({ url: 'https://example.com/file.pdf', format: 'json' });
    expect(sec.isError).toBeUndefined();
    const full = await tool('audit_full').handler({ url: 'https://example.com/file.pdf', format: 'json' });
    const parsed = JSON.parse(text(full));
    expect(parsed.errors.seo).toContain('NOT_HTML');
    expect(parsed.security).toBeDefined();
  });

  it('sniffs HTML when content-type is missing', async () => {
    safeFetchMock.mockResolvedValue(fetchResultFixture({ contentType: undefined }));
    const res = await tool('audit_accessibility').handler({ url: 'https://example.com/', format: 'markdown' });
    expect(res.isError).toBeUndefined();
  });

  it('runs all remaining tools on a normal page', async () => {
    safeFetchMock.mockResolvedValue(fetchResultFixture());
    for (const name of ['audit_tracking', 'audit_performance', 'audit_full']) {
      const res = await tool(name).handler({ url: 'https://example.com/', format: 'markdown' });
      expect(res.isError).toBeUndefined();
    }
  });

  it('maps fetch AppErrors and unexpected errors to isError', async () => {
    const { AppError, ErrorCodes } = await import('../../src/errors.js');
    safeFetchMock.mockRejectedValueOnce(new AppError(ErrorCodes.Timeout, 'Request timed out after 15000ms'));
    const timeout = await tool('audit_security').handler({ url: 'https://example.com/', format: 'markdown' });
    expect(text(timeout)).toBe('Security audit failed: TIMEOUT: Request timed out after 15000ms');
    safeFetchMock.mockRejectedValueOnce(new Error('secret internals'));
    const unexpected = await tool('audit_security').handler({ url: 'https://example.com/', format: 'markdown' });
    expect(text(unexpected)).toBe('Security audit failed: InternalError: Unexpected internal error');
  });

  it('enforces the overall deadline (M10)', async () => {
    CONFIG.network.totalTimeoutMs = 50;
    safeFetchMock.mockImplementation(() => new Promise(() => undefined));
    const res = await tool('audit_full').handler({ url: 'https://example.com/', format: 'markdown' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('TIMEOUT');
  });

  it('honours robots.txt when RESPECT_ROBOTS_TXT is enabled', async () => {
    CONFIG.network.respectRobotsTxt = true;
    safeFetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/robots.txt')
        ? fetchResultFixture({ contentType: 'text/plain', body: 'User-agent: *\nDisallow: /private' })
        : fetchResultFixture(),
    );
    const blocked = await tool('audit_seo').handler({ url: 'https://example.com/private/x', format: 'markdown' });
    expect(text(blocked)).toContain('ROBOTS_DISALLOWED');
    const allowed = await tool('audit_seo').handler({ url: 'https://example.com/public', format: 'markdown' });
    expect(allowed.isError).toBeUndefined();
  });

  it('sends progress notifications only when a token is provided', async () => {
    const sendNotification = vi.fn(async () => undefined);
    const withToken = createProgressReporter({ _meta: { progressToken: 7 }, sendNotification } as never, 3);
    await withToken(1, 'step');
    expect(sendNotification).toHaveBeenCalledWith({
      method: 'notifications/progress',
      params: { progressToken: 7, progress: 1, total: 3, message: 'step' },
    });
    const without = createProgressReporter(undefined, 3);
    await without(1, 'x');
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
