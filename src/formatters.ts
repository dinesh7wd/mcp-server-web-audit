import {
  A11yAuditResult,
  AuditCategory,
  AuditItem,
  FullAuditResult,
  PerformanceAuditResult,
  SecurityAuditResult,
  SeoAuditResult,
  TrackingAuditResult,
} from './types.js';

const MAX_INLINE_LENGTH = 200;

/**
 * Collapses whitespace and truncates page-controlled text for safe inline Markdown.
 * @param value Raw text
 * @param max Maximum length
 * @returns Sanitized single-line text
 */
export function inline(value: string, max = MAX_INLINE_LENGTH): string {
  const collapsed = value.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function statusBadge(status: string): string {
  switch (status) {
    case 'pass':
      return '🟢 PASS';
    case 'warn':
      return '🟡 WARN';
    case 'fail':
      return '🔴 FAIL';
    case 'info':
      return '🔵 INFO';
    default:
      return '⚪ ' + status.toUpperCase();
  }
}

function formatItems(items: AuditItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`- **${statusBadge(item.status)}** — **${inline(item.title)}**`);
    lines.push(`  ${inline(item.description, 400)}`);
    if (item.recommendation) {
      lines.push(`  *Recommendation*: ${item.recommendation}`);
    }
  }
  return lines.join('\n');
}

function header(title: string, res: { url: string; score: number; rating: string; timestamp: string }): string[] {
  return [
    title,
    `**URL**: ${res.url}`,
    `**Score**: **${res.score} / 100** (${res.rating.toUpperCase()})`,
    `**Timestamp**: ${res.timestamp}`,
    ``,
  ];
}

export function formatSeoMarkdown(res: SeoAuditResult): string {
  return [
    ...header(`# 🔍 SEO Audit Report`, res),
    `## Summary`,
    `- **Title**: ${res.title ? `"${inline(res.title)}" (${res.titleLength} chars)` : '*(missing)*'}`,
    `- **Description**: ${res.description ? `"${inline(res.description)}" (${res.descriptionLength} chars)` : '*(missing)*'}`,
    `- **Canonical**: ${res.canonicalResolved ? inline(res.canonicalResolved) : res.canonical ? inline(res.canonical) : '*(none)*'}`,
    `- **Indexable**: ${res.indexable ? 'Yes' : 'No (noindex)'}`,
    `- **H1 Tags**: ${res.h1Count} found`,
    `- **Language**: ${res.language ? inline(res.language, 40) : '*(not specified)*'}`,
    ``,
    `## Detailed Findings`,
    formatItems(res.items),
  ].join('\n');
}

export function formatSecurityMarkdown(res: SecurityAuditResult): string {
  const csp = res.cspHeader ? '✅ Enforced' : res.cspReportOnlyHeader ? '⚠️ Report-Only' : '⚠️ Missing';
  return [
    ...header(`# 🛡️ Security Audit Report`, res),
    `## Headers Overview`,
    `- **HTTPS**: ${res.isHttps ? '✅ Enabled' : '❌ Disabled'}`,
    `- **HSTS**: ${res.hstsHeader ? `\`${inline(res.hstsHeader, 120)}\`` : '❌ Missing'}`,
    `- **CSP**: ${csp}`,
    `- **X-Frame-Options**: ${res.xFrameOptions ? inline(res.xFrameOptions, 60) : '⚠️ Missing'}`,
    `- **X-Content-Type-Options**: ${res.xContentTypeOptions ? inline(res.xContentTypeOptions, 60) : '⚠️ Missing'}`,
    `- **Referrer-Policy**: ${res.referrerPolicy ? inline(res.referrerPolicy, 80) : '⚠️ Missing'}`,
    `- **Cookies**: ${res.cookieFlags.length} set`,
    ``,
    `## Detailed Findings`,
    formatItems(res.items),
  ].join('\n');
}

export function formatTrackingMarkdown(res: TrackingAuditResult): string {
  return [
    ...header(`# 📊 Tracking & Analytics Audit Report`, res),
    `## Detected Trackers (${res.detectedTrackers.length})`,
    res.detectedTrackers.length === 0
      ? `*(No common analytics or marketing pixels detected in static HTML)*`
      : res.detectedTrackers
          .map((t) => `- **${t.name}** (${t.category})${t.identifiers.length ? ` — ID: ${t.identifiers.join(', ')}` : ''}`)
          .join('\n'),
    ``,
    `## Detailed Findings`,
    formatItems(res.items),
  ].join('\n');
}

export function formatA11yMarkdown(res: A11yAuditResult): string {
  return [
    ...header(`# ♿ Accessibility Audit Report`, res),
    `## Summary`,
    `- **Images Without Alt**: ${res.imagesWithoutAlt} / ${res.totalImages}`,
    `- **Unlabeled Form Controls**: ${res.formInputsWithoutLabel} / ${res.formInputsTotal}`,
    `- **Main Landmark**: ${res.hasMainLandmark ? '✅ Present' : '⚠️ Missing'}`,
    `- **Navigation Landmark**: ${res.hasNavLandmark ? '✅ Present' : '⚠️ Missing'}`,
    `- **Language Declared**: ${res.languageDeclared ? '✅ Yes' : '❌ No'}`,
    `- **Heading Hierarchy**: ${res.headingOrderValid ? '✅ Valid' : `⚠️ ${res.headingSkips} skip(s) detected`}`,
    ``,
    `## Detailed Findings`,
    formatItems(res.items),
  ].join('\n');
}

export function formatPerformanceMarkdown(res: PerformanceAuditResult): string {
  const lines = [
    ...header(`# ⚡ Performance Audit Report`, res),
    `**Engine**: ${res.engine.toUpperCase()}${res.fieldData ? ' + CrUX field data' : ''}`,
    ``,
    `## Network Metrics (measured from the audit server)`,
    `- **Time to First Byte (TTFB)**: ${res.timing.ttfbMs} ms`,
    `- **HTML Payload Size (decompressed)**: ${Math.round(res.payloadSize / 1024)} KB`,
    `- **Compression**: ${res.compression || 'None'}`,
    `- **Cache-Control**: ${res.cacheControl ? inline(res.cacheControl, 120) : 'None'}`,
  ];

  const field = res.fieldData;
  if (field) {
    lines.push(``, `## Core Web Vitals (CrUX p75, phone, ${field.scope}-level)`);
    if (field.lcpMs !== undefined) lines.push(`- **LCP**: ${Math.round(field.lcpMs)} ms`);
    if (field.inpMs !== undefined) lines.push(`- **INP**: ${Math.round(field.inpMs)} ms`);
    if (field.cls !== undefined) lines.push(`- **CLS**: ${field.cls.toFixed(2)}`);
    if (field.fcpMs !== undefined) lines.push(`- **FCP**: ${Math.round(field.fcpMs)} ms`);
    if (field.ttfbMs !== undefined) lines.push(`- **TTFB**: ${Math.round(field.ttfbMs)} ms`);
  }

  lines.push(``, `## Detailed Findings`, formatItems(res.items));
  return lines.join('\n');
}

const CATEGORY_LABELS: Record<AuditCategory, string> = {
  seo: '🔍 **SEO**',
  security: '🛡️ **Security**',
  tracking: '📊 **Tracking**',
  accessibility: '♿ **Accessibility**',
  performance: '⚡ **Performance**',
};

export function formatFullMarkdown(res: FullAuditResult): string {
  const rows: string[] = [];
  const sections: string[] = [];
  const categories: Array<[AuditCategory, { score: number; rating: string } | undefined, () => string]> = [
    ['seo', res.seo, () => formatSeoMarkdown(res.seo!)],
    ['security', res.security, () => formatSecurityMarkdown(res.security!)],
    ['tracking', res.tracking, () => formatTrackingMarkdown(res.tracking!)],
    ['accessibility', res.accessibility, () => formatA11yMarkdown(res.accessibility!)],
    ['performance', res.performance, () => formatPerformanceMarkdown(res.performance!)],
  ];

  for (const [key, result, render] of categories) {
    if (result) {
      rows.push(`| ${CATEGORY_LABELS[key]} | ${result.score} / 100 | ${result.rating.toUpperCase()} |`);
      sections.push(`---`, render());
    } else {
      rows.push(`| ${CATEGORY_LABELS[key]} | n/a | ERROR |`);
    }
  }

  const errorEntries = Object.entries(res.errors) as Array<[AuditCategory, string]>;
  const errorLines =
    errorEntries.length > 0
      ? [``, `## ⚠️ Partial Result`, ...errorEntries.map(([k, msg]) => `- **${k}**: ${inline(msg, 300)}`)]
      : [];

  return [
    `# 🌐 Comprehensive Web Audit: ${res.url}`,
    `**Overall Score**: **${res.overallScore} / 100** (${res.overallRating.toUpperCase()})`,
    `**Audit Date**: ${res.timestamp}`,
    ...errorLines,
    ``,
    `## 📊 Category Scores`,
    `| Category | Score | Rating |`,
    `|---|---|---|`,
    ...rows,
    ``,
    ...sections,
  ].join('\n');
}
