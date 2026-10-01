import { describe, expect, it } from 'vitest';
import { parseCookies, parseHtml } from '../../src/parsers.js';

describe('parsers', () => {
  describe('parseHtml', () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <title>Test Page Title for SEO</title>
          <meta name="Description" content="This is a test description for SEO testing purposes that meets recommended length.">
          <link rel="canonical" href="https://example.com/test">
          <link rel="alternate" hreflang="de" href="https://example.com/de/test">
          <meta name="robots" content="index, follow">
          <meta property="og:title" content="OpenGraph Title">
          <meta property="og:image" content="https://example.com/og.png">
          <meta name="twitter:card" content="summary_large_image">
          <script src="https://www.googletagmanager.com/gtag/js?id=G-12345XYZ"></script>
          <script>gtag('config', 'G-12345XYZ');</script>
        </head>
        <body>
          <header>
            <nav><a href="/">Home</a></nav>
          </header>
          <main>
            <svg><title>icon</title></svg>
            <h1>Main Page Subject Heading</h1>
            <h2>Subsection 1</h2>
            <img src="/logo.png" alt="Company Logo">
            <img src="/banner.png">
            <img src="/spacer.gif" role="presentation">
            <form>
              <label for="username">Username</label>
              <input id="username" type="text">
              <input type="email" placeholder="No label">
              <span id="lbl">Search</span>
              <input type="search" aria-labelledby="lbl">
              <input type="text" aria-labelledby="missing-id">
              <input type="text" title="Phone number">
              <input type="reset">
            </form>
          </main>
          <footer>Footer info</footer>
        </body>
      </html>
    `;

    it('extracts metadata and tags accurately', () => {
      const parsed = parseHtml(sampleHtml);
      expect(parsed.title).toBe('Test Page Title for SEO');
      expect(parsed.description).toContain('This is a test description');
      expect(parsed.canonical).toBe('https://example.com/test');
      expect(parsed.canonicals).toHaveLength(1);
      expect(parsed.hreflang).toEqual([{ lang: 'de', href: 'https://example.com/de/test' }]);
      expect(parsed.robots).toBe('index, follow');
      expect(parsed.language).toBe('en');
      expect(parsed.h1List).toEqual(['Main Page Subject Heading']);
      expect(parsed.openGraph['og:title']).toBe('OpenGraph Title');
      expect(parsed.twitterCard['twitter:card']).toBe('summary_large_image');
      expect(parsed.scripts).toHaveLength(2);
    });

    it('identifies landmarks', () => {
      const parsed = parseHtml(sampleHtml);
      expect(parsed.landmarks).toEqual({ hasMain: true, hasNav: true, hasHeader: true, hasFooter: true });
    });

    it('detects images with and without alt attributes, excluding decorative ones', () => {
      const parsed = parseHtml(sampleHtml);
      expect(parsed.images.map((i) => [i.hasAlt, i.decorative])).toEqual([
        [true, false],
        [false, false],
        [false, true],
      ]);
    });

    it('resolves labels via for, aria-labelledby (existing targets only) and title', () => {
      const parsed = parseHtml(sampleHtml);
      expect(parsed.formInputs.map((i) => i.hasLabel)).toEqual([true, false, true, false, true]);
    });

    it('does not crash on ids containing quotes or backslashes (H3 regression)', () => {
      const html = `<html><body><label for='a"b'>Name</label><input id='a"b'><input id="c\\d"></body></html>`;
      const parsed = parseHtml(html);
      expect(parsed.formInputs.map((i) => i.hasLabel)).toEqual([true, false]);
    });

    it('merges googlebot directives into robots', () => {
      const parsed = parseHtml('<meta name="robots" content="index"><meta name="GoogleBot" content="noindex">');
      expect(parsed.robots).toBe('index, noindex');
    });
  });

  describe('parseCookies', () => {
    it('correctly parses cookie flags from Set-Cookie values', () => {
      const cookies = parseCookies([
        'session_id=abc12345; Secure; HttpOnly; SameSite=Strict; Path=/',
        'plain=1',
        '',
      ]);
      expect(cookies).toEqual([
        { name: 'session_id', secure: true, httpOnly: true, sameSite: 'strict' },
        { name: 'plain', secure: false, httpOnly: false, sameSite: undefined },
      ]);
    });

    it('tolerates spaces around "=" and quoted attribute values', () => {
      const cookies = parseCookies(['a=1; SameSite = None ; secure', 'b=2; SameSite="Lax"; HttpOnly ']);
      expect(cookies).toEqual([
        { name: 'a', secure: true, httpOnly: false, sameSite: 'none' },
        { name: 'b', secure: false, httpOnly: true, sameSite: 'lax' },
      ]);
    });
  });

  it('marks external scripts without async/defer/module as render-blocking', () => {
    const parsed = parseHtml(`
      <script src="/a.js"></script>
      <script async src="/b.js"></script>
      <script defer src="/c.js"></script>
      <script type="module" src="/d.js"></script>
      <script>inline()</script>`);
    expect(parsed.scripts.map((s) => Boolean(s.blocking))).toEqual([true, false, false, false, false]);
  });
});
