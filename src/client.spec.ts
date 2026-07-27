import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeBaseUrl,
  PraesidiaClient,
  resolveRequestTimeoutMs,
} from './client.js';

describe('PraesidiaClient availability and configuration boundaries', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('aborts a backend request at the configured deadline', async () => {
    globalThis.fetch = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;

    const client = new PraesidiaClient('https://api.example.test', 'pk_test', 20);
    await expect(client.get('/health')).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('normalizes a trailing slash and rejects unsafe base URLs/timeouts', () => {
    expect(normalizeBaseUrl('https://api.example.test/')).toBe('https://api.example.test');
    expect(() => normalizeBaseUrl('https://user:pass@example.test')).toThrow(/credentials/);
    expect(() => resolveRequestTimeoutMs(0)).toThrow(/integer/);
    expect(() => new PraesidiaClient('https://api.example.test', '   ')).toThrow(/apiKey/);
  });
});
