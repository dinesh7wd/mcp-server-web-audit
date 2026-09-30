import { auditTracking } from '../engines/tracking-checks.js';
import { formatTrackingMarkdown } from '../formatters.js';
import { createPageAuditTool } from './common.js';

export const auditTrackingTool = createPageAuditTool({
  name: 'audit_tracking',
  title: 'Tracking Tags Audit',
  description:
    'Detects marketing pixels and analytics tags in the static HTML of a public webpage: Google Analytics 4 (GA4), Google Tag Manager (GTM), Meta Pixel, TikTok Pixel, LinkedIn Insight Tag, Hotjar, and Microsoft Clarity. Reports tracker IDs and flags multiple IDs for the same tracker. Tags injected at runtime (e.g. by GTM) are not visible.',
  purpose: 'for tracking pixels and analytics tags',
  label: 'Tracking audit',
  cachePrefix: 'track',
  requiresHtml: true,
  run: (target, parse) => auditTracking(parse(), target.finalUrl),
  toMarkdown: formatTrackingMarkdown,
});
