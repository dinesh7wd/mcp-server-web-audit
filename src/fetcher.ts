import type { LookupAddress as DnsLookupAddress, LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, fetch, type Response } from 'undici';
import { CONFIG } from './config.js';
import { AppError, ErrorCodes, abortToAppError } from './errors.js';
import { FetchOptions, FetchResult, NetworkPolicy } from './types.js';
import { defaultNetworkPolicy, validateAuditUrl } from './validators.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | DnsLookupAddress[], family?: number) => void;

/**
 * Builds a `net.connect` lookup that resolves through the policy and refuses to
 * connect when any resolved address is blocked. Because the socket connects to
 * the address validated here, DNS rebinding between check and connect is impossible.
 * @param policy Network policy
 * @returns LookupFunction for undici `connect.lookup`
 */
export function createPinnedLookup(policy: NetworkPolicy): LookupFunction {
  return (hostname: string, options: LookupOptions, callback: LookupCallback) => {
    policy
      .lookup(hostname)
      .then((resolved) => {
        if (resolved.some((a) => policy.isAddressBlocked(a.address))) {
          throw new AppError(ErrorCodes.SSRF_BLOCKED, `Host ${hostname} resolves to a private or reserved address.`);
        }
        const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
        const addresses = wanted ? resolved.filter((a) => a.family === wanted) : resolved;
        if (addresses.length === 0) {
          throw new AppError(ErrorCodes.DnsFailed, `No usable DNS records for host ${hostname}`);
        }
        if (options.all) {
          callback(null, addresses as DnsLookupAddress[]);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      })
      .catch((err: unknown) => {
        const error = err instanceof AppError ? err : new AppError(ErrorCodes.DnsFailed, `DNS resolution failed for host ${hostname}`);
        callback(error as unknown as NodeJS.ErrnoException, '', 0);
      });
  };
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError(ErrorCodes.ResponseTooLarge, `Response body exceeded the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks, totalBytes));
}

function normalizeHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function toFetchError(err: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal, timeoutMs: number): AppError {
  if (err instanceof AppError) return err;
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause instanceof AppError) return cause;
  if (callerSignal?.aborted) return abortToAppError(callerSignal);
  if (timeoutSignal.aborted) return new AppError(ErrorCodes.Timeout, `Request timed out after ${timeoutMs}ms`);
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return new AppError(ErrorCodes.FetchFailed, `Failed to fetch target${code ? ` (${code})` : ''}`);
}

/**
 * Safe fetch with timeouts, manual redirect handling with per-hop SSRF + DNS
 * re-validation, DNS-pinned connections, and a streamed body size limit.
 */
export async function safeFetch(initialUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  const policy = options.policy ?? defaultNetworkPolicy;
  const timeoutMs = Math.min(options.timeoutMs ?? CONFIG.network.defaultTimeoutMs, CONFIG.network.maxTimeoutMs);
  const maxRedirects = options.maxRedirects ?? CONFIG.network.maxRedirects;
  const maxBytes = options.maxSizeBytes ?? CONFIG.network.maxSizeBytes;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const agent = new Agent({ connect: { lookup: createPinnedLookup(policy) } });
  const setCookies: string[] = [];
  let currentUrl = initialUrl;
  let redirectCount = 0;

  try {
    while (true) {
      const validation = await validateAuditUrl(currentUrl, { policy, signal });
      if (!validation.valid) {
        const prefix = redirectCount > 0 ? 'Redirect target rejected: ' : '';
        throw new AppError(validation.code, `${prefix}${validation.message}`);
      }

      const startTime = performance.now();
      const response = await fetch(validation.url.href, {
        method: 'GET',
        redirect: 'manual',
        signal,
        dispatcher: agent,
        headers: {
          'User-Agent': options.userAgent || CONFIG.network.userAgent,
          Accept: options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const ttfbEnd = performance.now();
      setCookies.push(...response.headers.getSetCookie());

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) {
          throw new AppError(ErrorCodes.FetchFailed, `Redirect response (${response.status}) without Location header`);
        }
        if (redirectCount >= maxRedirects) {
          throw new AppError(ErrorCodes.TooManyRedirects, `Exceeded maximum redirect limit of ${maxRedirects} hops`);
        }
        currentUrl = new URL(location, validation.url).href;
        redirectCount++;
        continue;
      }

      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new AppError(ErrorCodes.ResponseTooLarge, `Response body exceeded the ${maxBytes} byte limit`);
      }

      const body = await readLimitedBody(response, maxBytes);
      const totalEnd = performance.now();
      const headers = normalizeHeaders(response);

      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        setCookies,
        contentType: headers['content-type'],
        body,
        finalUrl: validation.url.href,
        timing: {
          ttfbMs: Math.round(ttfbEnd - startTime),
          downloadMs: Math.round(totalEnd - ttfbEnd),
          totalMs: Math.round(totalEnd - startTime),
        },
        redirectCount,
      };
    }
  } catch (err: unknown) {
    throw toFetchError(err, options.signal, timeoutSignal, timeoutMs);
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}
