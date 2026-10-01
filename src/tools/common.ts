import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { auditCache, cacheKeyFor } from '../cache.js';
import { CONFIG } from '../config.js';
import { AppError, ErrorCodes, abortable } from '../errors.js';
import { safeFetch } from '../fetcher.js';
import { logError, logInfo, logWarn, redactUrl } from '../logger.js';
import { ParsedHtml, parseHtml } from '../parsers.js';
import { isAllowedByRobots } from '../robots.js';
import { AuditFormat, FetchResult } from '../types.js';
import { validateAuditUrl } from '../validators.js';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface AuditArgs {
  url: string;
  format: AuditFormat;
}

/**
 * Builds a fresh input shape per tool (fresh instances avoid `$ref` in published JSON Schema).
 * @param purpose Tool-specific phrase appended to the url description
 * @returns Zod raw shape
 */
export function auditInputShape(purpose: string) {
  return {
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .describe(
        `Public http:// or https:// URL of the page to audit ${purpose}. Localhost, private, reserved and cloud-metadata addresses are rejected.`,
      ),
    format: z
      .enum(['markdown', 'json'])
      .default('markdown')
      .describe('Report format: "markdown" (human-readable, default) or "json" (structured data).'),
  };
}

export type AuditInputShape = ReturnType<typeof auditInputShape>;

export interface AuditTool {
  name: string;
  title: string;
  description: string;
  inputSchema: AuditInputShape;
  handler: (args: AuditArgs, extra?: ToolExtra) => Promise<CallToolResult>;
}

export const AUDIT_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
  idempotentHint: true,
  destructiveHint: false,
};

export class ValidationFailure extends AppError {}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * Runs tool work under one overall deadline (AUDIT_TOTAL_TIMEOUT_MS) combined with
 * client cancellation, converting failures into `isError` results.
 * @param label Human-readable audit label
 * @param rawUrl URL argument (logged without query string)
 * @param extra MCP request context
 * @param work Audit implementation
 * @returns Tool result
 */
export async function runAudit(
  label: string,
  rawUrl: string,
  extra: ToolExtra | undefined,
  work: (signal: AbortSignal) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const deadline = AbortSignal.timeout(CONFIG.network.totalTimeoutMs);
  const signal = extra?.signal ? AbortSignal.any([extra.signal, deadline]) : deadline;
  logInfo(`${label} called`, { url: redactUrl(rawUrl) });
  try {
    return await abortable(work(signal), signal);
  } catch (err) {
    if (err instanceof ValidationFailure) {
      return errorResult(`Validation Error: ${err.toClientMessage()}`);
    }
    if (err instanceof AppError) {
      logWarn(`${label} failed`, { url: redactUrl(rawUrl), code: err.code });
      return errorResult(`${label} failed: ${err.toClientMessage()}`);
    }
    logError(`${label} failed unexpectedly`, { url: redactUrl(rawUrl), error: String(err) });
    return errorResult(`${label} failed: ${ErrorCodes.InternalError}: Unexpected internal error`);
  }
}

/**
 * Validates the target URL (scheme, policy lists, SSRF incl. DNS).
 * @throws ValidationFailure
 */
export async function validateTarget(rawUrl: string, signal: AbortSignal): Promise<URL> {
  const validation = await validateAuditUrl(rawUrl, { signal });
  if (!validation.valid) throw new ValidationFailure(validation.code, validation.message);
  return validation.url;
}

function describeHttpStatus(result: FetchResult): string {
  const base = `Target responded with HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}; the error page was not audited.`;
  if ([401, 403, 429].includes(result.status)) {
    return `${base} The site may require authentication, rate-limit, or block automated clients.`;
  }
  return base;
}

/**
 * Fetches a validated target, honouring robots.txt when enabled and rejecting HTTP errors.
 * @throws AppError
 */
export async function fetchTarget(url: URL, signal: AbortSignal): Promise<FetchResult> {
  if (CONFIG.network.respectRobotsTxt && !(await isAllowedByRobots(url.href, { signal }))) {
    throw new AppError(
      ErrorCodes.RobotsDisallowed,
      `robots.txt disallows ${url.pathname} for this user agent (RESPECT_ROBOTS_TXT=true)`,
    );
  }
  const result = await safeFetch(url.href, { signal });
  if (result.status >= 400) throw new AppError(ErrorCodes.HttpError, describeHttpStatus(result));
  return result;
}

/**
 * Returns true when the response looks like an HTML document.
 * @param result Fetch result
 * @returns boolean
 */
export function isHtmlResponse(result: FetchResult): boolean {
  const type = result.contentType?.toLowerCase();
  if (!type) return /^\s*</.test(result.body.slice(0, 512));
  return type.includes('text/html') || type.includes('application/xhtml+xml');
}

export function notHtmlError(result: FetchResult): AppError {
  return new AppError(
    ErrorCodes.NotHtml,
    `Expected an HTML document but received "${result.contentType ?? 'unknown content type'}"`,
  );
}

function formatTtl(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

/**
 * Renders a result as JSON or Markdown, prefixing a cache notice for cached Markdown.
 */
export function renderResult<R>(value: R, cached: boolean, format: AuditFormat, toMarkdown: (r: R) => string): CallToolResult {
  if (format === 'json') return textResult(JSON.stringify(value, null, 2));
  const text = toMarkdown(value);
  return textResult(
    cached ? `> ℹ️ *Results served from cache (TTL: ${formatTtl(auditCache.defaultTtlMs)}).*\n\n${text}` : text,
  );
}

/**
 * Sends notifications/progress when the client supplied a progress token.
 * @param extra MCP request context
 * @param total Total number of steps
 * @returns Reporter function
 */
export function createProgressReporter(extra: ToolExtra | undefined, total: number) {
  const token = extra?._meta?.progressToken;
  return async (progress: number, message: string): Promise<void> => {
    if (token === undefined || !extra) return;
    await extra
      .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } })
      .catch(() => undefined);
  };
}

interface PageAuditDefinition<R> {
  name: string;
  title: string;
  description: string;
  purpose: string;
  label: string;
  cachePrefix: string;
  requiresHtml: boolean;
  run: (target: FetchResult, parse: () => ParsedHtml) => R;
  toMarkdown: (result: R) => string;
}

/**
 * Creates a single-page audit tool: validate → (cache) → fetch → engine → render.
 * @param def Tool definition
 * @returns AuditTool
 */
export function createPageAuditTool<R>(def: PageAuditDefinition<R>): AuditTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: auditInputShape(def.purpose),
    handler: (args, extra) =>
      runAudit(def.label, args.url, extra, async (signal) => {
        const url = await validateTarget(args.url, signal);
        const { value, cached } = await auditCache.getOrCompute(
          cacheKeyFor(def.cachePrefix, url),
          async (shared) => {
            const target = await fetchTarget(url, shared);
            if (def.requiresHtml && !isHtmlResponse(target)) throw notHtmlError(target);
            return def.run(target, () => parseHtml(target.body));
          },
          undefined,
          signal,
        );
        return renderResult(value as R, cached, args.format, def.toMarkdown);
      }),
  };
}
