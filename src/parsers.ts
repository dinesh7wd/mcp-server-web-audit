import * as cheerio from 'cheerio';

export interface ParsedImage {
  src?: string;
  alt?: string;
  hasAlt: boolean;
  decorative: boolean;
}

export interface ParsedScript {
  src?: string;
  inline?: string;
  /** External script without async, defer or type="module" (blocks HTML parsing). */
  blocking?: boolean;
}

export interface ParsedFormInput {
  type?: string;
  id?: string;
  name?: string;
  hasLabel: boolean;
}

export interface ParsedHtml {
  title?: string;
  description?: string;
  canonical?: string;
  canonicals: string[];
  robots?: string;
  language?: string;
  h1List: string[];
  allHeadings: Array<{ level: number; text: string }>;
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
  hreflang: Array<{ lang: string; href: string }>;
  scripts: ParsedScript[];
  images: ParsedImage[];
  formInputs: ParsedFormInput[];
  landmarks: {
    hasMain: boolean;
    hasNav: boolean;
    hasHeader: boolean;
    hasFooter: boolean;
  };
}

export interface ParsedCookie {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

const NON_LABELLED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * Collects meta tags keyed by lower-cased `name`/`property`.
 * @param $ CheerioAPI instance
 * @returns Map of meta key to list of contents
 */
function collectMeta($: cheerio.CheerioAPI): Map<string, string[]> {
  const meta = new Map<string, string[]>();
  $('meta').each((_, el) => {
    const key = (trimmed($(el).attr('property')) || trimmed($(el).attr('name')))?.toLowerCase();
    const content = trimmed($(el).attr('content'));
    if (!key || !content) return;
    meta.set(key, [...(meta.get(key) ?? []), content]);
  });
  return meta;
}

function metaWithPrefix(meta: Map<string, string[]>, prefix: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, values] of meta) {
    if (key.startsWith(prefix)) result[key] = values[0];
  }
  return result;
}

function extractHeadings($: cheerio.CheerioAPI): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const level = parseInt(el.tagName.toLowerCase().replace('h', ''), 10);
    headings.push({ level, text: $(el).text().trim() });
  });
  return headings;
}

/**
 * Extracts form controls and resolves accessible labels without building
 * selectors from page-controlled strings.
 * @param $ CheerioAPI instance
 * @returns Form inputs metadata
 */
function extractFormInputs($: cheerio.CheerioAPI): ParsedFormInput[] {
  const labelTargets = new Set<string>();
  $('label[for]').each((_, el) => {
    const target = $(el).attr('for');
    if (target) labelTargets.add(target);
  });
  const idsWithText = new Set<string>();
  $('[id]').each((_, el) => {
    const id = $(el).attr('id');
    if (id && $(el).text().trim()) idsWithText.add(id);
  });

  const inputs: ParsedFormInput[] = [];
  $('input, select, textarea').each((_, el) => {
    const type = (trimmed($(el).attr('type')) || 'text').toLowerCase();
    if (NON_LABELLED_INPUT_TYPES.has(type)) return;
    const id = $(el).attr('id');
    const labelledBy = ($(el).attr('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const hasLabel = Boolean(
      trimmed($(el).attr('aria-label')) ||
        labelledBy.some((ref) => idsWithText.has(ref)) ||
        trimmed($(el).attr('title')) ||
        $(el).closest('label').length > 0 ||
        (id && labelTargets.has(id)),
    );
    inputs.push({ type, id, name: $(el).attr('name'), hasLabel });
  });
  return inputs;
}

function extractImages($: cheerio.CheerioAPI): ParsedImage[] {
  const images: ParsedImage[] = [];
  $('img').each((_, el) => {
    const alt = $(el).attr('alt');
    const role = (trimmed($(el).attr('role')) || '').toLowerCase();
    const decorative = role === 'presentation' || role === 'none' || trimmed($(el).attr('aria-hidden')) === 'true';
    images.push({ src: $(el).attr('src'), alt, hasAlt: typeof alt === 'string', decorative });
  });
  return images;
}

function extractScripts($: cheerio.CheerioAPI): ParsedScript[] {
  const scripts: ParsedScript[] = [];
  $('script').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    const isModule = ($el.attr('type') || '').trim().toLowerCase() === 'module';
    const blocking = Boolean(src) && $el.attr('async') === undefined && $el.attr('defer') === undefined && !isModule;
    scripts.push({ src, inline: $el.html() || undefined, blocking });
  });
  return scripts;
}

function linksWithRel($: cheerio.CheerioAPI, rel: string): Array<{ href?: string; hreflang?: string }> {
  const links: Array<{ href?: string; hreflang?: string }> = [];
  $('link[rel]').each((_, el) => {
    const rels = ($(el).attr('rel') || '').toLowerCase().split(/\s+/);
    if (rels.includes(rel)) {
      links.push({ href: trimmed($(el).attr('href')), hreflang: trimmed($(el).attr('hreflang')) });
    }
  });
  return links;
}

/**
 * Parses raw HTML string and extracts structured DOM data.
 * @param html Raw HTML content
 * @returns ParsedHtml structure
 */
export function parseHtml(html: string): ParsedHtml {
  const $ = cheerio.load(html);
  const meta = collectMeta($);

  const title = $('head > title').first().text().trim() || $('title').first().text().trim() || undefined;
  const canonicals = linksWithRel($, 'canonical')
    .map((l) => l.href)
    .filter((href): href is string => Boolean(href));
  const hreflang = linksWithRel($, 'alternate')
    .filter((l) => l.hreflang && l.href)
    .map((l) => ({ lang: l.hreflang as string, href: l.href as string }));
  const robotsValues = [...(meta.get('robots') ?? []), ...(meta.get('googlebot') ?? [])];

  const h1List: string[] = [];
  $('h1').each((_, el) => {
    const text = $(el).text().trim();
    if (text) h1List.push(text);
  });

  return {
    title,
    description: meta.get('description')?.[0],
    canonical: canonicals[0],
    canonicals,
    robots: robotsValues.length > 0 ? robotsValues.join(', ') : undefined,
    language: trimmed($('html').attr('lang')),
    h1List,
    allHeadings: extractHeadings($),
    openGraph: metaWithPrefix(meta, 'og:'),
    twitterCard: metaWithPrefix(meta, 'twitter:'),
    hreflang,
    scripts: extractScripts($),
    images: extractImages($),
    formInputs: extractFormInputs($),
    landmarks: {
      hasMain: $('main, [role="main"]').length > 0,
      hasNav: $('nav, [role="navigation"]').length > 0,
      hasHeader: $('header, [role="banner"]').length > 0,
      hasFooter: $('footer, [role="contentinfo"]').length > 0,
    },
  };
}

/**
 * Parses Set-Cookie header values into structured cookie attributes.
 * @param setCookies Raw Set-Cookie header values
 * @returns Array of ParsedCookie
 */
export function parseCookies(setCookies: string[]): ParsedCookie[] {
  const cookies: ParsedCookie[] = [];
  for (const cookieStr of setCookies) {
    const parts = cookieStr.split(';').map((p) => p.trim());
    if (!parts[0]) continue;
    const eqIdx = parts[0].indexOf('=');
    const name = (eqIdx > -1 ? parts[0].substring(0, eqIdx) : parts[0]).trim();
    const attributes = parts.slice(1).map((p) => {
      const idx = p.indexOf('=');
      const key = (idx > -1 ? p.slice(0, idx) : p).trim().toLowerCase();
      const value = idx > -1 ? p.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase() : '';
      return { key, value };
    });
    const has = (key: string) => attributes.some((a) => a.key === key);
    const sameSite = attributes.find((a) => a.key === 'samesite')?.value;
    cookies.push({
      name,
      secure: has('secure'),
      httpOnly: has('httponly'),
      sameSite: sameSite || undefined,
    });
  }
  return cookies;
}
