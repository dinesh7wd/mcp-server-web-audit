import { auditCache, cacheKeyFor } from '../cache.js';
import { fetchCruxMetrics } from '../engines/crux.js';
import { auditPerformance } from '../engines/performance.js';
import { formatPerformanceMarkdown } from '../formatters.js';
import { PerformanceAuditResult } from '../types.js';
import { AuditTool, auditInputShape, fetchTarget, renderResult, runAudit, validateTarget } from './common.js';

export const auditPerformanceTool: AuditTool = {
  name: 'audit_performance',
  title: 'Performance Audit',
  description:
    'Audits page performance from the audit server: Time to First Byte, decompressed HTML size, compression, and Cache-Control. When the server has a CRUX_API_KEY, also reports Chrome UX Report p75 field data (LCP, INP, CLS; URL-level with origin fallback). Does not run a browser or Lighthouse.',
  inputSchema: auditInputShape('for performance'),
  handler: (args, extra) =>
    runAudit('Performance audit', args.url, extra, async (signal) => {
      const url = await validateTarget(args.url, signal);
      const { value, cached } = await auditCache.getOrCompute(cacheKeyFor('perf', url), async () => {
        const [target, fieldData] = await Promise.all([
          fetchTarget(url, signal),
          fetchCruxMetrics(url.href, { signal }),
        ]);
        return auditPerformance(target, fieldData);
      });
      return renderResult(value as PerformanceAuditResult, cached, args.format, formatPerformanceMarkdown);
    }),
};
