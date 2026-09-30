import pino from 'pino';

/**
 * Standard logger configured to strictly output to stderr (stream 2).
 * This prevents corrupting MCP stdio JSON-RPC transport on stdout.
 */
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({ dest: 2, sync: true }),
);

/**
 * Strips query string, fragment and credentials from a URL for logging.
 * @param raw URL string
 * @returns Redacted URL (origin + path) or a placeholder when unparsable
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Logs a debug message to stderr.
 * @param msg Log message
 * @param meta Optional metadata object
 */
export function logDebug(msg: string, meta?: Record<string, unknown>): void {
  if (meta) {
    logger.debug(meta, msg);
  } else {
    logger.debug(msg);
  }
}

/**
 * Logs an informational message to stderr.
 * @param msg Log message
 * @param meta Optional metadata object
 */
export function logInfo(msg: string, meta?: Record<string, unknown>): void {
  if (meta) {
    logger.info(meta, msg);
  } else {
    logger.info(msg);
  }
}

/**
 * Logs a warning message to stderr.
 * @param msg Warning message
 * @param meta Optional metadata object
 */
export function logWarn(msg: string, meta?: Record<string, unknown>): void {
  if (meta) {
    logger.warn(meta, msg);
  } else {
    logger.warn(msg);
  }
}

/**
 * Logs an error message to stderr.
 * @param msg Error message
 * @param meta Optional metadata object
 */
export function logError(msg: string, meta?: Record<string, unknown>): void {
  if (meta) {
    logger.error(meta, msg);
  } else {
    logger.error(msg);
  }
}
