import { describe, expect, it, vi } from 'vitest';
import { fetchResultFixture } from '../helpers.js';

vi.mock('../../src/engines/seo-checks.js', () => ({
  auditSeo: () => {
    throw new Error('seo engine exploded');
  },
}));

const { buildFullAudit, calculateOverall } = await import('../../src/tools/audit-full.js');

describe('audit_full partial results (M1)', () => {
  it('returns remaining categories when one engine throws', () => {
    const result = buildFullAudit(fetchResultFixture(), null);
    expect(result.seo).toBeUndefined();
    expect(result.errors.seo).toContain('seo engine exploded');
    expect(result.security).toBeDefined();
    expect(result.tracking).toBeDefined();
    expect(result.accessibility).toBeDefined();
    expect(result.performance).toBeDefined();
    expect(result.overallScore).toBe(
      calculateOverall({
        security: result.security?.score,
        tracking: result.tracking?.score,
        accessibility: result.accessibility?.score,
        performance: result.performance?.score,
      }),
    );
  });

  it('re-normalizes weights and returns null when nothing completed', () => {
    expect(calculateOverall({ seo: 100, security: 0 })).toBe(50);
    expect(calculateOverall({ performance: 80 })).toBe(80);
    expect(calculateOverall({})).toBeNull();
  });
});
