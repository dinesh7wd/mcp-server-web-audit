import { auditCache, cacheKeyFor } from '../cache.js';
import { auditA11y } from '../engines/a11y-checks.js';
import { fetchCruxMetrics } from '../engines/crux.js';
import { auditPerformance } from '../engines/performance.js';
import { scoreToRating } from '../engines/scoring.js';
import { auditSecurity } from '../engines/security-checks.js';
import { auditSeo } from '../engines/seo-checks.js';
import { auditTracking } from '../engines/tracking-checks.js';
import { AppError, ErrorCodes } from '../errors.js';
import { formatFullMarkdown } from '../formatters.js';
import { logError } from '../logger.js';
import { ParsedHtml, parseCookies, parseHtml } from '../parsers.js';
import { AuditCategory, FetchResult, FieldMetrics, FullAuditResult } from '../types.js';
import {
  AuditTool,
  auditInputShape,
  createProgressReporter,
  fetchTarget,
  isHtmlResponse,
  notHtmlError,
  renderResult,
  runAudit,
  validateTarget,
} from './common.js';

export const CATEGORY_WEIGHTS: Record<AuditCategory, number> = {
  seo: 0.25,
  security: 0.25,
  tracking: 0.15,
  accessibility: 0.15,
  performance: 0.2,
};

/**
 * Weighted average over the categories that completed (weights re-normalized).
 * @param scores Scores by category
 * @returns Overall score, or null when no category completed
 */
export function calculateOverall(scores: Partial<Record<AuditCategory, number>>): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const [category, weight] of Object.entries(CATEGORY_WEIGHTS) as Array<[AuditCategory, number]>) {
    const score = scores[category];
    if (score === undefined) continue;
    weighted += score * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? null : Math.round(weighted / totalWeight);
}

function describeEngineError(err: unknown): string {
  if (err instanceof AppError) return err.toClientMessage();
  return `${ErrorCodes.InternalError}: This audit engine failed; details are in the server logs.`;
}

/**
 * Runs every engine independently so one failure yields a partial result instead of a failed call.
 * @param target Fetched page
 * @param fieldData Optional CrUX metrics
 * @returns FullAuditResult (with `errors` for failed categories)
 */
export function buildFullAudit(target: FetchResult, fieldData: FieldMetrics | null): FullAuditResult {
  const errors: FullAuditResult['errors'] = {};
  const attempt = <T>(category: AuditCategory, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      errors[category] = describeEngineError(err);
      logError('audit_full engine failed', { category, error: String(err) });
      return undefined;
    }
  };

  let parsed: ParsedHtml | undefined;
  let htmlError: string | undefined;
  if (!isHtmlResponse(target)) {
    htmlError = notHtmlError(target).toClientMessage();
  } else {
    try {
      parsed = parseHtml(target.body);
    } catch (err) {
      htmlError = describeEngineError(err);
    }
  }
  const withHtml = <T>(category: AuditCategory, fn: (p: ParsedHtml) => T): T | undefined => {
    if (!parsed) {
      errors[category] = htmlError;
      return undefined;
    }
    const html = parsed;
    return attempt(category, () => fn(html));
  };

  const seo = withHtml('seo', (p) => auditSeo(p, target.finalUrl, target.headers));
  const security = attempt('security', () =>
    auditSecurity(target.headers, parseCookies(target.setCookies), target.finalUrl),
  );
  const tracking = withHtml('tracking', (p) => auditTracking(p, target.finalUrl));
  const accessibility = withHtml('accessibility', (p) => auditA11y(p, target.finalUrl));
  const performance = attempt('performance', () => auditPerformance(target, fieldData));

  const overallScore = calculateOverall({
    seo: seo?.score,
    security: security?.score,
    tracking: tracking?.score,
    accessibility: accessibility?.score,
    performance: performance?.score,
  });
  if (overallScore === null) {
    throw new AppError(ErrorCodes.InternalError, 'All audit engines failed');
  }

  return {
    url: target.finalUrl,
    timestamp: new Date().toISOString(),
    overallScore,
    overallRating: scoreToRating(overallScore),
    seo,
    security,
    tracking,
    accessibility,
    performance,
    errors,
  };
}

export const auditFullTool: AuditTool = {
  name: 'audit_full',
  title: 'Full Website Audit',
  description:
    'Runs all five audits (SEO, security headers, tracking tags, accessibility, performance) on one public URL from a single fetch and returns category scores plus a weighted overall score. If an individual engine fails, the remaining categories are still returned with a per-category error.',
  inputSchema: auditInputShape('comprehensively'),
  handler: (args, extra) =>
    runAudit('Full audit', args.url, extra, async (signal) => {
      const url = await validateTarget(args.url, signal);
      const progress = createProgressReporter(extra, 3);
      const { value, cached } = await auditCache.getOrCompute(
        cacheKeyFor('full', url),
        async (shared) => {
          await progress(0, 'Fetching page');
          const [target, fieldData] = await Promise.all([
            fetchTarget(url, shared),
            fetchCruxMetrics(url.href, { signal: shared }),
          ]);
          await progress(1, 'Running audit engines');
          const result = buildFullAudit(target, fieldData);
          await progress(2, 'Rendering report');
          return result;
        },
        (result) => Object.keys((result as FullAuditResult).errors).length === 0,
        signal,
      );
      return renderResult(value as FullAuditResult, cached, args.format, formatFullMarkdown);
    }),
};
