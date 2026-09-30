import { OverallRating } from '../types.js';

/**
 * Converts numeric score to rating.
 * @param score Number 0-100
 * @returns OverallRating
 */
export function scoreToRating(score: number): OverallRating {
  if (score >= 80) return 'good';
  if (score >= 50) return 'warning';
  return 'poor';
}

/**
 * Converts accumulated penalty points to a 0-100 score.
 * @param penalty Total penalty
 * @returns Score
 */
export function penaltyToScore(penalty: number): number {
  return Math.max(0, Math.min(100, 100 - penalty));
}

/**
 * Makes a string safe for use inside an audit item id.
 * @param value Raw value (may be page-controlled)
 * @returns Sanitized slug
 */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
