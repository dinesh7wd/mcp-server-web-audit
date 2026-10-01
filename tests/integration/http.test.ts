import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpConfig, assertHttpConfig, loadConfig } from '../../src/config.js';
import { isValidBearer, startHttpServer } from '../../src/httpServer.js';
import { rawRequest } from '../helpers.js';

const TOKEN = 'test-token-'.padEnd(40, 'x');
const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});

function httpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  const base = loadConfig({ TRANSPORT: 'http', MCP_AUTH_TOKEN: TOKEN, PORT: '0' }).http;
  return { ...base, port: 0, allowedOrigins: ['http://allowed.test'], ...overrides };
}

async function start(overrides: Partial<HttpConfig> = {}): Promise<{ server: Server; port: number }> {
  const server = await startHttpServer(httpConfig(overrides));
  return { server, port: (server.address() as AddressInfo).port };
}

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

describe('HTTP transport security (H4/H5)', () => {
  let server: Server;
  let port: number;
  const host = () => `127.0.0.1:${port}`;
  const post = (headers: Record<string, string>, body = INIT) =>
    rawRequest(port, {
      method: 'POST',
      path: '/mcp',
      headers: { Host: host(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body,
    });

  beforeAll(async () => {
    ({ server, port } = await start());
  });

  afterAll(async () => {
    await close(server);
  });

  it('serves /health without auth', async () => {
    const res = await rawRequest(port, { path: '/health', headers: { Host: host() } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('accepts a valid initialize request', async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.body).toContain('mcp-server-web-audit');
  });

  it('rejects missing or wrong bearer tokens with 401', async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('rejects DNS-rebinding Host headers with 403', async () => {
    const res = await post({ Authorization: `Bearer ${TOKEN}`, Host: 'evil.test' });
    expect(res.status).toBe(403);
  });

  it('rejects disallowed Origins and answers allowed preflights', async () => {
    const bad = await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.test' });
    expect(bad.status).toBe(403);
    const preflight = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/mcp',
      headers: { Host: host(), Origin: 'http://allowed.test', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://allowed.test');
    expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');
    const ok = await post({ Authorization: `Bearer ${TOKEN}`, Origin: 'http://allowed.test' });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://allowed.test');
  });

  it('returns 405 for GET/DELETE and JSON-RPC errors for bad bodies', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const get = await rawRequest(port, { path: '/mcp', headers: { Host: host(), ...auth } });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    const del = await rawRequest(port, { method: 'DELETE', path: '/mcp', headers: { Host: host(), ...auth } });
    expect(del.status).toBe(405);
    expect((await post(auth, '{not json')).status).toBe(400);
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'a'.repeat(300 * 1024) } });
    expect((await post(auth, huge)).status).toBe(413);
  });
});

describe('HTTP rate limiting', () => {
  it('limits failed authentication attempts separately', async () => {
    const { server, port } = await start({ authFailMax: 2, rateLimitMax: 100 });
    try {
      const attempt = (auth?: string) =>
        rawRequest(port, {
          method: 'POST',
          path: '/mcp',
          headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
          body: INIT,
        });
      expect((await attempt('Bearer bad')).status).toBe(401);
      expect((await attempt('Bearer bad')).status).toBe(401);
      const limited = await attempt('Bearer bad');
      expect(limited.status).toBe(429);
      expect(limited.body).toContain('Too many failed authentication attempts');
      expect((await attempt(`Bearer ${TOKEN}`)).status).toBe(429);
    } finally {
      await close(server);
    }
  });

  it('limits requests per IP before authentication', async () => {
    const { server, port } = await start({ rateLimitMax: 2, authFailMax: 100 });
    try {
      const attempt = () =>
        rawRequest(port, { method: 'POST', path: '/mcp', headers: { Host: `127.0.0.1:${port}` }, body: INIT });
      await attempt();
      await attempt();
      const res = await attempt();
      expect(res.status).toBe(429);
      expect(res.body).toContain('RATE_LIMITED');
    } finally {
      await close(server);
    }
  });

  it('caps total traffic even when X-Forwarded-For rotates (M5)', async () => {
    const { server, port } = await start({ rateLimitMax: 1, authFailMax: 100, trustProxy: true });
    try {
      const attempt = (i: number) =>
        rawRequest(port, {
          method: 'POST',
          path: '/mcp',
          headers: { Host: `127.0.0.1:${port}`, 'X-Forwarded-For': `203.0.113.${i}` },
          body: INIT,
        });
      for (let i = 1; i <= 10; i++) expect((await attempt(i)).status).toBe(401);
      expect((await attempt(11)).status).toBe(429);
    } finally {
      await close(server);
    }
  });
});

describe('HTTP helpers', () => {
  it('compares bearer tokens safely', () => {
    expect(isValidBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isValidBearer(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isValidBearer(undefined, TOKEN)).toBe(false);
    expect(isValidBearer('Bearer ', '')).toBe(false);
    expect(isValidBearer(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isValidBearer(`BEARER  ${TOKEN}`, TOKEN)).toBe(true);
    expect(isValidBearer(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isValidBearer(TOKEN, TOKEN)).toBe(false);
  });

  it('refuses to start with weak or incomplete configuration', async () => {
    expect(() => assertHttpConfig(httpConfig({ authToken: 'short' }))).toThrow(/at least 32/);
    expect(() => assertHttpConfig(httpConfig({ host: '0.0.0.0', allowedHosts: [] }))).toThrow(/MCP_ALLOWED_HOSTS/);
    await expect(startHttpServer(httpConfig({ authToken: '' }))).rejects.toThrow();
  });

  it('rejects when the port is unavailable', async () => {
    const { server, port } = await start();
    try {
      await expect(startHttpServer(httpConfig({ port }))).rejects.toThrow();
    } finally {
      await close(server);
    }
  });
});
