import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeBaseUrl,
  encodePathSegment,
  PraesidiaClient,
  resolveRequestTimeoutMs,
} from './client.js';
import { PraesidiaApiError } from './errors.js';

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
    expect(() => normalizeBaseUrl('https://api example.test')).toThrow(/whitespace/);
    expect(() => normalizeBaseUrl('https:\\evil.example.test')).toThrow(/backslashes/);
    expect(() => resolveRequestTimeoutMs(0)).toThrow(/integer/);
    expect(() => new PraesidiaClient('https://api.example.test', '   ')).toThrow(/apiKey/);
    expect(() => new PraesidiaClient('https://api.example.test', ' key')).toThrow(/apiKey/);
  });

  it('rejects unsafe header values and path segments before fetch', () => {
    const client = new PraesidiaClient('https://api.example.test', 'pk_test');
    expect(() => client.setChainId('chain\r\ninjected: true')).toThrow(/chainId/);
    expect(() => encodePathSegment('', 'agentId')).toThrow(/agentId/);
    expect(() => encodePathSegment(' ', 'agentId')).toThrow(/agentId/);
    expect(() => encodePathSegment('..', 'agentId')).toThrow(/agentId/);
    expect(encodePathSegment('../agent', 'agentId')).toBe('..%2Fagent');
  });
});

// ---------------------------------------------------------------------------
// FINDING-4 — retry behavior. Uses a tiny backoff config so specs run fast
// and deterministically (no fake timers needed).
// ---------------------------------------------------------------------------
describe('PraesidiaClient retry (FINDING-4)', () => {
  const originalFetch = globalThis.fetch;
  const fastRetry = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, maxElapsedMs: 5000 };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries a GET on a 503 and succeeds on the next attempt', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      fastRetry,
    );
    const result = await client.get<{ ok: boolean }>('/health');
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('honours Retry-After on a 429 before retrying', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('slow down', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      fastRetry,
    );
    const result = await client.get<{ ok: boolean }>('/health');
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('retries DELETE on a transient 500', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('boom', { status: 500 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      fastRetry,
    );
    await client.del('/resource/1');
    expect(calls).toBe(2);
  });

  it('NEVER retries a bare POST (would risk a double-create/double-charge)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response('boom', { status: 503 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      fastRetry,
    );
    await expect(
      client.post('/organizations/org_1/tasks', { input: {} }),
    ).rejects.toThrow(PraesidiaApiError);
    expect(calls).toBe(1);
  });

  it('retries a POST carrying an idempotencyKey on a route be-core dedups, and sends the Idempotency-Key header', async () => {
    let calls = 0;
    const seenHeaders: Record<string, string>[] = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls += 1;
      seenHeaders.push({ ...(init?.headers as Record<string, string>) });
      if (calls === 1) return new Response('boom', { status: 503 });
      return new Response(JSON.stringify({ created: true }), { status: 201 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      fastRetry,
    );
    const result = await client.post<{ created: boolean }>(
      '/organizations/org_1/tasks',
      { input: {} },
      undefined,
      { idempotencyKey: 'idem-123' },
    );
    expect(result).toEqual({ created: true });
    expect(calls).toBe(2);
    expect(seenHeaders[0]['Idempotency-Key']).toBe('idem-123');
  });

  it('R-SDK-1: refuses an idempotencyKey on a route be-core does not dedup, without calling fetch', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: 'x' }), { status: 201 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      fastRetry,
    );
    await expect(
      client.post(
        '/organizations/org_1/agents',
        { name: 'a' },
        undefined,
        { idempotencyKey: 'idem-123' },
      ),
    ).rejects.toThrow(/does not honour Idempotency-Key/);
    await expect(
      client.patch(
        '/organizations/org_1/tasks',
        { name: 'a' },
        undefined,
        { idempotencyKey: 'idem-123' },
      ),
    ).rejects.toThrow(/does not honour Idempotency-Key/);
    expect(calls).toBe(0);
  });

  it.each(['', ' key', 'key\r\ninjected: true'])(
    'rejects an unsafe idempotency key before fetch: %j',
    async (idempotencyKey) => {
      const spy = vi.fn();
      globalThis.fetch = spy as typeof fetch;
      const client = new PraesidiaClient(
        'https://api.example.test',
        'pk_test',
        undefined,
        fastRetry,
      );
      await expect(
        client.post('/organizations/org_1/tasks', {}, undefined, {
          idempotencyKey,
        }),
      ).rejects.toThrow(/idempotencyKey/);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('R-SDK-1: honours the idempotencyKey allow-list for the A2A inbound routes', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    ) as typeof fetch;
    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      fastRetry,
    );
    await expect(
      client.post('/a2a/tasks', {}, undefined, { idempotencyKey: 'k' }),
    ).resolves.toEqual({ ok: true });
    await expect(
      client.post('/a2a/tasks/task-1/result', {}, undefined, {
        idempotencyKey: 'k',
      }),
    ).resolves.toEqual({ ok: true });
  });

  it('gives up after maxAttempts and surfaces the final error response', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response('still down', { status: 503 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      fastRetry,
    );
    await expect(client.get('/health')).rejects.toThrow(PraesidiaApiError);
    expect(calls).toBe(fastRetry.maxAttempts);
  });

  it('never retries when retry is disabled (retry: false)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      false,
    );
    await expect(client.get('/health')).rejects.toThrow(PraesidiaApiError);
    expect(calls).toBe(1);
  });

  it('retries a network-level failure (fetch rejects), not just HTTP error statuses', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      'https://api.example.test',
      'pk_test',
      undefined,
      fastRetry,
    );
    const result = await client.get<{ ok: boolean }>('/health');
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
