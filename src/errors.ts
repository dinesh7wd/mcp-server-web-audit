/**
 * Structured error codes for MCP tool responses.
 */
export const ErrorCodes = {
  SSRF_BLOCKED: 'SSRF_BLOCKED',
  InvalidParams: 'InvalidParams',
  AuthRequired: 'AUTH_REQUIRED',
  RateLimited: 'RATE_LIMITED',
  InternalError: 'InternalError',
  DnsFailed: 'DNS_FAILED',
  Timeout: 'TIMEOUT',
  Cancelled: 'CANCELLED',
  FetchFailed: 'FETCH_FAILED',
  TooManyRedirects: 'TOO_MANY_REDIRECTS',
  ResponseTooLarge: 'RESPONSE_TOO_LARGE',
  HttpError: 'HTTP_ERROR',
  NotHtml: 'NOT_HTML',
  RobotsDisallowed: 'ROBOTS_DISALLOWED',
  PolicyBlocked: 'POLICY_BLOCKED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
  }

  toClientMessage(): string {
    return `${this.code}: ${this.message}`;
  }
}

/**
 * Converts an abort reason into a client-safe AppError.
 * @param signal Aborted signal
 * @returns AppError (TIMEOUT for deadlines, CANCELLED otherwise)
 */
export function abortToAppError(signal: AbortSignal): AppError {
  const reason: unknown = signal.reason;
  if (reason instanceof AppError) return reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    return new AppError(ErrorCodes.Timeout, 'Audit exceeded the overall time limit');
  }
  return new AppError(ErrorCodes.Cancelled, 'Request was cancelled');
}

/**
 * Wraps a promise so it rejects as soon as the signal aborts.
 * @param promise Work to await
 * @param signal Optional abort signal
 * @returns The promise result
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortToAppError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortToAppError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
