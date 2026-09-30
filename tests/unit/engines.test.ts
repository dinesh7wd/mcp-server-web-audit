import { describe, expect, it } from 'vitest';
import { auditA11y } from '../../src/engines/a11y-checks.js';
import { auditPerformance } from '../../src/engines/performance.js';
import { slug } from '../../src/engines/scoring.js';
import { auditSecurity, parseCsp, parseHsts } from '../../src/engines/security-checks.js';
import { auditSeo, parseRobotsDirectives } from '../../src/engines/seo-checks.js';
import { auditTracking } from '../../src/engines/tracking-checks.js';
import { ParsedCookie, parseHtml } from '../../src/parsers.js';
import { fetchResultFixture } from '../helpers.js';

const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

const strongHeaders = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=()',
};

describe('auditSecurity', () => {
  it('rates a strong configuration at 100', () => {
    const cookies: ParsedCookie[] = [{ name: 'sess', secure: true, httpOnly: true, sameSite: 'lax' }];
    const res = auditSecurity(strongHeaders, cookies, 'https://example.com/');
    expect(res.score).toBe(100);
    expect(res.rating).toBe('good');
    expect(res.hstsMaxAge).toBe(31536000);
  });

  it('penalizes plain HTTP and missing headers', () => {
    const res = auditSecurity({}, [{ name: 'token', secure: false, httpOnly: false }], 'http://example.com/');
    expect(res.score).toBeLessThan(50);
    expect(res.isHttps).toBe(false);
  });

  it('parses HSTS and fails max-age=0 or missing max-age (M4)', () => {
    expect(parseHsts('max-age="600"; includeSubDomains')).toEqual({ maxAge: 600, includeSubDomains: true, preload: false });
    const zero = auditSecurity({ ...strongHeaders, 'strict-transport-security': 'max-age=0' }, [], 'https://a.test/');
    expect(ids(zero.items)).toContain('sec-hsts-disabled');
    const invalid = auditSecurity({ ...strongHeaders, 'strict-transport-security': 'includeSubDomains' }, [], 'https://a.test/');
    expect(ids(invalid.items)).toContain('sec-hsts-invalid');
    const short = auditSecurity({ ...strongHeaders, 'strict-transport-security': 'max-age=86400' }, [], 'https://a.test/');
    expect(ids(short.items)).toContain('sec-hsts-short');
    expect(short.score).toBe(92);
  });

  it('evaluates CSP sources, report-only and frame-ancestors by directive (M5)', () => {
    expect(parseCsp("default-src 'self'; script-src 'self' 'unsafe-inline', img-src *")).toHaveLength(2);

    const unsafe = auditSecurity(
      { ...strongHeaders, 'content-security-policy': "script-src 'unsafe-inline' 'unsafe-eval' https:; base-uri 'none'" },
      [],
      'https://a.test/',
    );
    const item = unsafe.items.find((i) => i.id === 'sec-csp-unsafe-sources');
    expect(item?.description).toContain("'unsafe-inline'");
    expect(item?.description).toContain('https:');
    expect(ids(unsafe.items)).toContain('sec-clickjacking-risk');

    const nonce = auditSecurity(
      { ...strongHeaders, 'content-security-policy': "script-src 'nonce-abc' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" },
      [],
      'https://a.test/',
    );
    expect(ids(nonce.items)).toContain('sec-csp-scripts-ok');

    const noScriptSrc = auditSecurity({ ...strongHeaders, 'content-security-policy': 'upgrade-insecure-requests' }, [], 'https://a.test/');
    expect(ids(noScriptSrc.items)).toContain('sec-csp-no-script-src');

    const headersNoCsp: Record<string, string> = { ...strongHeaders };
    delete headersNoCsp['content-security-policy'];
    const reportOnly = auditSecurity(
      { ...headersNoCsp, 'content-security-policy-report-only': "default-src 'self'", 'x-frame-options': 'DENY' },
      [],
      'https://a.test/',
    );
    expect(ids(reportOnly.items)).toContain('sec-csp-report-only');
    expect(reportOnly.score).toBe(88);

    const substring = auditSecurity(
      { ...strongHeaders, 'content-security-policy': "default-src 'self'; report-uri /frame-ancestors-report" },
      [],
      'https://a.test/',
    );
    expect(ids(substring.items)).toContain('sec-clickjacking-risk');
  });

  it('treats X-Frame-Options ALLOW-FROM as unprotected and nosniff case-insensitively', () => {
    const base = { ...strongHeaders, 'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'self'" };
    expect(ids(auditSecurity({ ...base, 'x-frame-options': 'ALLOW-FROM https://x.test' }, [], 'https://a.test/').items)).toContain(
      'sec-clickjacking-risk',
    );
    expect(ids(auditSecurity({ ...base, 'x-frame-options': 'sameorigin' }, [], 'https://a.test/').items)).toContain(
      'sec-clickjacking-ok',
    );
    expect(ids(auditSecurity({ ...base, 'x-content-type-options': 'NoSniff' }, [], 'https://a.test/').items)).toContain('sec-xcto-ok');
    expect(ids(auditSecurity({ ...base, 'referrer-policy': 'unsafe-url' }, [], 'https://a.test/').items)).toContain(
      'sec-referrer-unsafe',
    );
  });

  it('caps cookie penalties and flags SameSite=None without Secure (M6)', () => {
    const many: ParsedCookie[] = Array.from({ length: 40 }, (_, i) => ({ name: `c${i}"<x>`, secure: false, httpOnly: false }));
    const res = auditSecurity(strongHeaders, many, 'https://a.test/');
    expect(res.score).toBe(84);
    expect(res.items.filter((i) => i.id.startsWith('sec-cookie')).length).toBeLessThanOrEqual(4);
    expect(res.items.find((i) => i.id === 'sec-cookie-missing-secure')?.description).toContain('(+20 more)');

    const none = auditSecurity(strongHeaders, [{ name: 'x', secure: false, httpOnly: true, sameSite: 'none' }], 'https://a.test/');
    expect(ids(none.items)).toContain('sec-cookie-samesite-none-insecure');
  });
});

describe('auditSeo', () => {
  const goodHead = `
    <title>Optimal Website Title Tag Length Example</title>
    <meta name="description" content="This is an optimal description that conveys relevant information to search engine users.">
    <meta property="og:title" content="Optimal Title">
    <meta property="og:image" content="https://example.com/image.png">
    <meta name="twitter:card" content="summary">`;

  it('awards a perfect score for well-optimized markup with a relative self canonical', () => {
    const parsed = parseHtml(`<html lang="en"><head>${goodHead}<link rel="canonical" href="/"></head><body><h1>Heading</h1></body></html>`);
    const res = auditSeo(parsed, 'https://example.com/');
    expect(res.score).toBe(100);
    expect(res.canonicalMatches).toBe(true);
    expect(res.canonicalResolved).toBe('https://example.com/');
    expect(res.indexable).toBe(true);
  });

  it('penalizes missing title, description, and h1', () => {
    const res = auditSeo(parseHtml('<html><body><p>No meta tags</p></body></html>'), 'https://example.com/');
    expect(res.score).toBeLessThan(60);
  });

  it('flags noindex/nofollow from meta robots and X-Robots-Tag (M7)', () => {
    const parsed = parseHtml(`<html lang="en"><head>${goodHead}<link rel="canonical" href="https://example.com/"></head><body><h1>x</h1></body></html>`);
    const viaHeader = auditSeo(parsed, 'https://example.com/', { 'x-robots-tag': 'googlebot: noindex, nofollow' });
    expect(viaHeader.indexable).toBe(false);
    expect(ids(viaHeader.items)).toEqual(expect.arrayContaining(['seo-noindex', 'seo-nofollow']));
    const viaMeta = auditSeo(parseHtml(`<meta name="robots" content="none">`), 'https://example.com/');
    expect(viaMeta.indexable).toBe(false);
    expect(parseRobotsDirectives(['max-snippet:50, NOINDEX'])).toEqual(new Set(['max-snippet:50', 'noindex']));
  });

  it('reports canonical mismatch, conflicts and invalid values', () => {
    const mismatch = auditSeo(parseHtml('<link rel="canonical" href="https://other.test/page">'), 'https://example.com/');
    expect(mismatch.canonicalMatches).toBe(false);
    expect(ids(mismatch.items)).toContain('seo-canonical-mismatch');
    const multiple = auditSeo(
      parseHtml('<link rel="canonical" href="/a"><link rel="Canonical" href="/b">'),
      'https://example.com/a',
    );
    expect(ids(multiple.items)).toContain('seo-canonical-multiple');
    const invalid = auditSeo(parseHtml('<link rel="canonical" href="http://[bad">'), 'https://example.com/');
    expect(ids(invalid.items)).toContain('seo-canonical-invalid');
  });

  it('uses consistent title and description thresholds (L6)', () => {
    const short = auditSeo(parseHtml('<title>Too short title</title><meta name="description" content="short">'), 'https://e.test/');
    const titleItem = short.items.find((i) => i.id === 'seo-title-length');
    expect(titleItem?.description).toContain('30-60');
    expect(short.items.find((i) => i.id === 'seo-desc-length')?.description).toContain('70-160');
  });

  it('validates hreflang codes', () => {
    const bad = auditSeo(parseHtml('<link rel="alternate" hreflang="english" href="/en">'), 'https://e.test/');
    expect(ids(bad.items)).toContain('seo-hreflang-invalid');
    const good = auditSeo(parseHtml('<link rel="alternate" hreflang="en-GB" href="/en"><link rel="alternate" hreflang="x-default" href="/">'), 'https://e.test/');
    expect(ids(good.items)).toContain('seo-hreflang-ok');
  });
});

describe('auditA11y', () => {
  it('audits images, inputs, landmarks and every heading skip (L5)', () => {
    const html = `
      <html lang="en"><body><main>
        <h1>Title</h1><h3>Skip one</h3><h2>Back</h2><h5>Skip two</h5>
        <img src="test.jpg"><img src="deco.gif" aria-hidden="true">
        <input type="text">
      </main></body></html>`;
    const res = auditA11y(parseHtml(html), 'https://example.com/');
    expect(res.imagesWithoutAlt).toBe(1);
    expect(res.formInputsWithoutLabel).toBe(1);
    expect(res.hasMainLandmark).toBe(true);
    expect(res.hasNavLandmark).toBe(false);
    expect(res.headingSkips).toBe(2);
    expect(res.headingOrderValid).toBe(false);
    expect(ids(res.items)).toEqual(expect.arrayContaining(['a11y-nav-missing', 'a11y-heading-order-skipped']));
  });

  it('passes a clean page', () => {
    const html = `<html lang="en"><body><nav></nav><main><h1>T</h1><h2>S</h2><img alt="x" src="a"><label>Q <input></label></main></body></html>`;
    const res = auditA11y(parseHtml(html), 'https://example.com/');
    expect(res.score).toBe(100);
  });

  it('penalizes missing main and lang', () => {
    const res = auditA11y(parseHtml('<html><body><p>x</p></body></html>'), 'https://example.com/');
    expect(ids(res.items)).toEqual(expect.arrayContaining(['a11y-main-missing', 'a11y-lang-missing']));
  });
});

describe('auditTracking', () => {
  it('detects GA4 and flags genuinely different IDs', () => {
    const html = `
      <script src="https://www.googletagmanager.com/gtag/js?id=G-111111111"></script>
      <script>gtag('config', 'G-111111111'); gtag('config', 'G-222222222', { send_page_view: false });</script>`;
    const res = auditTracking(parseHtml(html), 'https://example.com/');
    const ga4 = res.detectedTrackers.find((t) => t.name.includes('GA4'));
    expect(ga4?.identifiers).toEqual(['G-111111111', 'G-222222222']);
    expect(res.duplicateTrackers).toContain('Google Analytics 4 (GA4)');
  });

  it('does not treat CSS classes or reCAPTCHA as GA4 IDs (H6 regression)', () => {
    const html = `<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
      <script>gtag('config','G-ABC123'); var c = "img-fluid"; grecaptcha.render('x', { class: 'g-recaptcha' }); var tag = "GTM-lowercase";</script>`;
    const res = auditTracking(parseHtml(html), 'https://x.test');
    expect(res.detectedTrackers.map((t) => t.name)).toEqual(['Google Analytics 4 (GA4)']);
    expect(res.detectedTrackers[0].identifiers).toEqual(['G-ABC123']);
    expect(res.duplicateTrackers).toEqual([]);
    expect(res.score).toBe(100);
  });

  it('distinguishes Meta Pixel from the Facebook social SDK (L8)', () => {
    const sdkOnly = auditTracking(parseHtml('<script src="https://connect.facebook.net/en_US/sdk.js"></script>'), 'https://x.test');
    expect(sdkOnly.detectedTrackers).toHaveLength(0);
    expect(ids(sdkOnly.items)).toContain('tracking-none');

    const pixel = auditTracking(
      parseHtml(`<script>!function(f){}(window,'https://connect.facebook.net/en_US/fbevents.js'); fbq('init', '123456789012345');</script>
        <script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABCD12');</script>`),
      'https://x.test',
    );
    expect(pixel.detectedTrackers.map((t) => [t.name, t.identifiers])).toEqual([
      ['Google Tag Manager (GTM)', ['GTM-ABCD12']],
      ['Meta / Facebook Pixel', ['123456789012345']],
    ]);
  });

  it('slugs tracker names for item ids', () => {
    expect(slug('Meta / Facebook Pixel')).toBe('meta-facebook-pixel');
  });
});

describe('auditPerformance', () => {
  it('scores synthetic metrics and reports decompressed bytes', () => {
    const res = auditPerformance(
      fetchResultFixture({
        headers: { 'content-encoding': 'gzip', 'cache-control': 'public, max-age=3600' },
        body: 'é'.repeat(10),
        timing: { ttfbMs: 120, downloadMs: 50, totalMs: 170 },
      }),
    );
    expect(res.score).toBe(100);
    expect(res.payloadSize).toBe(20);
    expect(res.engine).toBe('synthetic');
  });

  it('penalizes slow, heavy, uncompressed responses', () => {
    const moderate = auditPerformance(fetchResultFixture({ headers: {}, body: 'x'.repeat(300 * 1024), timing: { ttfbMs: 500, downloadMs: 1, totalMs: 501 } }));
    expect(ids(moderate.items)).toEqual(expect.arrayContaining(['perf-ttfb-moderate', 'perf-size-moderate', 'perf-compression-missing', 'perf-cache-missing']));
    const heavy = auditPerformance(fetchResultFixture({ headers: {}, body: 'x'.repeat(1100 * 1024), timing: { ttfbMs: 900, downloadMs: 1, totalMs: 901 } }));
    expect(ids(heavy.items)).toEqual(expect.arrayContaining(['perf-ttfb-slow', 'perf-size-heavy']));
  });

  it('rates CrUX field data against Core Web Vitals thresholds', () => {
    const res = auditPerformance(
      fetchResultFixture({ headers: { 'content-encoding': 'br', 'cache-control': 'no-cache' } }),
      { scope: 'origin', lcpMs: 5000, inpMs: 300, cls: 0.05 },
    );
    const statuses = Object.fromEntries(res.items.filter((i) => i.id.startsWith('crux-')).map((i) => [i.id, i.status]));
    expect(statuses).toEqual({ 'crux-lcpMs': 'fail', 'crux-inpMs': 'warn', 'crux-cls': 'pass' });
    expect(res.score).toBe(80);
    expect(res.fieldData?.scope).toBe('origin');
  });
});
