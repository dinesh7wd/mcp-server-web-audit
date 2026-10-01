import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CONFIG, HttpConfig, assertHttpConfig } from './config.js';
import { AppError, ErrorCodes } from './errors.js';
import { logError, logInfo, logWarn } from './logger.js';
import { RateLimiter } from './rateLimit.js';
import { createMcpServer } from './server.js';

const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type, Accept, mcp-protocol-version, mcp-session-id, last-event-id';

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Constant-time comparison of an Authorization header against the expected bearer token.
 * @param header Authorization header value
 * @param token Expected token
 * @returns boolean
 */
export function isValidBearer(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !token) return false;
  const match = /^bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return timingSafeEqual(digest(match ? match[1] : ''), digest(token));
}

/**
 * Rejects browser requests from origins not in the allowlist and emits CORS headers for allowed ones.
 * Requests without an Origin header (non-browser MCP clients) pass through.
 */
function originGuard(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    if (!allowedOrigins.includes(origin.toLowerCase())) {
      jsonRpcError(res, 403, -32000, 'Origin not allowed');
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/**
 * Every client also counts against one shared bucket, so rotating source addresses (or spoofed
 * X-Forwarded-For values behind a misconfigured TRUST_PROXY) cannot multiply the request budget.
 */
const GLOBAL_RATE_MULTIPLIER = 10;
const GLOBAL_KEY = 'global';

function rateLimit(limiter: RateLimiter, globalLimiter: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      globalLimiter.check(GLOBAL_KEY);
      limiter.check(`ip:${clientIp(req)}`);
      next();
    } catch (err) {
      const message = err instanceof AppError ? err.toClientMessage() : 'Rate limit exceeded';
      jsonRpcError(res, 429, -32029, message);
    }
  };
}

function requireBearer(token: string, failures: RateLimiter, globalFailures: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `ip:${clientIp(req)}`;
    if (failures.isLimited(key) || globalFailures.isLimited(GLOBAL_KEY)) {
      jsonRpcError(res, 429, -32029, `${ErrorCodes.RateLimited}: Too many failed authentication attempts`);
      return;
    }
    if (!isValidBearer(req.headers.authorization, token)) {
      try {
        globalFailures.check(GLOBAL_KEY);
        failures.check(key);
      } catch {
        logWarn('Authentication failure limit reached', { ip: clientIp(req) });
      }
      jsonRpcError(res, 401, -32001, `${ErrorCodes.AuthRequired}: Bearer token required`);
      return;
    }
    next();
  };
}

function bodyErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = (err as { status?: number }).status;
  if (status === 413) {
    jsonRpcError(res, 413, -32600, 'Request body too large');
  } else if (status === 400) {
    jsonRpcError(res, 400, -32700, 'Parse error');
  } else {
    logError('HTTP request failed', { error: String(err) });
    jsonRpcError(res, 500, -32603, 'Internal server error');
  }
}

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch((e: unknown) => logWarn('MCP transport close failed', { error: String(e) }));
    server.close().catch((e: unknown) => logWarn('MCP server close failed', { error: String(e) }));
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    logError('HTTP MCP request failed', { error: String(e) });
    if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
  }
}

/**
 * Builds the Streamable HTTP (stateless) Express app.
 * Order on /mcp: Host validation → Origin/CORS → per-IP rate limit → bearer auth (with failure limit) → JSON body.
 * @param http HTTP configuration
 * @returns Express app
 */
export function createHttpApp(http: HttpConfig): Express {
  assertHttpConfig(http);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', http.trustProxy);

  const requestLimiter = new RateLimiter(http.rateLimitWindowMs, http.rateLimitMax);
  const authFailureLimiter = new RateLimiter(http.rateLimitWindowMs, http.authFailMax);
  const globalRequestLimiter = new RateLimiter(http.rateLimitWindowMs, http.rateLimitMax * GLOBAL_RATE_MULTIPLIER);
  const globalAuthFailureLimiter = new RateLimiter(http.rateLimitWindowMs, http.authFailMax * GLOBAL_RATE_MULTIPLIER);

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(
    '/mcp',
    hostHeaderValidation(http.allowedHosts),
    originGuard(http.allowedOrigins),
    rateLimit(requestLimiter, globalRequestLimiter),
    requireBearer(http.authToken, authFailureLimiter, globalAuthFailureLimiter),
    express.json({ limit: http.bodyLimit }),
  );

  app.post('/mcp', (req, res) => {
    void handleMcpPost(req, res);
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed: use POST (stateless Streamable HTTP)');
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.use(bodyErrorHandler);
  return app;
}

/**
 * Starts the HTTP transport.
 * @param http HTTP configuration (defaults to env-derived CONFIG.http)
 * @returns Listening node HTTP server
 */
export async function startHttpServer(http: HttpConfig = CONFIG.http): Promise<HttpServer> {
  const app = createHttpApp(http);
  return new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(http.port, http.host);
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      logInfo('mcp-server-web-audit listening (Streamable HTTP)', { host: http.host, port: http.port, path: '/mcp' });
      resolve(server);
    });
  });
}
