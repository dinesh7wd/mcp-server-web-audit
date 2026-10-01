import { MemoryCache } from './cache.js';
import { CONFIG } from './config.js';
import { AppError, ErrorCodes } from './errors.js';
import { safeFetch } from './fetcher.js';
import { logWarn } from './logger.js';
import { NetworkPolicy } from './types.js';

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export type RobotsRules = RobotsRule[] | 'disallow-all';

const ROBOTS_TTL_MS = 5 * 60 * 1000;
/** A 5xx or network failure may be transient, so the resulting disallow-all is only cached briefly. */
export const ROBOTS_FAILURE_TTL_MS = 30 * 1000;
const robotsCache = new MemoryCache<RobotsRules>(ROBOTS_TTL_MS, 500);

/**
 * Longer Disallow patterns are cut to a prefix (a broader, stricter match); longer Allow
 * patterns are dropped. Keeps matching cost bounded without ever loosening a restriction.
 */
export const MAX_ROBOTS_PATTERN_LENGTH = 512;

/**
 * Returns the lower-cased product token of a User-Agent string (e.g. "mcp-server-web-audit").
 * @param userAgent Full User-Agent
 * @returns Product token
 */
export function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[/\s]/)[0] || '').toLowerCase();
}

/**
 * Parses robots.txt per RFC 9309: consecutive user-agent lines share a group,
 * the group matching the product token wins, otherwise "*" applies.
 * @param body robots.txt content
 * @param userAgent Crawler User-Agent
 * @returns Applicable rules
 */
export function parseRobotsTxt(body: string, userAgent: string): RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (current && (key === 'allow' || key === 'disallow')) {
      const allow = key === 'allow';
      if (value && (!allow || value.length <= MAX_ROBOTS_PATTERN_LENGTH)) {
        current.rules.push({ allow, pattern: value.slice(0, MAX_ROBOTS_PATTERN_LENGTH) });
      }
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  const token = productToken(userAgent);
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && a === token));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

/**
 * Matches a robots.txt path pattern (`*` wildcard, trailing `$` anchor) without regular
 * expressions: literal segments are located left to right with indexOf, so the cost is
 * linear in path + pattern length and hostile patterns cannot cause catastrophic backtracking.
 * @param pattern Allow/Disallow value
 * @param path Path plus query string
 * @returns true when the pattern matches from the start of the path
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const segments = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = segments[0]!;
  if (!path.startsWith(first)) return false;
  if (segments.length === 1) return !anchored || path.length === first.length;

  let pos = first.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (!seg) continue;
    const idx = path.indexOf(seg, pos);
    if (idx === -1) return false;
    pos = idx + seg.length;
  }
  const last = segments[segments.length - 1]!;
  if (!anchored) return !last || path.indexOf(last, pos) !== -1;
  return path.length - last.length >= pos && path.endsWith(last);
}

/**
 * Longest-match evaluation with `*` and `$` support; ties resolve to allow.
 * @param pathWithQuery Path plus query string
 * @param rules Applicable rules
 * @returns true when allowed
 */
export function pathAllowed(pathWithQuery: string, rules: RobotsRules): boolean {
  if (rules === 'disallow-all') return false;
  const path = pathWithQuery || '/';
  if (path === '/robots.txt') return true;
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!robotsPatternMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/**
 * Fetches and caches robots.txt for an origin through the SSRF-safe fetcher.
 * 4xx means no restrictions; 5xx or unreachable means full disallow (RFC 9309 §2.3.1), cached only
 * for ROBOTS_FAILURE_TTL_MS. A robots.txt above the size limit is treated as full disallow (fail closed).
 */
export async function getRobotsRules(
  originUrl: string,
  options: { signal?: AbortSignal; policy?: NetworkPolicy } = {},
): Promise<RobotsRules> {
  const origin = new URL(originUrl).origin;
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  let rules: RobotsRules;
  let ttlMs = ROBOTS_TTL_MS;
  try {
    const res = await safeFetch(`${origin}/robots.txt`, {
      accept: 'text/plain,*/*;q=0.1',
      maxSizeBytes: CONFIG.network.robotsMaxSizeBytes,
      signal: options.signal,
      policy: options.policy,
    });
    if (res.status >= 200 && res.status < 300) {
      rules = parseRobotsTxt(res.body, CONFIG.network.userAgent);
    } else if (res.status >= 400 && res.status < 500) {
      rules = [];
    } else {
      rules = 'disallow-all';
      ttlMs = ROBOTS_FAILURE_TTL_MS;
    }
  } catch (err) {
    if (options.signal?.aborted) throw err;
    rules = 'disallow-all';
    if (err instanceof AppError && err.code === ErrorCodes.ResponseTooLarge) {
      logWarn('robots.txt exceeds the size limit; treating as full disallow', { origin });
    } else {
      logWarn('robots.txt unreachable; treating as full disallow', {
        origin,
        error: err instanceof AppError ? err.code : 'unknown',
      });
      ttlMs = ROBOTS_FAILURE_TTL_MS;
    }
  }
  robotsCache.set(origin, rules, ttlMs);
  return rules;
}

/**
 * Returns true if the configured User-Agent may fetch this URL per robots.txt.
 */
export async function isAllowedByRobots(
  targetUrl: string,
  options: { signal?: AbortSignal; policy?: NetworkPolicy } = {},
): Promise<boolean> {
  const url = new URL(targetUrl);
  const rules = await getRobotsRules(url.href, options);
  return pathAllowed(`${url.pathname}${url.search}`, rules);
}

export function clearRobotsCache(): void {
  robotsCache.clear();
}
