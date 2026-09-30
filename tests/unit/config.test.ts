import { describe, expect, it } from 'vitest';
import { MIN_AUTH_TOKEN_LENGTH, isLoopbackBindHost, loadConfig, parseNumber } from '../../src/config.js';

const TOKEN = 'x'.repeat(MIN_AUTH_TOKEN_LENGTH);

describe('config', () => {
  it('applies defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.transport).toBe('stdio');
    expect(cfg.http.host).toBe('127.0.0.1');
    expect(cfg.http.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(cfg.http.trustProxy).toBe(false);
    expect(cfg.network.respectRobotsTxt).toBe(false);
    expect(cfg.network.totalTimeoutMs).toBe(45_000);
    expect(cfg.network.userAgent).toMatch(/^mcp-server-web-audit\/\d/);
  });

  it('keeps explicit zeros and rejects invalid numbers (L4)', () => {
    const cfg = loadConfig({ AUDIT_MAX_REDIRECTS: '0', RATE_LIMIT_MAX: '0', AUDIT_CACHE_TTL_MS: '0', AUDIT_TIMEOUT_MS: 'abc' });
    expect(cfg.network.maxRedirects).toBe(0);
    expect(cfg.http.rateLimitMax).toBe(0);
    expect(cfg.cache.ttlMs).toBe(0);
    expect(cfg.network.defaultTimeoutMs).toBe(15_000);
    expect(parseNumber('99999', 1, 0, 30_000)).toBe(30_000);
    expect(parseNumber('-1', 7)).toBe(7);
  });

  it('parses booleans, trust proxy and origins', () => {
    const cfg = loadConfig({
      RESPECT_ROBOTS_TXT: 'true',
      TRUST_PROXY: '1',
      MCP_ALLOWED_ORIGINS: 'https://App.Example.com/, http://localhost:5173',
    });
    expect(cfg.network.respectRobotsTxt).toBe(true);
    expect(cfg.http.trustProxy).toBe(1);
    expect(cfg.http.allowedOrigins).toEqual(['https://app.example.com', 'http://localhost:5173']);
    expect(loadConfig({ TRUST_PROXY: 'true' }).http.trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: 'loopback' }).http.trustProxy).toBe('loopback');
    expect(() => loadConfig({ MCP_ALLOWED_ORIGINS: 'not a url' })).toThrow(/Invalid origin/);
  });

  it('validates transport and HTTP security settings', () => {
    expect(() => loadConfig({ TRANSPORT: 'sse' })).toThrow(/Invalid TRANSPORT/);
    expect(() => loadConfig({ TRANSPORT: 'http' })).toThrow(/MCP_AUTH_TOKEN is required/);
    expect(() => loadConfig({ TRANSPORT: 'http', MCP_AUTH_TOKEN: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ TRANSPORT: 'http', MCP_AUTH_TOKEN: TOKEN, HOST: '0.0.0.0' })).toThrow(/MCP_ALLOWED_HOSTS/);
    const cfg = loadConfig({ TRANSPORT: 'http', MCP_AUTH_TOKEN: TOKEN, HOST: '0.0.0.0', MCP_ALLOWED_HOSTS: 'audit.example.com' });
    expect(cfg.http.allowedHosts).toEqual(['audit.example.com']);
    expect(isLoopbackBindHost('::1')).toBe(true);
    expect(isLoopbackBindHost('0.0.0.0')).toBe(false);
  });
});
