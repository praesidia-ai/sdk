import { PraesidiaConfigError } from './errors.js';

/**
 * FINDING-4 — bounded exponential-backoff-with-jitter retry policy applied
 * ONLY to requests that are safe to repeat: GET/DELETE (always idempotent in
 * this API) and any POST/PATCH carrying a caller-supplied idempotency key.
 * A bare POST (e.g. task submission, agent creation) is NEVER retried by the
 * client — a transient response after the server already applied the write
 * would otherwise double-create/double-charge. See client.ts's `post`/`patch`
 * `idempotencyKey` option to opt a specific write into retry.
 */
export interface RetryConfig {
  /** Total attempts including the first (default 3 — i.e. up to 2 retries). Max 10. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry (default 250). */
  baseDelayMs?: number;
  /** Cap on any single computed backoff delay, before a `Retry-After` override (default 4000). */
  maxDelayMs?: number;
  /** Wall-clock budget in ms across every attempt of one logical call (default 15000). */
  maxElapsedMs?: number;
}

export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  maxElapsedMs: 15_000,
};

/** Resolve+validate a caller-supplied retry config. `false` disables retries entirely. */
export function resolveRetryConfig(
  value: RetryConfig | false | undefined,
): Required<RetryConfig> | false {
  if (value === false) return false;
  const merged: Required<RetryConfig> = { ...DEFAULT_RETRY_CONFIG, ...value };
  if (
    !Number.isInteger(merged.maxAttempts) ||
    merged.maxAttempts < 1 ||
    merged.maxAttempts > 10
  ) {
    throw new PraesidiaConfigError(
      'retry.maxAttempts must be an integer from 1 to 10',
    );
  }
  if (!Number.isFinite(merged.baseDelayMs) || merged.baseDelayMs < 0) {
    throw new PraesidiaConfigError(
      'retry.baseDelayMs must be a non-negative number',
    );
  }
  if (!Number.isFinite(merged.maxDelayMs) || merged.maxDelayMs < merged.baseDelayMs) {
    throw new PraesidiaConfigError(
      'retry.maxDelayMs must be a number >= retry.baseDelayMs',
    );
  }
  if (!Number.isFinite(merged.maxElapsedMs) || merged.maxElapsedMs < 0) {
    throw new PraesidiaConfigError(
      'retry.maxElapsedMs must be a non-negative number',
    );
  }
  return merged;
}

/** Retry-worthy HTTP status codes: 429 (rate limit, honour `Retry-After`) and 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parse a `Retry-After` header (delta-seconds or an HTTP-date) into a
 * millisecond delay. Returns `undefined` when absent or unparseable.
 */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/** Exponential backoff with full jitter (`random() * min(cap, base * 2^(attempt-1))`). */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.random() * exp;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
