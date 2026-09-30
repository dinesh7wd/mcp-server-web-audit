import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isBlockedIp } from '../src/ip.js';
import type { FetchResult, NetworkPolicy } from '../src/types.js';

export interface TestServer {
  port: number;
  url: (path: string, host?: string) => string;
  close: () => Promise<void>;
}

/**
 * Starts an HTTP server on 127.0.0.1 with an ephemeral port.
 */
export async function startTestServer(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: (path, host = 'site.test') => `http://${host}:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Test policy: `site.test` → 127.0.0.1 (allowed only for tests), `internal.test` → 10.0.0.5 (blocked).
 */
export function testPolicy(extra: Record<string, string> = {}): NetworkPolicy {
  const table: Record<string, string> = { 'site.test': '127.0.0.1', 'internal.test': '10.0.0.5', ...extra };
  return {
    lookup: async (hostname) => {
      const address = table[hostname];
      if (!address) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return [{ address, family: address.includes(':') ? 6 : 4 }];
    },
    isAddressBlocked: (ip) => ip !== '127.0.0.1' && isBlockedIp(ip),
  };
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Minimal HTTP client with full header control (including Host).
 */
export function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export function fetchResultFixture(overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/html; charset=utf-8' },
    setCookies: [],
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="en"><head><title>Example page title for testing SEO audits</title></head><body><main><h1>Hi</h1></main></body></html>',
    finalUrl: 'https://example.com/',
    timing: { ttfbMs: 100, downloadMs: 10, totalMs: 110 },
    redirectCount: 0,
    ...overrides,
  };
}
