import { auditSecurity } from '../engines/security-checks.js';
import { formatSecurityMarkdown } from '../formatters.js';
import { parseCookies } from '../parsers.js';
import { createPageAuditTool } from './common.js';

export const auditSecurityTool = createPageAuditTool({
  name: 'audit_security',
  title: 'Security Headers Audit',
  description:
    'Audits HTTP security configuration of a public website. Checks HTTPS, HSTS (max-age, includeSubDomains, preload), Content-Security-Policy (enforced vs report-only, unsafe script sources, object-src, base-uri), clickjacking protection (frame-ancestors / X-Frame-Options), X-Content-Type-Options, Referrer-Policy, Permissions-Policy, and cookie flags (Secure, HttpOnly, SameSite) across all redirect hops. Returns a 0-100 score with findings.',
  purpose: 'for security headers',
  label: 'Security audit',
  cachePrefix: 'sec',
  requiresHtml: false,
  run: (target) => auditSecurity(target.headers, parseCookies(target.setCookies), target.finalUrl),
  toMarkdown: formatSecurityMarkdown,
});
