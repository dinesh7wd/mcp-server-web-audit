import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config.js';
import {
  clearRobotsCache,
  getRobotsRules,
  isAllowedByRobots,
  parseRobotsTxt,
  pathAllowed,
  productToken,
} from '../../src/robots.js';
import { TestServer, startTestServer, testPolicy } from '../helpers.js';

const UA = 'mcp-server-web-audit/0.1.0';

describe('robots parser', () => {
  it('uses the group matching the product token, sharing consecutive user-agent lines', () => {
    const body = `
User-agent: *
Disallow: /admin
Allow: /admin/public

User-agent: other-bot
User-agent: MCP-Server-Web-Audit
Disallow: /private # comment
`;
    const rules = parseRobotsTxt(body, UA);
    expect(rules).toEqual([{ allow: false, pattern: '/private' }]);
    expect(pathAllowed('/private/x', rules)).toBe(false);
    expect(pathAllowed('/admin', rules)).toBe(true);
  });

  it('falls back to * and applies longest match with allow winning ties', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /admin\nAllow: /admin/public\nDisallow: /tie\nAllow: /tie', UA);
    expect(pathAllowed('/admin/secret', rules)).toBe(false);
    expect(pathAllowed('/admin/public/page', rules)).toBe(true);
    expect(pathAllowed('/tie', rules)).toBe(true);
  });

  it('supports * wildcards and $ anchors', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?*q=', UA);
    expect(pathAllowed('/files/report.pdf', rules)).toBe(false);
    expect(pathAllowed('/files/report.pdf?download=1', rules)).toBe(true);
    expect(pathAllowed('/search?lang=en&q=test', rules)).toBe(false);
    expect(pathAllowed('/', 'disallow-all')).toBe(false);
  });

  it('treats empty Disallow as allow-all and extracts product tokens', () => {
    expect(pathAllowed('/anything', parseRobotsTxt('User-agent: *\nDisallow:\n', UA))).toBe(true);
    expect(productToken('Mozilla/5.0 (X11)')).toBe('mozilla');
  });
});

describe('robots fetching', () => {
  let server: TestServer;
  let mode: 'rules' | 'missing' | 'error' | 'redirect-private' = 'rules';
  let hits = 0;
  const originalUa = CONFIG.network.userAgent;

  beforeAll(async () => {
    CONFIG.network.userAgent = UA;
    server = await startTestServer((req, res) => {
      hits++;
      if (mode === 'rules') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('User-agent: *\nDisallow: /blocked');
      } else if (mode === 'missing') {
        res.writeHead(404);
        res.end();
      } else if (mode === 'error') {
        res.writeHead(503);
        res.end();
      } else {
        res.writeHead(302, { Location: 'http://internal.test/robots.txt' });
        res.end();
      }
    });
  });

  afterAll(async () => {
    CONFIG.network.userAgent = originalUa;
    await server.close();
  });

  beforeEach(() => {
    clearRobotsCache();
    hits = 0;
  });

  const opts = () => ({ policy: testPolicy() });

  it('fetches, parses and caches rules through safeFetch', async () => {
    mode = 'rules';
    expect(await isAllowedByRobots(server.url('/blocked/page'), opts())).toBe(false);
    expect(await isAllowedByRobots(server.url('/open'), opts())).toBe(true);
    expect(hits).toBe(1);
  });

  it('treats 4xx as allow-all and 5xx as disallow-all (RFC 9309)', async () => {
    mode = 'missing';
    expect(await getRobotsRules(server.url('/'), opts())).toEqual([]);
    clearRobotsCache();
    mode = 'error';
    expect(await getRobotsRules(server.url('/'), opts())).toBe('disallow-all');
  });

  it('treats unreachable robots.txt (incl. SSRF-blocked redirects) as disallow-all', async () => {
    mode = 'redirect-private';
    expect(await getRobotsRules(server.url('/'), opts())).toBe('disallow-all');
  });

  it('rethrows when the caller aborted', async () => {
    mode = 'rules';
    const controller = new AbortController();
    controller.abort();
    await expect(getRobotsRules(server.url('/'), { ...opts(), signal: controller.signal })).rejects.toBeDefined();
  });
});
