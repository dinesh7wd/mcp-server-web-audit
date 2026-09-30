import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LookupAddress } from 'node:dns';
import { ErrorCodes } from '../../src/errors.js';
import { createPinnedLookup, safeFetch } from '../../src/fetcher.js';
import { isBlockedIp } from '../../src/ip.js';
import type { NetworkPolicy } from '../../src/types.js';
import { TestServer, startTestServer, testPolicy } from '../helpers.js';

let server: TestServer;
let closedPort: number;

beforeAll(async () => {
  server = await startTestServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'final=1; Secure; HttpOnly' });
      res.end('<html><title>ok</title></html>');
    } else if (url === '/hop') {
      res.writeHead(302, { Location: '/ok', 'Set-Cookie': 'hop=1' });
      res.end('redirect body that must not be read');
    } else if (url === '/to-private') {
      res.writeHead(302, { Location: 'http://internal.test/admin' });
      res.end();
    } else if (url === '/to-metadata') {
      res.writeHead(301, { Location: 'http://[::ffff:169.254.169.254]/latest/meta-data/' });
      res.end();
    } else if (url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    } else if (url === '/no-location') {
      res.writeHead(302);
      res.end();
    } else if (url === '/big-declared') {
      res.writeHead(200, { 'Content-Length': String(10_000) });
      res.end('x'.repeat(10_000));
    } else if (url === '/big-streamed') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const chunk = 'y'.repeat(1024);
      let sent = 0;
      const push = () => {
        while (sent < 64) {
          sent++;
          if (!res.write(chunk)) {
            res.once('drain', push);
            return;
          }
        }
        res.end();
      };
      push();
    } else if (url === '/hang') {
      // never respond
    } else {
      res.writeHead(404);
      res.end('missing');
    }
  });
  const temp = await startTestServer(() => undefined);
  closedPort = temp.port;
  await temp.close();
});

afterAll(async () => {
  await server.close();
});

describe('safeFetch', () => {
  it('follows same-origin redirects, collects cookies from every hop and reports timing', async () => {
    const res = await safeFetch(server.url('/hop'), { policy: testPolicy() });
    expect(res.status).toBe(200);
    expect(res.redirectCount).toBe(1);
    expect(res.finalUrl).toBe(server.url('/ok'));
    expect(res.body).toContain('<title>ok</title>');
    expect(res.contentType).toBe('text/html');
    expect(res.setCookies).toEqual(['hop=1', 'final=1; Secure; HttpOnly']);
    expect(res.timing.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('returns non-2xx responses with their status', async () => {
    const res = await safeFetch(server.url('/nope'), { policy: testPolicy() });
    expect(res.status).toBe(404);
  });

  it('rejects redirects to hosts resolving to private addresses without leaking the IP', async () => {
    await expect(safeFetch(server.url('/to-private'), { policy: testPolicy() })).rejects.toSatisfy(
      (err: { code: string; message: string }) =>
        err.code === ErrorCodes.SSRF_BLOCKED && err.message.startsWith('Redirect target rejected') && !err.message.includes('10.0.0.5'),
    );
  });

  it('rejects redirects to IPv4-mapped metadata literals', async () => {
    await expect(safeFetch(server.url('/to-metadata'), { policy: testPolicy() })).rejects.toMatchObject({
      code: ErrorCodes.SSRF_BLOCKED,
    });
  });

  it('enforces the redirect limit', async () => {
    await expect(safeFetch(server.url('/loop'), { policy: testPolicy(), maxRedirects: 2 })).rejects.toMatchObject({
      code: ErrorCodes.TooManyRedirects,
    });
  });

  it('fails on redirects without Location', async () => {
    await expect(safeFetch(server.url('/no-location'), { policy: testPolicy() })).rejects.toMatchObject({
      code: ErrorCodes.FetchFailed,
    });
  });

  it('enforces the size cap for declared and streamed bodies', async () => {
    await expect(
      safeFetch(server.url('/big-declared'), { policy: testPolicy(), maxSizeBytes: 1024 }),
    ).rejects.toMatchObject({ code: ErrorCodes.ResponseTooLarge });
    await expect(
      safeFetch(server.url('/big-streamed'), { policy: testPolicy(), maxSizeBytes: 4096 }),
    ).rejects.toMatchObject({ code: ErrorCodes.ResponseTooLarge });
  });

  it('times out slow responses', async () => {
    await expect(safeFetch(server.url('/hang'), { policy: testPolicy(), timeoutMs: 150 })).rejects.toMatchObject({
      code: ErrorCodes.Timeout,
    });
  });

  it('honours caller cancellation', async () => {
    const controller = new AbortController();
    const pending = safeFetch(server.url('/hang'), { policy: testPolicy(), signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.Cancelled });
  });

  it('maps connection errors to FETCH_FAILED', async () => {
    await expect(
      safeFetch(`http://site.test:${closedPort}/`, { policy: testPolicy(), timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: ErrorCodes.FetchFailed });
  });

  it('pins connections to validated addresses (DNS rebinding regression)', async () => {
    let calls = 0;
    const rebinding: NetworkPolicy = {
      lookup: async () => {
        calls++;
        return [{ address: calls === 1 ? '93.184.215.14' : '10.0.0.5', family: 4 }];
      },
      isAddressBlocked: isBlockedIp,
    };
    await expect(safeFetch('http://rebind.test/', { policy: rebinding })).rejects.toMatchObject({
      code: ErrorCodes.SSRF_BLOCKED,
    });
    expect(calls).toBe(2);
  });
});

describe('createPinnedLookup', () => {
  const policy: NetworkPolicy = {
    lookup: async (host) =>
      host === 'dual.test'
        ? [
            { address: '2606:4700::1', family: 6 },
            { address: '93.184.215.14', family: 4 },
          ]
        : host === 'empty.test'
          ? []
          : Promise.reject(new Error('boom')),
    isAddressBlocked: isBlockedIp,
  };

  const run = (host: string, options: { all?: boolean; family?: number }) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }>((resolve) => {
      createPinnedLookup(policy)(host, options, (err, address, family) => resolve({ err, address, family }));
    });

  it('returns all validated addresses or the first one', async () => {
    expect((await run('dual.test', { all: true })).address).toHaveLength(2);
    const single = await run('dual.test', {});
    expect(single.address).toBe('2606:4700::1');
    expect(single.family).toBe(6);
    expect((await run('dual.test', { family: 4 })).address).toBe('93.184.215.14');
  });

  it('fails for empty answers and lookup errors', async () => {
    expect((await run('empty.test', {})).err).toMatchObject({ code: ErrorCodes.DnsFailed });
    expect((await run('error.test', {})).err).toMatchObject({ code: ErrorCodes.DnsFailed });
  });
});
