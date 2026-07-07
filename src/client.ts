import { PraesidiaApiError } from './errors.js';

/**
 * Thin HTTP client for the Praesidia REST API.
 *
 * Uses the native `fetch` available in Node 18+. Zero runtime dependencies.
 * All requests are authenticated with `Authorization: Bearer <apiKey>` which
 * is what be-core's `api-key.strategy.ts` (passport-http-bearer) reads.
 */
/** Canonical Praesidia chain-trace header (Q3-02). */
export const CHAIN_ID_HEADER = 'X-Praesidia-Chain-Id';

export class PraesidiaClient {
  /**
   * Q3-02 — the inbound chain-trace id this client propagates on every
   * outbound call via the `X-Praesidia-Chain-Id` header. Unsigned metadata:
   * the SDK NEVER mints one, it only forwards an id it received on an inbound
   * hop so a multi-agent chain stays correlated across SDK-driven hops.
   */
  private chainId: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private apiKey: string,
  ) {}

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
    this.apiKey = apiKey;
  }

  /**
   * Q3-02 — adopt the inbound chain-trace id so it is forwarded (unchanged) on
   * every subsequent outbound call as `X-Praesidia-Chain-Id`. Pass `null`/an
   * empty value to stop propagating. The SDK never mints a chainId — it only
   * echoes one received on an inbound hop.
   */
  setChainId(chainId: string | null | undefined): void {
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
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PraesidiaApiError(response.status, path, text);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
