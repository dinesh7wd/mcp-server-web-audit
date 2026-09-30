import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const MIN_AUTH_TOKEN_LENGTH = 32;
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_LOOPBACK_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

type Env = Record<string, string | undefined>;

/**
 * Splits a comma-separated env value into trimmed, lower-cased entries.
 * @param raw Env value
 * @returns string[]
 */
function parseList(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Parses a numeric env value, keeping 0 when allowed and falling back on invalid input.
 * @param raw Env value
 * @param fallback Default when unset/invalid
 * @param min Minimum accepted value
 * @param max Optional maximum (values are clamped)
 * @returns number
 */
export function parseNumber(raw: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw.trim() === '' || raw.trim().toLowerCase() === 'false') return false;
  if (raw.trim().toLowerCase() === 'true') return true;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : raw.trim();
}

function parseOrigins(raw: string | undefined): string[] {
  const origins: string[] = [];
  for (const entry of parseList(raw)) {
    try {
      origins.push(new URL(entry).origin);
    } catch {
      throw new Error(`Invalid origin "${entry}" in MCP_ALLOWED_ORIGINS`);
    }
  }
  return origins;
}

export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.has(host.toLowerCase());
}

export interface HttpConfig {
  port: number;
  host: string;
  authToken: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  trustProxy: boolean | number | string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  authFailMax: number;
  bodyLimit: string;
}

/**
 * Validates HTTP transport settings.
 * @param http HTTP config
 * @throws Error when the configuration is unsafe
 */
export function assertHttpConfig(http: HttpConfig): void {
  if (!http.authToken) {
    throw new Error('MCP_AUTH_TOKEN is required when TRANSPORT=http');
  }
  if (http.authToken.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters`);
  }
  if (http.allowedHosts.length === 0) {
    throw new Error('MCP_ALLOWED_HOSTS is required when HOST is not a loopback address');
  }
}

/**
 * Builds the configuration object from environment variables.
 * @param env Environment map
 * @returns Parsed configuration
 */
export function loadConfig(env: Env = process.env) {
  const transport = (env.TRANSPORT || 'stdio').toLowerCase();
  if (transport !== 'stdio' && transport !== 'http') {
    throw new Error(`Invalid TRANSPORT="${transport}". Use "stdio" or "http".`);
  }

  const host = env.HOST?.trim() || '127.0.0.1';
  const configuredHosts = parseList(env.MCP_ALLOWED_HOSTS);
  const http: HttpConfig = {
    port: parseNumber(env.PORT, 3100, 0, 65535),
    host,
    authToken: env.MCP_AUTH_TOKEN || '',
    allowedHosts:
      configuredHosts.length > 0 ? configuredHosts : isLoopbackBindHost(host) ? DEFAULT_LOOPBACK_ALLOWED_HOSTS : [],
    allowedOrigins: parseOrigins(env.MCP_ALLOWED_ORIGINS),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimitWindowMs: parseNumber(env.RATE_LIMIT_WINDOW_MS, 60_000, 1000),
    rateLimitMax: parseNumber(env.RATE_LIMIT_MAX, 30, 0),
    authFailMax: parseNumber(env.AUTH_FAIL_RATE_LIMIT_MAX, 10, 0),
    bodyLimit: '256kb',
  };
  if (transport === 'http') assertHttpConfig(http);

  const maxTimeoutMs = 30_000;
  return {
    server: {
      name: 'mcp-server-web-audit',
      version: pkg.version,
    },
    transport: transport as 'stdio' | 'http',
    http,
    network: {
      defaultTimeoutMs: parseNumber(env.AUDIT_TIMEOUT_MS, 15_000, 1000, maxTimeoutMs),
      maxTimeoutMs,
      totalTimeoutMs: parseNumber(env.AUDIT_TOTAL_TIMEOUT_MS, 45_000, 5000, 300_000),
      maxRedirects: parseNumber(env.AUDIT_MAX_REDIRECTS, 5, 0, 10),
      maxSizeBytes: 5 * 1024 * 1024,
      robotsMaxSizeBytes: 512 * 1024,
      userAgent: env.AUDIT_USER_AGENT || `mcp-server-web-audit/${pkg.version}`,
      respectRobotsTxt: parseBool(env.RESPECT_ROBOTS_TXT, false),
    },
    cache: {
      ttlMs: parseNumber(env.AUDIT_CACHE_TTL_MS, 5 * 60 * 1000, 0),
      maxEntries: parseNumber(env.AUDIT_CACHE_MAX_ENTRIES, 100, 1),
    },
    security: {
      allowedDomains: parseList(env.AUDIT_ALLOWED_DOMAINS),
      blockedDomains: parseList(env.AUDIT_BLOCKED_DOMAINS),
    },
    /**
     * Optional Chrome UX Report API key (field data). Sent via X-Goog-Api-Key header.
     */
    cruxApiKey: env.CRUX_API_KEY || '',
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

export const CONFIG: AppConfig = loadConfig();
