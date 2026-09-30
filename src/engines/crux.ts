import { fetch as undiciFetch } from 'undici';
import { CONFIG } from '../config.js';
import { logDebug, logWarn, redactUrl } from '../logger.js';
import { FieldMetrics } from '../types.js';

const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

type CruxFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface CruxOptions {
  apiKey?: string;
  signal?: AbortSignal;
  fetchImpl?: CruxFetch;
  timeoutMs?: number;
}

interface CruxRecordResponse {
  record?: {
    metrics?: Record<string, { percentiles?: { p75?: number | string } }>;
  };
}

/**
 * Converts a CrUX percentile (numbers, or strings for CLS) into a number.
 * @param value Raw percentile value
 * @returns number or undefined
 */
export function toMetricNumber(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function queryRecord(
  body: Record<string, string>,
  options: Required<Pick<CruxOptions, 'apiKey' | 'fetchImpl' | 'timeoutMs'>> & { signal?: AbortSignal },
): Promise<CruxRecordResponse | 'not-found' | null> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const res = await options.fetchImpl(CRUX_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': options.apiKey },
    body: JSON.stringify({ ...body, formFactor: 'PHONE' }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (res.status === 404) return 'not-found';
  if (!res.ok) {
    logWarn('CrUX API returned non-OK status', { status: res.status });
    return null;
  }
  return (await res.json()) as CruxRecordResponse;
}

/**
 * Fetch p75 field metrics (phone) from the Chrome UX Report API.
 * Tries the exact URL first, then falls back to origin-level data on 404.
 * Returns null when no API key is configured, no data exists, or the call fails.
 */
export async function fetchCruxMetrics(pageUrl: string, options: CruxOptions = {}): Promise<FieldMetrics | null> {
  const apiKey = options.apiKey ?? CONFIG.cruxApiKey;
  if (!apiKey) return null;
  const request = {
    apiKey,
    fetchImpl: options.fetchImpl ?? (undiciFetch as unknown as CruxFetch),
    timeoutMs: options.timeoutMs ?? CONFIG.network.defaultTimeoutMs,
    signal: options.signal,
  };

  try {
    let scope: FieldMetrics['scope'] = 'url';
    let data = await queryRecord({ url: pageUrl }, request);
    if (data === 'not-found') {
      scope = 'origin';
      data = await queryRecord({ origin: new URL(pageUrl).origin }, request);
    }
    if (data === null || data === 'not-found') return null;

    const metrics = data.record?.metrics;
    if (!metrics) return null;
    logDebug('CrUX metrics loaded', { url: redactUrl(pageUrl), scope });
    return {
      scope,
      lcpMs: toMetricNumber(metrics.largest_contentful_paint?.percentiles?.p75),
      inpMs: toMetricNumber(metrics.interaction_to_next_paint?.percentiles?.p75),
      cls: toMetricNumber(metrics.cumulative_layout_shift?.percentiles?.p75),
      fcpMs: toMetricNumber(metrics.first_contentful_paint?.percentiles?.p75),
      ttfbMs: toMetricNumber(metrics.experimental_time_to_first_byte?.percentiles?.p75),
    };
  } catch (err) {
    logWarn('CrUX fetch failed; continuing with synthetic metrics only', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}
