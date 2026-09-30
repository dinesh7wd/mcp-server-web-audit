import { describe, expect, it, vi } from 'vitest';
import { fetchCruxMetrics, toMetricNumber } from '../../src/engines/crux.js';

type Call = { url: string; headers: Record<string, string>; body: Record<string, string> };

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, string> });
    const next = responses.shift() ?? { status: 500 };
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  });
  return { impl, calls };
}

const record = {
  record: {
    metrics: {
      largest_contentful_paint: { percentiles: { p75: 2100 } },
      interaction_to_next_paint: { percentiles: { p75: 150 } },
      cumulative_layout_shift: { percentiles: { p75: '0.07' } },
      first_contentful_paint: { percentiles: { p75: 1200 } },
      experimental_time_to_first_byte: { percentiles: { p75: 400 } },
    },
  },
};

describe('fetchCruxMetrics', () => {
  it('returns null without an API key', async () => {
    expect(await fetchCruxMetrics('https://example.com/', { apiKey: '' })).toBeNull();
  });

  it('sends the key via X-Goog-Api-Key (never in the URL) and parses CLS strings (L7)', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: record }]);
    const res = await fetchCruxMetrics('https://example.com/page', { apiKey: 'secret-key', fetchImpl: impl });
    expect(calls[0].url).not.toContain('secret-key');
    expect(calls[0].headers['X-Goog-Api-Key']).toBe('secret-key');
    expect(calls[0].body).toEqual({ url: 'https://example.com/page', formFactor: 'PHONE' });
    expect(res).toEqual({ scope: 'url', lcpMs: 2100, inpMs: 150, cls: 0.07, fcpMs: 1200, ttfbMs: 400 });
  });

  it('falls back to origin-level data on 404', async () => {
    const { impl, calls } = fakeFetch([{ status: 404 }, { status: 200, body: record }]);
    const res = await fetchCruxMetrics('https://example.com/deep/page?x=1', { apiKey: 'k', fetchImpl: impl });
    expect(calls[1].body).toEqual({ origin: 'https://example.com', formFactor: 'PHONE' });
    expect(res?.scope).toBe('origin');
  });

  it('returns null when no data, on API errors, or on network failure', async () => {
    expect(await fetchCruxMetrics('https://e.test/', { apiKey: 'k', fetchImpl: fakeFetch([{ status: 404 }, { status: 404 }]).impl })).toBeNull();
    expect(await fetchCruxMetrics('https://e.test/', { apiKey: 'k', fetchImpl: fakeFetch([{ status: 403 }]).impl })).toBeNull();
    expect(await fetchCruxMetrics('https://e.test/', { apiKey: 'k', fetchImpl: fakeFetch([{ status: 200, body: {} }]).impl })).toBeNull();
    const failing = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(await fetchCruxMetrics('https://e.test/', { apiKey: 'k', fetchImpl: failing })).toBeNull();
  });

  it('converts percentile values defensively', () => {
    expect(toMetricNumber(undefined)).toBeUndefined();
    expect(toMetricNumber('abc')).toBeUndefined();
    expect(toMetricNumber(3)).toBe(3);
  });
});
