import { PraesidiaApiError } from './errors.js';

/**
 * Thin HTTP client for the Praesidia REST API.
 *
 * Uses the native `fetch` available in Node 18+. Zero runtime dependencies.
 * All requests are authenticated with `Authorization: Bearer <apiKey>` which
 * is what be-core's `api-key.strategy.ts` (passport-http-bearer) reads.
 */
export class PraesidiaClient {
  constructor(
    private readonly baseUrl: string,
    private apiKey: string,
  ) {}

  /**
   * Swap the credential this client authenticates with, at runtime.
   *
   * Enables zero-downtime credential rotation for a long-lived client: after
   * rotating an agent's client secret (see PraesidiaAgents.rotateClientSecret)
   * with a grace window, adopt the new secret here and rely on the server-side
   * grace overlap so in-flight callers are never rejected during the swap.
   *
   * SECURITY: the new credential is held only in memory and is never logged.
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // api-key.strategy.ts uses passport-http-bearer which reads the
      // Authorization: Bearer header. This is the canonical header for
      // org-scoped API keys in be-core.
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PraesidiaApiError(response.status, path, text);
    }

    return response.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PraesidiaApiError(response.status, path, text);
    }

    return response.json() as Promise<T>;
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
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PraesidiaApiError(response.status, path, text);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
