import dns from 'node:dns/promises';
import { CONFIG } from './config.js';
import { AppError, ErrorCode, ErrorCodes, abortable } from './errors.js';
import { isBlockedIp, isIpLiteral, isLoopbackIp, stripIpDecorations } from './ip.js';
import { LookupFn, NetworkPolicy } from './types.js';

const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

export const defaultLookup: LookupFn = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export const defaultNetworkPolicy: NetworkPolicy = {
  lookup: defaultLookup,
  isAddressBlocked: isBlockedIp,
};

/**
 * Lower-cases a hostname and strips brackets and trailing dots.
 * @param hostname Raw hostname
 * @returns Normalized hostname
 */
export function normalizeHostname(hostname: string): string {
  return stripIpDecorations(hostname).toLowerCase().replace(/\.+$/, '');
}

export function isLocalhost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIpLiteral(host) && isLoopbackIp(host);
}

/**
 * Returns true for private/reserved IP literals and known cloud-metadata hostnames.
 * Ordinary hostnames are never classified by string prefix.
 * @param hostname Hostname or IP literal
 * @returns boolean
 */
export function isPrivateIP(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (isIpLiteral(host)) return isBlockedIp(host);
  return BLOCKED_HOSTNAMES.has(host);
}

export function sanitizeUrl(raw: string): URL | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function matchesDomainList(url: URL, list: string[]): boolean {
  const host = normalizeHostname(url.hostname);
  return list.some((d) => host === d || host.endsWith('.' + d));
}

export function isAllowedDomain(url: URL): boolean {
  const allowed = CONFIG.security.allowedDomains;
  return allowed.length === 0 || matchesDomainList(url, allowed);
}

export function isBlockedDomain(url: URL): boolean {
  const blocked = CONFIG.security.blockedDomains;
  return blocked.length > 0 && matchesDomainList(url, blocked);
}

export type UrlValidation =
  | { valid: true; url: URL }
  | { valid: false; code: ErrorCode; message: string; error: string };

const SSRF_LOCALHOST = 'Access to localhost and loopback addresses is forbidden.';
const SSRF_PRIVATE = 'Access to private, reserved or link-local addresses is forbidden (SSRF protection).';

function invalid(code: ErrorCode, message: string): UrlValidation {
  return { valid: false, code, message, error: `${code}: ${message}` };
}

function checkUrlPolicy(rawUrl: string): UrlValidation {
  const parsed = sanitizeUrl(rawUrl);
  if (!parsed) {
    return invalid(ErrorCodes.InvalidParams, 'Invalid URL. Only valid http:// and https:// URLs are allowed.');
  }
  if (parsed.username || parsed.password) {
    return invalid(ErrorCodes.InvalidParams, 'URLs with embedded credentials are not allowed.');
  }
  if (isBlockedDomain(parsed)) {
    return invalid(ErrorCodes.PolicyBlocked, `Domain ${parsed.hostname} is blocked by server security policy.`);
  }
  if (!isAllowedDomain(parsed)) {
    return invalid(ErrorCodes.PolicyBlocked, `Domain ${parsed.hostname} is not in the configured domain allowlist.`);
  }
  return { valid: true, url: parsed };
}

/**
 * Synchronous policy checks (scheme, credentials, localhost, literal private IPs, allow/block lists).
 * Does not perform DNS — use {@link validateAuditUrl} for full SSRF protection.
 */
export function validateAuditUrlSync(rawUrl: string): UrlValidation {
  const policy = checkUrlPolicy(rawUrl);
  if (!policy.valid) return policy;
  if (isLocalhost(policy.url.hostname)) return invalid(ErrorCodes.SSRF_BLOCKED, SSRF_LOCALHOST);
  if (isPrivateIP(policy.url.hostname)) return invalid(ErrorCodes.SSRF_BLOCKED, SSRF_PRIVATE);
  return policy;
}

/**
 * Rejects hosts that are, or resolve to, blocked addresses. Resolved addresses
 * are never included in error messages.
 * @param hostname Hostname or IP literal
 * @param policy Network policy (lookup + address classifier)
 * @param signal Optional abort signal (bounds DNS time)
 */
export async function assertPublicHost(
  hostname: string,
  policy: NetworkPolicy = defaultNetworkPolicy,
  signal?: AbortSignal,
): Promise<void> {
  const host = normalizeHostname(hostname);
  if (isIpLiteral(host)) {
    if (policy.isAddressBlocked(host)) throw new AppError(ErrorCodes.SSRF_BLOCKED, SSRF_PRIVATE);
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new AppError(ErrorCodes.SSRF_BLOCKED, SSRF_LOCALHOST);
  }
  if (BLOCKED_HOSTNAMES.has(host)) throw new AppError(ErrorCodes.SSRF_BLOCKED, SSRF_PRIVATE);

  let addresses;
  try {
    addresses = await abortable(policy.lookup(host), signal);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(ErrorCodes.DnsFailed, `DNS resolution failed for host ${host}`);
  }
  if (addresses.length === 0) {
    throw new AppError(ErrorCodes.DnsFailed, `No DNS records for host ${host}`);
  }
  if (addresses.some((a) => policy.isAddressBlocked(a.address))) {
    throw new AppError(ErrorCodes.SSRF_BLOCKED, `Host ${host} resolves to a private or reserved address.`);
  }
}

/**
 * Full SSRF-hardened URL validation including DNS resolution.
 * Re-run on every redirect hop; connections are additionally pinned by the fetcher.
 */
export async function validateAuditUrl(
  rawUrl: string,
  options: { policy?: NetworkPolicy; signal?: AbortSignal } = {},
): Promise<UrlValidation> {
  const policy = checkUrlPolicy(rawUrl);
  if (!policy.valid) return policy;

  try {
    await assertPublicHost(policy.url.hostname, options.policy, options.signal);
  } catch (err) {
    if (err instanceof AppError) return invalid(err.code, err.message);
    return invalid(ErrorCodes.SSRF_BLOCKED, 'DNS validation failed');
  }
  return policy;
}
