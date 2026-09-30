import { describe, expect, it } from 'vitest';
import {
  formatA11yMarkdown,
  formatFullMarkdown,
  formatPerformanceMarkdown,
  formatSecurityMarkdown,
  formatSeoMarkdown,
  formatTrackingMarkdown,
  inline,
} from '../../src/formatters.js';
import {
  A11yAuditResult,
  FullAuditResult,
  PerformanceAuditResult,
  SecurityAuditResult,
  SeoAuditResult,
  TrackingAuditResult,
} from '../../src/types.js';

const ts = '2026-09-16T10:00:00.000Z';

const mockSeo: SeoAuditResult = {
  url: 'https://example.com/',
  timestamp: ts,
  score: 95,
  rating: 'good',
  title: 'Example\nDomain `with` ticks',
  titleLength: 14,
  description: 'Example website for testing purposes with a valid description.',
  descriptionLength: 62,
  canonical: '/',
  canonicalResolved: 'https://example.com/',
  canonicalMatches: true,
  indexable: true,
  h1Count: 1,
  h1Content: ['Welcome to Example'],
  openGraph: { 'og:title': 'Example' },
  twitterCard: {},
  hreflangCount: 0,
  language: 'en',
  items: [{ id: 'seo-title-ok', title: 'Optimal Title Tag', status: 'pass', description: 'Title is well-formed' }],
};

const mockSec: SecurityAuditResult = {
  url: 'https://example.com/',
  timestamp: ts,
  score: 90,
  rating: 'good',
  isHttps: true,
  hstsHeader: 'max-age=31536000',
  hstsMaxAge: 31536000,
  cspReportOnlyHeader: "default-src 'self'",
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  cookieFlags: [],
  items: [{ id: 'sec-https-ok', title: 'HTTPS Enabled', status: 'pass', description: 'Connection encrypted', recommendation: 'Keep it' }],
};

const mockTracking: TrackingAuditResult = {
  url: 'https://example.com/',
  timestamp: ts,
  score: 100,
  rating: 'good',
  detectedTrackers: [{ name: 'Google Analytics 4', category: 'analytics', identifiers: ['G-12345'] }],
  duplicateTrackers: [],
  items: [{ id: 'tracking-found', title: 'GA4 Detected', status: 'info', description: 'Active tracker found' }],
};

const mockA11y: A11yAuditResult = {
  url: 'https://example.com/',
  timestamp: ts,
  score: 85,
  rating: 'good',
  totalImages: 4,
  imagesWithoutAlt: 0,
  formInputsTotal: 2,
  formInputsWithoutLabel: 0,
  hasMainLandmark: true,
  hasNavLandmark: false,
  headingOrderValid: false,
  headingSkips: 2,
  languageDeclared: true,
  items: [{ id: 'a11y-img-alt-ok', title: 'All Images Have Alt', status: 'warn', description: 'Good alt tags' }],
};

const mockPerf: PerformanceAuditResult = {
  url: 'https://example.com/',
  timestamp: ts,
  score: 90,
  rating: 'good',
  engine: 'synthetic',
  timing: { ttfbMs: 150, downloadMs: 40, totalMs: 190 },
  payloadSize: 12000,
  compression: 'gzip',
  cacheControl: 'max-age=3600',
  fieldData: { scope: 'url', lcpMs: 2000, inpMs: 100, cls: 0.05, fcpMs: 900, ttfbMs: 300 },
  items: [{ id: 'perf-ttfb-fast', title: 'Fast TTFB', status: 'fail', description: '150ms response' }],
};

describe('formatters', () => {
  it('formats SEO markdown with sanitized page-controlled text', () => {
    const md = formatSeoMarkdown(mockSeo);
    expect(md).toContain('# 🔍 SEO Audit Report');
    expect(md).toContain('**Score**: **95 / 100**');
    expect(md).toContain('"Example Domain \'with\' ticks"');
    expect(md).toContain('**Canonical**: https://example.com/');
    expect(md).toContain('🟢 PASS');
  });

  it('formats Security markdown with header overview', () => {
    const md = formatSecurityMarkdown(mockSec);
    expect(md).toContain('**HTTPS**: ✅ Enabled');
    expect(md).toContain('**CSP**: ⚠️ Report-Only');
    expect(md).toContain('*Recommendation*: Keep it');
  });

  it('formats Tracking markdown with tracker names', () => {
    expect(formatTrackingMarkdown(mockTracking)).toContain('Google Analytics 4');
    expect(formatTrackingMarkdown({ ...mockTracking, detectedTrackers: [] })).toContain('No common analytics');
  });

  it('formats Accessibility markdown with summary metrics', () => {
    const md = formatA11yMarkdown(mockA11y);
    expect(md).toContain('**Images Without Alt**: 0 / 4');
    expect(md).toContain('2 skip(s) detected');
    expect(md).toContain('🟡 WARN');
  });

  it('formats Performance markdown with network timings and CrUX data', () => {
    const md = formatPerformanceMarkdown(mockPerf);
    expect(md).toContain('150 ms');
    expect(md).toContain('CrUX p75, phone, url-level');
    expect(md).toContain('**CLS**: 0.05');
    expect(md).toContain('🔴 FAIL');
  });

  it('formats full and partial results', () => {
    const full: FullAuditResult = {
      url: 'https://example.com/',
      timestamp: ts,
      overallScore: 92,
      overallRating: 'good',
      seo: mockSeo,
      security: mockSec,
      tracking: mockTracking,
      accessibility: mockA11y,
      performance: mockPerf,
      errors: {},
    };
    const md = formatFullMarkdown(full);
    expect(md).toContain('| Category | Score | Rating |');
    expect(md).toContain('92 / 100');
    expect(md).not.toContain('Partial Result');

    const partial = formatFullMarkdown({ ...full, seo: undefined, errors: { seo: 'NOT_HTML: nope' } });
    expect(partial).toContain('## ⚠️ Partial Result');
    expect(partial).toContain('| 🔍 **SEO** | n/a | ERROR |');
  });

  it('truncates long inline text', () => {
    expect(inline('a'.repeat(300))).toHaveLength(200);
    expect(inline('  x \n y ')).toBe('x y');
  });
});
