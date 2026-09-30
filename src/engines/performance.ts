import { AuditItem, FetchResult, FieldMetrics, PerformanceAuditResult } from '../types.js';
import { penaltyToScore, scoreToRating } from './scoring.js';

interface VitalThreshold {
  key: 'lcpMs' | 'inpMs' | 'cls';
  label: string;
  good: number;
  poor: number;
  format: (v: number) => string;
}

/** Core Web Vitals thresholds (p75) as published on web.dev. */
const CORE_WEB_VITALS: VitalThreshold[] = [
  { key: 'lcpMs', label: 'Largest Contentful Paint (LCP)', good: 2500, poor: 4000, format: (v) => `${Math.round(v)} ms` },
  { key: 'inpMs', label: 'Interaction to Next Paint (INP)', good: 200, poor: 500, format: (v) => `${Math.round(v)} ms` },
  { key: 'cls', label: 'Cumulative Layout Shift (CLS)', good: 0.1, poor: 0.25, format: (v) => v.toFixed(2) },
];

function evaluateTtfb(ttfbMs: number, items: AuditItem[]): number {
  if (ttfbMs <= 300) {
    items.push({
      id: 'perf-ttfb-fast',
      title: 'Fast Time To First Byte (TTFB)',
      status: 'pass',
      description: `Server responded with initial byte in ${ttfbMs}ms (recommended < 300ms, measured from the audit server).`,
    });
    return 0;
  }
  if (ttfbMs <= 800) {
    items.push({
      id: 'perf-ttfb-moderate',
      title: 'Moderate TTFB',
      status: 'warn',
      description: `Server TTFB was ${ttfbMs}ms. Can be improved with edge caching or CDN.`,
      recommendation: 'Use a CDN / edge cache or optimize backend queries.',
    });
    return 10;
  }
  items.push({
    id: 'perf-ttfb-slow',
    title: 'Slow TTFB (> 800ms)',
    status: 'fail',
    description: `Server TTFB was ${ttfbMs}ms. Slow server response degrades user experience.`,
    recommendation: 'Investigate server-side rendering bottlenecks or activate full-page edge caching.',
  });
  return 25;
}

function evaluatePayloadSize(sizeBytes: number, items: AuditItem[]): number {
  const sizeKb = Math.round(sizeBytes / 1024);
  if (sizeKb <= 200) {
    items.push({
      id: 'perf-size-optimal',
      title: 'Lightweight HTML Payload',
      status: 'pass',
      description: `Decompressed HTML document size is ${sizeKb} KB (recommended < 200 KB).`,
    });
    return 0;
  }
  if (sizeKb <= 1000) {
    items.push({
      id: 'perf-size-moderate',
      title: 'Moderate HTML Payload',
      status: 'warn',
      description: `Decompressed HTML document size is ${sizeKb} KB.`,
      recommendation: 'Minify HTML and extract large inline scripts or styles into separate cached bundles.',
    });
    return 10;
  }
  items.push({
    id: 'perf-size-heavy',
    title: 'Excessive HTML Payload Size',
    status: 'fail',
    description: `Decompressed HTML document is ${sizeKb} KB (> 1 MB). Significant parsing and memory overhead.`,
    recommendation: 'Remove redundant inline JSON payloads, paginate content, or implement code-splitting.',
  });
  return 20;
}

function evaluateCompressionAndCache(headers: Record<string, string>, items: AuditItem[]): number {
  let penalty = 0;
  const encoding = headers['content-encoding']?.toLowerCase();
  if (!encoding || !/(gzip|br|zstd|deflate)/.test(encoding)) {
    penalty += 15;
    items.push({
      id: 'perf-compression-missing',
      title: 'Text Compression Disabled',
      status: 'fail',
      description: 'Response is not compressed using Gzip, Brotli, Deflate or Zstandard.',
      recommendation: 'Enable Brotli or Gzip compression on your web server / CDN.',
    });
  } else {
    items.push({
      id: 'perf-compression-ok',
      title: 'Text Compression Active',
      status: 'pass',
      description: `Compression enabled (${encoding}).`,
    });
  }

  const cacheControl = headers['cache-control'];
  if (!cacheControl) {
    penalty += 10;
    items.push({
      id: 'perf-cache-missing',
      title: 'Missing Cache-Control Header',
      status: 'warn',
      description: 'No Cache-Control header specified.',
      recommendation: 'Configure appropriate Cache-Control headers for dynamic and static assets.',
    });
  } else {
    items.push({
      id: 'perf-cache-ok',
      title: 'Cache-Control Header Present',
      status: 'pass',
      description: `Cache-Control: ${cacheControl}`,
    });
  }
  return penalty;
}

function evaluateFieldData(field: FieldMetrics, items: AuditItem[]): number {
  let penalty = 0;
  const scopeLabel = field.scope === 'origin' ? 'origin-level' : 'URL-level';
  for (const vital of CORE_WEB_VITALS) {
    const value = field[vital.key];
    if (value === undefined) continue;
    const rating = value <= vital.good ? 'good' : value <= vital.poor ? 'needs-improvement' : 'poor';
    penalty += rating === 'good' ? 0 : rating === 'poor' ? 15 : 5;
    items.push({
      id: `crux-${vital.key}`,
      title: `CrUX ${vital.label}`,
      status: rating === 'good' ? 'pass' : rating === 'poor' ? 'fail' : 'warn',
      description: `p75 ${vital.format(value)} (${rating}, ${scopeLabel} phone field data; good ≤ ${vital.format(vital.good)}).`,
    });
  }
  return penalty;
}

/**
 * Synthetic HTTP performance audit (TTFB, payload size, compression, caching)
 * optionally enriched with Chrome UX Report field data.
 * @param fetchResult Network response data
 * @param fieldData Optional CrUX p75 metrics
 * @returns PerformanceAuditResult
 */
export function auditPerformance(fetchResult: FetchResult, fieldData?: FieldMetrics | null): PerformanceAuditResult {
  const items: AuditItem[] = [];
  const payloadSize = Buffer.byteLength(fetchResult.body, 'utf8');
  let penalty = evaluateTtfb(fetchResult.timing.ttfbMs, items);
  penalty += evaluatePayloadSize(payloadSize, items);
  penalty += evaluateCompressionAndCache(fetchResult.headers, items);
  if (fieldData) penalty += evaluateFieldData(fieldData, items);

  const score = penaltyToScore(penalty);
  return {
    url: fetchResult.finalUrl,
    timestamp: new Date().toISOString(),
    score,
    rating: scoreToRating(score),
    items,
    engine: 'synthetic',
    timing: fetchResult.timing,
    payloadSize,
    compression: fetchResult.headers['content-encoding'],
    cacheControl: fetchResult.headers['cache-control'],
    fieldData: fieldData ?? undefined,
  };
}
