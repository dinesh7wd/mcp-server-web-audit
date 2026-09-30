import { AuditItem, SecurityAuditResult } from '../types.js';
import { ParsedCookie } from '../parsers.js';
import { penaltyToScore, scoreToRating } from './scoring.js';

export const HSTS_RECOMMENDED_MAX_AGE = 15_552_000; // 180 days
const CSP_PENALTY_CAP = 20;
const COOKIE_PENALTY_CAP = 20;
const COOKIE_LIST_LIMIT = 20;

export interface HstsInfo {
  maxAge?: number;
  includeSubDomains: boolean;
  preload: boolean;
}

/**
 * Parses a Strict-Transport-Security header.
 * @param value Header value
 * @returns Parsed directives
 */
export function parseHsts(value: string): HstsInfo {
  const info: HstsInfo = { includeSubDomains: false, preload: false };
  for (const part of value.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    const name = rawName.trim().toLowerCase();
    if (name === 'max-age') {
      const n = Number(rest.join('=').trim().replace(/^"|"$/g, ''));
      if (Number.isInteger(n) && n >= 0) info.maxAge = n;
    } else if (name === 'includesubdomains') {
      info.includeSubDomains = true;
    } else if (name === 'preload') {
      info.preload = true;
    }
  }
  return info;
}

export type CspPolicy = Map<string, string[]>;

/**
 * Parses a (possibly comma-joined) CSP header into policies of directive -> sources.
 * @param value Header value
 * @returns List of policies
 */
export function parseCsp(value: string): CspPolicy[] {
  return value
    .split(',')
    .map((policyText) => {
      const policy: CspPolicy = new Map();
      for (const directive of policyText.split(';')) {
        const tokens = directive.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) continue;
        const name = tokens[0].toLowerCase();
        if (!policy.has(name)) policy.set(name, tokens.slice(1).map((t) => t.toLowerCase()));
      }
      return policy;
    })
    .filter((p) => p.size > 0);
}

function checkTransportSecurity(isHttps: boolean, hsts: string | undefined, items: AuditItem[]): number {
  if (!isHttps) {
    items.push({
      id: 'sec-https-missing',
      title: 'Insecure HTTP Protocol',
      status: 'fail',
      description: 'The website is served over unencrypted plain HTTP.',
      recommendation: 'Enforce HTTPS everywhere with automatic HTTP to HTTPS redirects.',
    });
    return 35;
  }
  items.push({
    id: 'sec-https-ok',
    title: 'HTTPS Enabled',
    status: 'pass',
    description: 'The connection is encrypted using HTTPS.',
  });

  const recommendation = 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains (add preload once ready).';
  if (!hsts) {
    items.push({
      id: 'sec-hsts-missing',
      title: 'Missing HSTS Header',
      status: 'warn',
      description: 'Strict-Transport-Security header is not present.',
      recommendation,
    });
    return 15;
  }
  const info = parseHsts(hsts);
  if (info.maxAge === undefined) {
    items.push({
      id: 'sec-hsts-invalid',
      title: 'Invalid HSTS Header',
      status: 'fail',
      description: `Strict-Transport-Security has no valid max-age directive: "${hsts}".`,
      recommendation,
    });
    return 15;
  }
  if (info.maxAge === 0) {
    items.push({
      id: 'sec-hsts-disabled',
      title: 'HSTS Disabled (max-age=0)',
      status: 'fail',
      description: 'max-age=0 instructs browsers to forget the HSTS policy.',
      recommendation,
    });
    return 15;
  }
  const flags = `includeSubDomains: ${info.includeSubDomains ? 'yes' : 'no'}, preload: ${info.preload ? 'yes' : 'no'}`;
  if (info.maxAge < HSTS_RECOMMENDED_MAX_AGE) {
    items.push({
      id: 'sec-hsts-short',
      title: 'Short HSTS max-age',
      status: 'warn',
      description: `HSTS max-age is ${info.maxAge}s (< 180 days). ${flags}.`,
      recommendation,
    });
    return 8;
  }
  items.push({
    id: 'sec-hsts-ok',
    title: 'HSTS Header Active',
    status: 'pass',
    description: `HSTS max-age is ${info.maxAge}s. ${flags}.`,
  });
  return 0;
}

function evaluateScriptSources(policy: CspPolicy, items: AuditItem[]): number {
  const sources = policy.get('script-src') ?? policy.get('default-src');
  if (!sources) {
    items.push({
      id: 'sec-csp-no-script-src',
      title: 'CSP Does Not Restrict Scripts',
      status: 'warn',
      description: 'The enforced policy has neither script-src nor default-src, so scripts are unrestricted.',
      recommendation: "Add default-src 'self' and a script-src using nonces or hashes.",
    });
    return 10;
  }

  const hasNonceOrHash = sources.some((s) => /^'(nonce|sha256|sha384|sha512)-/.test(s));
  const findings: string[] = [];
  if (sources.includes("'unsafe-inline'") && !hasNonceOrHash && !sources.includes("'strict-dynamic'")) {
    findings.push("'unsafe-inline'");
  }
  if (sources.includes("'unsafe-eval'")) findings.push("'unsafe-eval'");
  for (const wildcard of ['*', 'http:', 'https:', 'data:']) {
    if (sources.includes(wildcard)) findings.push(wildcard);
  }
  if (findings.length === 0) {
    items.push({
      id: 'sec-csp-scripts-ok',
      title: 'CSP Restricts Script Sources',
      status: 'pass',
      description: 'No unsafe keywords or wildcard sources found in the script policy.',
    });
    return 0;
  }
  items.push({
    id: 'sec-csp-unsafe-sources',
    title: 'CSP Allows Unsafe Script Sources',
    status: 'warn',
    description: `The script policy allows: ${findings.join(', ')}.`,
    recommendation: "Remove 'unsafe-inline'/'unsafe-eval' and broad wildcards; use nonces or hashes with 'strict-dynamic'.",
  });
  return Math.min(15, findings.length * 5);
}

function checkCsp(headers: Record<string, string>, items: AuditItem[]): { penalty: number; policies: CspPolicy[] } {
  const enforced = headers['content-security-policy'];
  const reportOnly = headers['content-security-policy-report-only'];
  if (!enforced) {
    items.push({
      id: reportOnly ? 'sec-csp-report-only' : 'sec-csp-missing',
      title: reportOnly ? 'CSP in Report-Only Mode' : 'Missing Content-Security-Policy (CSP)',
      status: 'warn',
      description: reportOnly
        ? 'Only Content-Security-Policy-Report-Only is set; violations are reported but not blocked.'
        : 'No Content-Security-Policy header detected. Increases vulnerability to XSS and injection.',
      recommendation: reportOnly
        ? 'Promote the policy to an enforced Content-Security-Policy header once reports are clean.'
        : 'Define a strict Content-Security-Policy header.',
    });
    return { penalty: reportOnly ? 12 : CSP_PENALTY_CAP, policies: [] };
  }

  const policies = parseCsp(enforced);
  items.push({
    id: 'sec-csp-ok',
    title: 'Content-Security-Policy Present',
    status: 'pass',
    description: `Content-Security-Policy is enforced (${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}).`,
  });
  const primary = policies.find((p) => p.has('script-src') || p.has('default-src')) ?? policies[0] ?? new Map();
  let penalty = evaluateScriptSources(primary, items);

  const objectSrc = primary.get('object-src') ?? primary.get('default-src');
  if (!objectSrc || !objectSrc.includes("'none'")) {
    items.push({
      id: 'sec-csp-object-src',
      title: "CSP object-src Not 'none'",
      status: 'info',
      description: "Plugins (object/embed) are not fully disabled by the policy.",
      recommendation: "Add object-src 'none'.",
    });
  }
  if (!policies.some((p) => p.has('base-uri'))) {
    items.push({
      id: 'sec-csp-base-uri',
      title: 'CSP base-uri Not Set',
      status: 'info',
      description: 'Without base-uri, injected <base> tags can redirect relative script URLs.',
      recommendation: "Add base-uri 'self' or 'none'.",
    });
    penalty += 2;
  }
  return { penalty: Math.min(CSP_PENALTY_CAP, penalty), policies };
}

function checkFraming(headers: Record<string, string>, policies: CspPolicy[], items: AuditItem[]): number {
  const xfo = headers['x-frame-options']?.trim();
  const xfoValid = xfo !== undefined && ['DENY', 'SAMEORIGIN'].includes(xfo.toUpperCase());
  const hasFrameAncestors = policies.some((p) => p.has('frame-ancestors'));
  if (hasFrameAncestors || xfoValid) {
    items.push({
      id: 'sec-clickjacking-ok',
      title: 'Clickjacking Protection Active',
      status: 'pass',
      description: hasFrameAncestors ? 'Protected via CSP frame-ancestors directive.' : `X-Frame-Options: ${xfo}`,
    });
    return 0;
  }
  items.push({
    id: 'sec-clickjacking-risk',
    title: 'Missing Clickjacking Protection',
    status: 'warn',
    description: xfo
      ? `X-Frame-Options "${xfo}" is not honoured by modern browsers and no CSP frame-ancestors directive is set.`
      : 'Neither X-Frame-Options nor CSP frame-ancestors directive found.',
    recommendation: "Set CSP frame-ancestors 'self' (or 'none'), optionally with X-Frame-Options: DENY/SAMEORIGIN.",
  });
  return 10;
}

function checkMimeAndReferrer(headers: Record<string, string>, items: AuditItem[]): number {
  let penalty = 0;
  if (headers['x-content-type-options']?.trim().toLowerCase() !== 'nosniff') {
    penalty += 10;
    items.push({
      id: 'sec-xcto-missing',
      title: 'Missing X-Content-Type-Options',
      status: 'warn',
      description: 'X-Content-Type-Options: nosniff header is missing.',
      recommendation: 'Add "X-Content-Type-Options: nosniff" to prevent MIME-type confusion attacks.',
    });
  } else {
    items.push({
      id: 'sec-xcto-ok',
      title: 'X-Content-Type-Options: nosniff Enabled',
      status: 'pass',
      description: 'MIME sniffing protection is enabled.',
    });
  }

  const referrer = headers['referrer-policy']?.trim();
  if (!referrer) {
    penalty += 5;
    items.push({
      id: 'sec-referrer-missing',
      title: 'Missing Referrer-Policy',
      status: 'warn',
      description: 'Referrer-Policy header is not explicitly set (browser default applies).',
      recommendation: 'Set Referrer-Policy: strict-origin-when-cross-origin.',
    });
  } else if (referrer.toLowerCase().split(',').map((v) => v.trim()).includes('unsafe-url')) {
    penalty += 5;
    items.push({
      id: 'sec-referrer-unsafe',
      title: 'Referrer-Policy Leaks Full URLs',
      status: 'warn',
      description: 'Referrer-Policy "unsafe-url" sends full URLs (including query strings) to every origin.',
      recommendation: 'Use strict-origin-when-cross-origin or stricter.',
    });
  } else {
    items.push({
      id: 'sec-referrer-ok',
      title: 'Referrer-Policy Configured',
      status: 'pass',
      description: `Referrer-Policy is set to: "${referrer}".`,
    });
  }

  const permissions = headers['permissions-policy'];
  items.push({
    id: permissions ? 'sec-permissions-policy-ok' : 'sec-permissions-policy-missing',
    title: permissions ? 'Permissions-Policy Configured' : 'No Permissions-Policy',
    status: permissions ? 'pass' : 'info',
    description: permissions
      ? 'Permissions-Policy restricts powerful browser features.'
      : 'Permissions-Policy is not set; browser feature defaults apply.',
    recommendation: permissions ? undefined : 'Consider disabling unused features, e.g. Permissions-Policy: camera=(), microphone=(), geolocation=().',
  });
  return penalty;
}

function listNames(cookies: ParsedCookie[]): string {
  const names = cookies.slice(0, COOKIE_LIST_LIMIT).map((c) => c.name);
  const extra = cookies.length - names.length;
  return names.join(', ') + (extra > 0 ? ` (+${extra} more)` : '');
}

function checkCookies(cookies: ParsedCookie[], isHttps: boolean, items: AuditItem[]): number {
  if (cookies.length === 0) return 0;
  let penalty = 0;
  const sameSiteNoneInsecure = cookies.filter((c) => c.sameSite === 'none' && !c.secure);
  const missingSecure = isHttps ? cookies.filter((c) => !c.secure) : [];
  const missingHttpOnly = cookies.filter((c) => !c.httpOnly);
  const missingSameSite = cookies.filter((c) => !c.sameSite);

  if (sameSiteNoneInsecure.length > 0) {
    penalty += Math.min(10, sameSiteNoneInsecure.length * 5);
    items.push({
      id: 'sec-cookie-samesite-none-insecure',
      title: 'SameSite=None Cookies Without Secure',
      status: 'fail',
      description: `Browsers reject SameSite=None cookies that lack Secure: ${listNames(sameSiteNoneInsecure)}.`,
      recommendation: 'Add the Secure attribute to every SameSite=None cookie.',
    });
  }
  if (missingSecure.length > 0) {
    penalty += Math.min(10, missingSecure.length * 3);
    items.push({
      id: 'sec-cookie-missing-secure',
      title: 'Cookies Missing Secure Flag',
      status: 'warn',
      description: `${missingSecure.length} of ${cookies.length} cookies lack Secure: ${listNames(missingSecure)}.`,
      recommendation: 'Set Secure on all cookies served over HTTPS.',
    });
  }
  if (missingHttpOnly.length > 0) {
    penalty += Math.min(6, missingHttpOnly.length * 2);
    items.push({
      id: 'sec-cookie-missing-httponly',
      title: 'Cookies Missing HttpOnly Flag',
      status: 'warn',
      description: `${missingHttpOnly.length} of ${cookies.length} cookies are readable by JavaScript: ${listNames(missingHttpOnly)}.`,
      recommendation: 'Set HttpOnly on session and authentication cookies.',
    });
  }
  if (missingSameSite.length > 0) {
    items.push({
      id: 'sec-cookie-missing-samesite',
      title: 'Cookies Without Explicit SameSite',
      status: 'info',
      description: `${missingSameSite.length} cookies rely on the browser default (Lax): ${listNames(missingSameSite)}.`,
      recommendation: 'Set SameSite=Lax or Strict explicitly.',
    });
  }
  if (penalty === 0) {
    items.push({
      id: 'sec-cookie-ok',
      title: 'Cookie Flags Configured',
      status: 'pass',
      description: `All ${cookies.length} cookies set Secure and HttpOnly.`,
    });
  }
  return Math.min(COOKIE_PENALTY_CAP, penalty);
}

/**
 * Audits HTTP security headers, protocol, and cookies.
 * @param headers Response headers map (lower-case keys)
 * @param cookies Parsed cookies
 * @param targetUrl Final URL
 * @returns SecurityAuditResult
 */
export function auditSecurity(
  headers: Record<string, string>,
  cookies: ParsedCookie[],
  targetUrl: string,
): SecurityAuditResult {
  const items: AuditItem[] = [];
  const isHttps = targetUrl.startsWith('https://');
  const hsts = headers['strict-transport-security'];
  let penalty = checkTransportSecurity(isHttps, hsts, items);
  const csp = checkCsp(headers, items);
  penalty += csp.penalty;
  penalty += checkFraming(headers, csp.policies, items);
  penalty += checkMimeAndReferrer(headers, items);
  penalty += checkCookies(cookies, isHttps, items);

  const score = penaltyToScore(penalty);
  return {
    url: targetUrl,
    timestamp: new Date().toISOString(),
    score,
    rating: scoreToRating(score),
    items,
    isHttps,
    hstsHeader: hsts,
    hstsMaxAge: hsts ? parseHsts(hsts).maxAge : undefined,
    cspHeader: headers['content-security-policy'],
    cspReportOnlyHeader: headers['content-security-policy-report-only'],
    xFrameOptions: headers['x-frame-options'],
    xContentTypeOptions: headers['x-content-type-options'],
    referrerPolicy: headers['referrer-policy'],
    permissionsPolicy: headers['permissions-policy'],
    cookieFlags: cookies.map((c) => ({
      name: c.name,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
    })),
  };
}
