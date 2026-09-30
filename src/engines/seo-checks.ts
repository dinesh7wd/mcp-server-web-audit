import { AuditItem, SeoAuditResult } from '../types.js';
import { ParsedHtml } from '../parsers.js';
import { penaltyToScore, scoreToRating } from './scoring.js';

export const TITLE_MIN = 30;
export const TITLE_MAX = 60;
export const DESCRIPTION_MIN = 70;
export const DESCRIPTION_MAX = 160;

const HREFLANG_PATTERN = /^(x-default|[a-z]{2,3}(-[a-z0-9]{2,8})*)$/i;

/**
 * Extracts robots directives from meta robots and X-Robots-Tag values.
 * Handles user-agent prefixed X-Robots-Tag values (e.g. "googlebot: noindex").
 * @param values Raw directive strings
 * @returns Set of lower-cased directives
 */
export function parseRobotsDirectives(values: Array<string | undefined>): Set<string> {
  const directives = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const raw of value.toLowerCase().split(',')) {
      const token = raw.trim();
      const colon = token.indexOf(':');
      const directive = colon > -1 && !/^(max-|unavailable_after)/.test(token) ? token.slice(colon + 1).trim() : token;
      if (directive) directives.add(directive);
    }
  }
  return directives;
}

function normalizeForCompare(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

function auditTitleAndDescription(parsed: ParsedHtml, items: AuditItem[]): number {
  let penalty = 0;
  const title = parsed.title;
  if (!title) {
    penalty += 25;
    items.push({
      id: 'seo-title-missing',
      title: 'Missing Page Title',
      status: 'fail',
      description: 'The page lacks a <title> tag.',
      recommendation: `Add a descriptive <title> tag between ${TITLE_MIN} and ${TITLE_MAX} characters.`,
    });
  } else if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    penalty += 10;
    items.push({
      id: 'seo-title-length',
      title: 'Suboptimal Title Length',
      status: 'warn',
      description: `Title length is ${title.length} characters. Recommended length is ${TITLE_MIN}-${TITLE_MAX} characters.`,
      recommendation: 'Refine the title length to avoid truncation in search engine result pages (SERPs).',
    });
  } else {
    items.push({
      id: 'seo-title-ok',
      title: 'Optimal Title Tag',
      status: 'pass',
      description: `Title is well-formed (${title.length} characters).`,
    });
  }

  const desc = parsed.description;
  if (!desc) {
    penalty += 20;
    items.push({
      id: 'seo-desc-missing',
      title: 'Missing Meta Description',
      status: 'fail',
      description: 'The page lacks a <meta name="description"> tag.',
      recommendation: `Add a concise meta description between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} characters.`,
    });
  } else if (desc.length < DESCRIPTION_MIN || desc.length > DESCRIPTION_MAX) {
    penalty += 5;
    items.push({
      id: 'seo-desc-length',
      title: 'Suboptimal Description Length',
      status: 'warn',
      description: `Meta description is ${desc.length} characters. Recommended length is ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters.`,
    });
  } else {
    items.push({
      id: 'seo-desc-ok',
      title: 'Optimal Meta Description',
      status: 'pass',
      description: `Meta description is present and well-sized (${desc.length} characters).`,
    });
  }
  return penalty;
}

function auditIndexability(directives: Set<string>, items: AuditItem[]): { penalty: number; indexable: boolean } {
  let penalty = 0;
  const noindex = directives.has('noindex') || directives.has('none');
  const nofollow = directives.has('nofollow') || directives.has('none');
  if (noindex) {
    penalty += 30;
    items.push({
      id: 'seo-noindex',
      title: 'Page Excluded From Search Index',
      status: 'fail',
      description: 'A robots meta tag or X-Robots-Tag header contains "noindex" (or "none").',
      recommendation: 'Remove noindex if this page should appear in search results.',
    });
  }
  if (nofollow) {
    penalty += 5;
    items.push({
      id: 'seo-nofollow',
      title: 'Links Marked nofollow',
      status: 'warn',
      description: 'Robots directives tell crawlers not to follow links on this page.',
      recommendation: 'Remove nofollow unless link equity should intentionally not be passed.',
    });
  }
  if (!noindex && !nofollow) {
    items.push({
      id: 'seo-indexable',
      title: 'Page Is Indexable',
      status: 'pass',
      description: 'No noindex/nofollow robots directives found.',
    });
  }
  return { penalty, indexable: !noindex };
}

function auditH1(parsed: ParsedHtml, items: AuditItem[]): number {
  if (parsed.h1List.length === 0) {
    items.push({
      id: 'seo-h1-missing',
      title: 'Missing H1 Heading',
      status: 'fail',
      description: 'Page does not contain any non-empty <h1> heading element.',
      recommendation: 'Add a single top-level <h1> that conveys the main subject of the page.',
    });
    return 15;
  }
  if (parsed.h1List.length > 1) {
    items.push({
      id: 'seo-h1-multiple',
      title: 'Multiple H1 Headings',
      status: 'warn',
      description: `Found ${parsed.h1List.length} <h1> tags. A single <h1> per page is recommended for clear hierarchy.`,
    });
    return 5;
  }
  items.push({
    id: 'seo-h1-ok',
    title: 'Single H1 Heading Present',
    status: 'pass',
    description: 'Exactly one <h1> heading found.',
  });
  return 0;
}

function auditCanonical(
  parsed: ParsedHtml,
  pageUrl: string,
  items: AuditItem[],
): { penalty: number; resolved?: string; matches?: boolean } {
  if (parsed.canonicals.length === 0) {
    items.push({
      id: 'seo-canonical-missing',
      title: 'Missing Canonical Link',
      status: 'warn',
      description: 'No <link rel="canonical"> tag declared.',
      recommendation: 'Declare a canonical URL to consolidate duplicate URLs in search engines.',
    });
    return { penalty: 10 };
  }

  let penalty = 0;
  if (new Set(parsed.canonicals).size > 1) {
    penalty += 5;
    items.push({
      id: 'seo-canonical-multiple',
      title: 'Conflicting Canonical Links',
      status: 'warn',
      description: `Found ${parsed.canonicals.length} canonical links; search engines may ignore all of them.`,
      recommendation: 'Keep exactly one canonical link per page.',
    });
  }

  let resolved: URL;
  try {
    resolved = new URL(parsed.canonicals[0], pageUrl);
  } catch {
    items.push({
      id: 'seo-canonical-invalid',
      title: 'Invalid Canonical URL',
      status: 'warn',
      description: 'The canonical href cannot be parsed as a URL.',
    });
    return { penalty: penalty + 10 };
  }

  const matches = normalizeForCompare(resolved) === normalizeForCompare(new URL(pageUrl));
  if (matches) {
    items.push({
      id: 'seo-canonical-ok',
      title: 'Self-Referencing Canonical',
      status: 'pass',
      description: `Canonical URL matches the audited URL: ${resolved.href}`,
    });
  } else {
    penalty += 5;
    items.push({
      id: 'seo-canonical-mismatch',
      title: 'Canonical Points Elsewhere',
      status: 'warn',
      description: `Canonical URL (${resolved.href}) differs from the audited URL (${pageUrl}).`,
      recommendation: 'Confirm this page is intentionally a duplicate; otherwise make the canonical self-referencing.',
    });
  }
  return { penalty, resolved: resolved.href, matches };
}

function auditSocialAndLang(parsed: ParsedHtml, items: AuditItem[]): number {
  let penalty = 0;
  if (!(parsed.openGraph['og:title'] && parsed.openGraph['og:image'])) {
    penalty += 10;
    items.push({
      id: 'seo-og-missing',
      title: 'Incomplete Open Graph Tags',
      status: 'warn',
      description: 'Missing essential OpenGraph tags (og:title or og:image).',
      recommendation: 'Include og:title, og:description, and og:image for rich social sharing.',
    });
  } else {
    items.push({
      id: 'seo-og-ok',
      title: 'Open Graph Tags Present',
      status: 'pass',
      description: 'Found essential og:title and og:image tags.',
    });
  }

  const card = parsed.twitterCard['twitter:card'];
  items.push({
    id: card ? 'seo-twitter-ok' : 'seo-twitter-missing',
    title: card ? 'Twitter Card Declared' : 'No Twitter Card',
    status: card ? 'pass' : 'info',
    description: card ? `twitter:card is "${card}".` : 'No twitter:card meta tag; X/Twitter falls back to Open Graph.',
  });

  if (!parsed.language) {
    penalty += 5;
    items.push({
      id: 'seo-lang-missing',
      title: 'Missing HTML lang Attribute',
      status: 'warn',
      description: 'The <html> element does not specify a lang attribute.',
      recommendation: 'Add lang attribute to <html> (e.g. <html lang="en">).',
    });
  } else {
    items.push({
      id: 'seo-lang-ok',
      title: 'HTML lang Attribute Defined',
      status: 'pass',
      description: `Page language declared as: "${parsed.language}"`,
    });
  }

  if (parsed.hreflang.length > 0) {
    const invalid = parsed.hreflang.filter((h) => !HREFLANG_PATTERN.test(h.lang));
    if (invalid.length > 0) {
      penalty += 5;
      items.push({
        id: 'seo-hreflang-invalid',
        title: 'Invalid hreflang Values',
        status: 'warn',
        description: `Invalid hreflang codes: ${invalid.slice(0, 10).map((h) => h.lang).join(', ')}.`,
        recommendation: 'Use ISO 639-1 language codes with optional ISO 3166-1 region (e.g. en-GB) or x-default.',
      });
    } else {
      items.push({
        id: 'seo-hreflang-ok',
        title: 'hreflang Alternates Declared',
        status: 'pass',
        description: `${parsed.hreflang.length} valid hreflang alternates found.`,
      });
    }
  }
  return penalty;
}

/**
 * Runs SEO analysis on parsed HTML plus response headers.
 * @param parsed Parsed HTML representation
 * @param url Final page URL
 * @param headers Response headers (lower-case keys), used for X-Robots-Tag
 * @returns SeoAuditResult
 */
export function auditSeo(parsed: ParsedHtml, url: string, headers: Record<string, string> = {}): SeoAuditResult {
  const items: AuditItem[] = [];
  const xRobotsTag = headers['x-robots-tag'];
  const indexability = auditIndexability(parseRobotsDirectives([parsed.robots, xRobotsTag]), items);
  let penalty = indexability.penalty;
  penalty += auditTitleAndDescription(parsed, items);
  penalty += auditH1(parsed, items);
  const canonical = auditCanonical(parsed, url, items);
  penalty += canonical.penalty;
  penalty += auditSocialAndLang(parsed, items);

  const score = penaltyToScore(penalty);
  return {
    url,
    timestamp: new Date().toISOString(),
    score,
    rating: scoreToRating(score),
    items,
    title: parsed.title,
    titleLength: parsed.title?.length,
    description: parsed.description,
    descriptionLength: parsed.description?.length,
    canonical: parsed.canonical,
    canonicalResolved: canonical.resolved,
    canonicalMatches: canonical.matches,
    robots: parsed.robots,
    xRobotsTag,
    indexable: indexability.indexable,
    h1Count: parsed.h1List.length,
    h1Content: parsed.h1List,
    openGraph: parsed.openGraph,
    twitterCard: parsed.twitterCard,
    hreflangCount: parsed.hreflang.length,
    language: parsed.language,
  };
}
