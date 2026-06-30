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
    private readonly apiKey: string,
  ) {}

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
}
