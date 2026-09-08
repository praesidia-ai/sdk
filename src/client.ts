import { performance } from 'node:perf_hooks';
import {
  PraesidiaApiError,
  PraesidiaConfigError,
  type PraesidiaErrorEnvelope,
} from './errors.js';
import {
  assertIdempotencyKeySupported,
  computeBackoffMs,
  isRetryableStatus,
  parseRetryAfterMs,
  resolveRetryConfig,
  sleep,
  type RetryConfig,
} from './retry.js';

/**
 * Thin HTTP client for the Praesidia REST API.
 *
 * Uses the native `fetch` available in Node 18+. Zero runtime dependencies.
 * All requests are authenticated with `Authorization: Bearer <apiKey>` which
 * is what be-core's `api-key.strategy.ts` (passport-http-bearer) reads.
 */
/** Canonical Praesidia chain-trace header (Q3-02). */
export const CHAIN_ID_HEADER = 'X-Praesidia-Chain-Id';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * SCAN2-007 — best-effort parse of be's structured JSON error envelope
 * (`be/src/common/filters/http-exception.filter.ts`). Returns `undefined`
 * for a non-JSON, empty, or non-object body (a plain-text upstream/proxy
 * error, for example) rather than throwing — an unparseable error body must
 * never mask the real HTTP error with a JSON parse error.
 */
export function parseErrorEnvelope(text: string): PraesidiaErrorEnvelope | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PraesidiaErrorEnvelope;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Build a `PraesidiaApiError` from a non-2xx response's raw text body. */
function buildApiError(status: number, path: string, text: string): PraesidiaApiError {
  const envelope = parseErrorEnvelope(text);
  return new PraesidiaApiError(status, path, text, envelope, isRetryableStatus(status));
}

export function resolveRequestTimeoutMs(value?: number): number {
  const envValue = process.env['PRAESIDIA_REQUEST_TIMEOUT_MS'];
  const resolved = value ?? (envValue === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : Number(envValue));
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 300_000) {
    throw new PraesidiaConfigError(
      'requestTimeoutMs/PRAESIDIA_REQUEST_TIMEOUT_MS must be an integer from 1 to 300000',
    );
  }
  return resolved;
}

export function normalizeBaseUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /\s|\\/.test(value)
  ) {
    throw new PraesidiaConfigError(
      'baseUrl/PRAESIDIA_BASE_URL must contain no whitespace or backslashes',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PraesidiaConfigError('baseUrl/PRAESIDIA_BASE_URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new PraesidiaConfigError(
      'baseUrl/PRAESIDIA_BASE_URL must use HTTP(S) and contain no credentials, query, or fragment',
    );
  }
  return url.toString().replace(/\/$/, '');
}

/** Validate and encode one caller-controlled URL path segment. */
export function encodePathSegment(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value === '.' ||
    value === '..' ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new PraesidiaConfigError(
      `${label} must be a non-empty path segment without surrounding whitespace, dot traversal, or control characters`,
    );
  }
  return encodeURIComponent(value);
}

/** Validate the shared backend `PaginationDto` contract before a request. */
export function assertPagination(query: {
  page?: unknown;
  limit?: unknown;
}): void {
  if (
    query.page !== undefined &&
    (!Number.isInteger(query.page) || (query.page as number) < 1)
  ) {
    throw new PraesidiaConfigError('page must be an integer greater than or equal to 1');
  }
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) ||
      (query.limit as number) < 1 ||
      (query.limit as number) > 100)
  ) {
    throw new PraesidiaConfigError('limit must be an integer from 1 to 100');
  }
}

/** Validate an ISO-8601 date accepted by the backend's `@IsDateString()`. */
export function assertIsoDate(value: string | undefined, label: string): void {
  if (value === undefined) return;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
    value,
  );
  if (!match || !Number.isFinite(Date.parse(value))) {
    throw new PraesidiaConfigError(`${label} must be a valid ISO-8601 date`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    throw new PraesidiaConfigError(`${label} must be a valid ISO-8601 date`);
  }
}

/** Validate an optional ISO date window and reject an inverted range. */
export function assertIsoDateRange(
  fromDate: string | undefined,
  toDate: string | undefined,
): void {
  assertIsoDate(fromDate, 'fromDate');
  assertIsoDate(toDate, 'toDate');
  if (
    fromDate !== undefined &&
    toDate !== undefined &&
    Date.parse(fromDate) > Date.parse(toDate)
  ) {
    throw new PraesidiaConfigError('fromDate must be earlier than or equal to toDate');
  }
}

export class PraesidiaClient {
  /**
   * Q3-02 — the inbound chain-trace id this client propagates on every
   * outbound call via the `X-Praesidia-Chain-Id` header. Unsigned metadata:
   * the SDK NEVER mints one, it only forwards an id it received on an inbound
   * hop so a multi-agent chain stays correlated across SDK-driven hops.
   */
  private chainId: string | undefined;

  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly retryConfig: Required<RetryConfig> | false;

  /**
   * SCAN2-013/CT-10 — a TRUE private class field (`#`), not the `private`
   * modifier. `private` is compile-time-only; at runtime it is a normal
   * own-enumerable property, so `console.log(client)`/`JSON.stringify(client)`/
   * a snapshot test/an error-tracking SDK's object-graph serialization would
   * all print the raw key in cleartext. A `#` field is invisible to every one
   * of those (`Object.keys`, `JSON.stringify`, `util.inspect`) by JS
   * language semantics, not by convention.
   */
  #apiKey: string;

  constructor(
    baseUrl: string,
    apiKey: string,
    requestTimeoutMs?: number,
    retryConfig?: RetryConfig | false,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.requestTimeoutMs = resolveRequestTimeoutMs(requestTimeoutMs);
    this.retryConfig = resolveRetryConfig(retryConfig);
    this.assertApiKey(apiKey);
    this.#apiKey = apiKey;
  }

  /**
   * Swap the credential this client authenticates with, at runtime.
   *
   * Enables zero-downtime credential rotation for a long-lived client: adopt a
   * newly provisioned agent client secret here so subsequent requests
   * authenticate with the new secret without recreating the client.
   *
   * SECURITY: the new credential is held only in memory and is never logged.
   */
  setApiKey(apiKey: string): void {
    this.assertApiKey(apiKey);
    this.#apiKey = apiKey;
  }

  private assertApiKey(apiKey: string): void {
    if (
      typeof apiKey !== 'string' ||
      !apiKey ||
      apiKey !== apiKey.trim() ||
      /[\u0000-\u001f\u007f]/.test(apiKey)
    ) {
      throw new PraesidiaConfigError(
        'apiKey must be non-empty and contain no surrounding whitespace or control characters',
      );
    }
  }

  private assertIdempotencyKey(idempotencyKey: string): void {
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey !== idempotencyKey.trim() ||
      /[\u0000-\u001f\u007f]/.test(idempotencyKey)
    ) {
      throw new PraesidiaConfigError(
        'idempotencyKey must be non-empty and contain no surrounding whitespace or control characters',
      );
    }
  }

  /**
   * Q3-02 — adopt the inbound chain-trace id so it is forwarded (unchanged) on
   * every subsequent outbound call as `X-Praesidia-Chain-Id`. Pass `null`/an
   * empty value to stop propagating. The SDK never mints a chainId — it only
   * echoes one received on an inbound hop.
   */
  setChainId(chainId: string | null | undefined): void {
    if (
      chainId !== null &&
      chainId !== undefined &&
      (typeof chainId !== 'string' ||
        chainId !== chainId.trim() ||
        /[\u0000-\u001f\u007f]/.test(chainId))
    ) {
      throw new PraesidiaConfigError(
        'chainId must be a single-line string without surrounding whitespace',
      );
    }
    this.chainId = chainId ? chainId : undefined;
  }

  /** The chain-trace id currently being propagated, if any. */
  getChainId(): string | undefined {
    return this.chainId;
  }

  private buildHeaders(
    extraHeaders?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // api-key.strategy.ts uses passport-http-bearer which reads the
      // Authorization: Bearer header. This is the canonical header for
      // org-scoped API keys in be-core.
      Authorization: `Bearer ${this.#apiKey}`,
    };
    // Q3-02 — forward the inbound chain-trace id on every call so the chain
    // stays joined across SDK-driven hops.
    if (this.chainId) {
      headers[CHAIN_ID_HEADER] = this.chainId;
    }
    return extraHeaders ? { ...headers, ...extraHeaders } : headers;
  }

  /**
   * FINDING-4 — bounded retry wrapper. Only ever called for requests known to
   * be safe to repeat (see call sites below): GET/DELETE unconditionally, and
   * POST/PATCH only when the caller passed an `idempotencyKey` (added to
   * `extraHeaders` by the caller before reaching here). A bare POST never
   * flows through this path, so a transient timeout can never cause a
   * duplicate create/charge.
   *
   * `initFactory` is invoked fresh for every attempt (not reused) because
   * `AbortSignal.timeout(...)` starts its clock at creation — reusing one
   * signal across retries would mean later attempts inherit an already
   * partially (or fully) elapsed deadline.
   */
  private async fetchWithRetry(
    initFactory: () => RequestInit & { method: string },
    url: string,
  ): Promise<Response> {
    if (this.retryConfig === false) {
      return fetch(url, initFactory());
    }
    const { maxAttempts, baseDelayMs, maxDelayMs, maxElapsedMs } = this.retryConfig;
    const start = performance.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, initFactory());
      } catch (err) {
        // Network-level failure (DNS/connection reset/etc — fetch rejects,
        // it does not resolve). Retry it exactly like a 5xx, same budget.
        const elapsed = performance.now() - start;
        if (attempt >= maxAttempts || elapsed >= maxElapsedMs) throw err;
        const delay = computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
        if (elapsed + delay >= maxElapsedMs) throw err;
        await sleep(delay);
        continue;
      }

      if (
        attempt < maxAttempts &&
        isRetryableStatus(response.status) &&
        performance.now() - start < maxElapsedMs
      ) {
        const elapsed = performance.now() - start;
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        const delay = retryAfterMs ?? computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
        if (elapsed + delay >= maxElapsedMs) return response;
        // This response will never be returned to the caller. Explicitly
        // cancel its body so Undici can release the socket/buffer before a
        // long-lived client starts the next attempt.
        await response.body?.cancel().catch(() => undefined);
        await sleep(delay);
        continue;
      }
      return response;
    }
    // Unreachable — the loop above always returns or throws — but keeps
    // control-flow analysis happy.
    /* istanbul ignore next */
    throw new PraesidiaApiError(0, url, 'retry loop exhausted unexpectedly');
  }

  async post<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
    opts?: { idempotencyKey?: string },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    if (opts?.idempotencyKey !== undefined) {
      this.assertIdempotencyKey(opts.idempotencyKey);
      assertIdempotencyKeySupported('POST', path);
    }
    const headers = opts?.idempotencyKey !== undefined
      ? { ...extraHeaders, 'Idempotency-Key': opts.idempotencyKey }
      : extraHeaders;
    const retryable = opts?.idempotencyKey !== undefined;
    const response = retryable
      ? await this.fetchWithRetry(
          () => ({
            method: 'POST',
            headers: this.buildHeaders(headers),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          }),
          url,
        )
      : await fetch(url, {
          method: 'POST',
          headers: this.buildHeaders(headers),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw buildApiError(response.status, path, text);
    }

    return response.json() as Promise<T>;
  }

  /**
   * PATCH a resource. Not retried unless `opts.idempotencyKey` is supplied —
   * and R-SDK-1: be-core does not honour `Idempotency-Key` on ANY PATCH route
   * today, so `assertIdempotencyKeySupported` always rejects a PATCH-level
   * idempotencyKey until a server-side PATCH dedup route exists.
   */
  async patch<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
    opts?: { idempotencyKey?: string },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    if (opts?.idempotencyKey !== undefined) {
      this.assertIdempotencyKey(opts.idempotencyKey);
      assertIdempotencyKeySupported('PATCH', path);
    }
    const headers = opts?.idempotencyKey !== undefined
      ? { ...extraHeaders, 'Idempotency-Key': opts.idempotencyKey }
      : extraHeaders;
    const retryable = opts?.idempotencyKey !== undefined;
    const initFactory = (): RequestInit & { method: string } => ({
      method: 'PATCH',
      headers: this.buildHeaders(headers),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const response = retryable
      ? await this.fetchWithRetry(initFactory, url)
      : await fetch(url, initFactory());

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw buildApiError(response.status, path, text);
    }

    return response.json() as Promise<T>;
  }

  /** GET is always idempotent — retried per the configured (or default) policy. */
  async get<T>(
    path: string,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetchWithRetry(
      () => ({
        method: 'GET',
        headers: this.buildHeaders(extraHeaders),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
      url,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw buildApiError(response.status, path, text);
    }

    return response.json() as Promise<T>;
  }

  /**
   * DELETE a resource. Tolerates an empty (204 No Content) body — the backend's
   * soft-delete routes answer 204 with no JSON — so callers get `void` back and
   * are not forced to parse an empty response. Always idempotent — retried
   * per the configured (or default) policy.
   */
  async del(
    path: string,
    extraHeaders?: Record<string, string>,
  ): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetchWithRetry(
      () => ({
        method: 'DELETE',
        headers: this.buildHeaders(extraHeaders),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
      url,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw buildApiError(response.status, path, text);
    }
    // DELETE callers do not receive a response body. Release any unexpected
    // body immediately so a non-conforming upstream cannot pin the connection.
    await response.body?.cancel().catch(() => undefined);
  }

  /**
   * GET a binary response body (e.g. a rendered PDF) as raw bytes.
   *
   * Returns a `Uint8Array`; in Node wrap with `Buffer.from(bytes)` to write
   * to disk. Throws `PraesidiaApiError` on any non-2xx response (including the
   * 409 returned while a report is still generating). Always idempotent —
   * retried per the configured (or default) policy.
   */
  async getBytes(path: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${this.#apiKey}`,
    };
    if (this.chainId) {
      headers[CHAIN_ID_HEADER] = this.chainId;
    }
    const response = await this.fetchWithRetry(
      () => ({
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
      url,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw buildApiError(response.status, path, text);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
