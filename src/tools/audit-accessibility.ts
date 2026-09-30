import { auditA11y } from '../engines/a11y-checks.js';
import { formatA11yMarkdown } from '../formatters.js';
import { createPageAuditTool } from './common.js';

export const auditAccessibilityTool = createPageAuditTool({
  name: 'audit_accessibility',
  title: 'Accessibility Audit',
  description:
    'Performs a static-HTML accessibility (a11y) check on a public webpage (no rendering, so no colour-contrast checks). Checks image alt attributes (decorative images excluded), form control labels (label, aria-label, aria-labelledby, title), main and navigation landmarks, every skipped heading level, and the HTML lang attribute. Returns a 0-100 score with findings.',
  purpose: 'for accessibility (a11y)',
  label: 'Accessibility audit',
  cachePrefix: 'a11y',
  requiresHtml: true,
  run: (target, parse) => auditA11y(parse(), target.finalUrl),
  toMarkdown: formatA11yMarkdown,
});
