import { PraesidiaApiError, PraesidiaConfigError } from './errors.js';

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

  constructor(baseUrl: string, private apiKey: string, requestTimeoutMs?: number) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.requestTimeoutMs = resolveRequestTimeoutMs(requestTimeoutMs);
    this.assertApiKey(apiKey);
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
    this.apiKey = apiKey;
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
      Authorization: `Bearer ${this.apiKey}`,
    };
    // Q3-02 — forward the inbound chain-trace id on every call so the chain
    // stays joined across SDK-driven hops.
    if (this.chainId) {
      headers[CHAIN_ID_HEADER] = this.chainId;
    }
    return extraHeaders ? { ...headers, ...extraHeaders } : headers;
  }

  async post<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(extraHeaders),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PraesidiaApiError(response.status, path, text);
    }

    return response.json() as Promise<T>;
  }

  async get<T>(
    path: string,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(extraHeaders),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PraesidiaApiError(response.status, path, text);
    }

    return response.json() as Promise<T>;
  }

  /**
   * DELETE a resource. Tolerates an empty (204 No Content) body — the backend's
   * soft-delete routes answer 204 with no JSON — so callers get `void` back and
   * are not forced to parse an empty response.
   */
  async del(
    path: string,
    extraHeaders?: Record<string, string>,
  ): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.buildHeaders(extraHeaders),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PraesidiaApiError(response.status, path, text);
    }
  }

  /**
   * GET a binary response body (e.g. a rendered PDF) as raw bytes.
   *
   * Returns a `Uint8Array`; in Node wrap with `Buffer.from(bytes)` to write
   * to disk. Throws `PraesidiaApiError` on any non-2xx response (including the
   * 409 returned while a report is still generating).
   */
  async getBytes(path: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/octet-stream',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.chainId) {
      headers[CHAIN_ID_HEADER] = this.chainId;
    }
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PraesidiaApiError(response.status, path, text);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
