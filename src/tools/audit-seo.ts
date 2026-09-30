import { auditSeo } from '../engines/seo-checks.js';
import { formatSeoMarkdown } from '../formatters.js';
import { createPageAuditTool } from './common.js';

export const auditSeoTool = createPageAuditTool({
  name: 'audit_seo',
  title: 'SEO Audit',
  description:
    'Performs a search engine optimization (SEO) audit on a public webpage using its static HTML and response headers. Checks title and meta description length, indexability (robots meta and X-Robots-Tag noindex/nofollow), canonical URL (resolved and compared to the page), H1 count, Open Graph and Twitter card tags, hreflang codes, and the HTML lang attribute. Returns a 0-100 score with findings.',
  purpose: 'for SEO',
  label: 'SEO audit',
  cachePrefix: 'seo',
  requiresHtml: true,
  run: (target, parse) => auditSeo(parse(), target.finalUrl, target.headers),
  toMarkdown: formatSeoMarkdown,
});
