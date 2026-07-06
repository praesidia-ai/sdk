import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaMemory } from './memory.js';
import { PraesidiaApiError, PraesidiaConfigError } from './errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchMock(
  responses: Array<{ ok: boolean; status?: number; body: unknown }>,
) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[call % responses.length];
    call++;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  });
}

const config = { apiKey: 'pk_test_key', orgId: 'org-uuid-123' };

const MEMORY = {
  id: 'mem-1',
  organizationId: 'org-uuid-123',
  content: 'The customer prefers email.',
  memoryKey: null,
  tags: null,
  provenance: {
    sourceType: 'agent',
    sourceAgentId: null,
    authorUserId: 'u-1',
    sourceReference: null,
    writtenAt: '2026-07-06T00:00:00.000Z',
  },
  guardrail: { poisoningScore: 0.01, piiRedacted: false },
  retention: { regime: 'none', expiresAt: null },
  erasedAt: null,
  createdAt: '2026-07-06T00:00:00.000Z',
  updatedAt: '2026-07-06T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PraesidiaMemory', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(
      () => new PraesidiaMemory({ apiKey: undefined, orgId: undefined }),
    ).toThrow(PraesidiaConfigError);
  });

  it('create POSTs the CreateMemoryDto to the memories endpoint', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, status: 201, body: MEMORY },
    ]) as typeof fetch;

    const memory = new PraesidiaMemory(config);
    const result = await memory.create({
      content: 'The customer prefers email.',
      subjectId: 'subject-9',
      tags: ['crm'],
    });

    expect(result.id).toBe('mem-1');
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain('/organizations/org-uuid-123/memories');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      content: 'The customer prefers email.',
      subjectId: 'subject-9',
      tags: ['crm'],
    });
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_test_key',
    );
  });

  it('list GETs with a built query string', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, body: { data: [MEMORY], total: 1, page: 1 } },
    ]) as typeof fetch;

    const memory = new PraesidiaMemory(config);
    const res = await memory.list({ limit: 5, memoryKey: 'conv-1', tag: 'crm' });

    expect(res.data).toHaveLength(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string];
    expect(url).toContain('/organizations/org-uuid-123/memories?');
    expect(url).toContain('limit=5');
    expect(url).toContain('memoryKey=conv-1');
    expect(url).toContain('tag=crm');
  });

  it('search POSTs the SearchMemoryDto to /memories/search', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, body: [MEMORY] },
    ]) as typeof fetch;

    const memory = new PraesidiaMemory(config);
    const hits = await memory.search({ query: 'contact preference', topK: 5 });

    expect(hits).toHaveLength(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain('/organizations/org-uuid-123/memories/search');
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'contact preference',
      topK: 5,
    });
  });

  it('erase POSTs the subject + reason to /memories/erase', async () => {
    globalThis.fetch = makeFetchMock([
      {
        ok: true,
        body: {
          subjectExternalIdHash: 'hash-abc',
          memoriesErased: 3,
          dekDestroyed: true,
          certificateId: 'cert-1',
        },
      },
    ]) as typeof fetch;

    const memory = new PraesidiaMemory(config);
    const res = await memory.erase({
      subjectId: 'subject-9',
      reason: 'GDPR Art-17 request',
    });

    expect(res.memoriesErased).toBe(3);
    expect(res.dekDestroyed).toBe(true);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain('/organizations/org-uuid-123/memories/erase');
    expect(JSON.parse(init.body as string)).toEqual({
      subjectId: 'subject-9',
      reason: 'GDPR Art-17 request',
    });
  });

  it('get url-encodes the memory id', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: MEMORY }]) as typeof fetch;

    const memory = new PraesidiaMemory(config);
    await memory.get('a/../b');

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string];
    expect(url).toContain('/memories/a%2F..%2Fb');
  });

  it('delete DELETEs the memory and tolerates a 204 empty body', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error('no body');
      },
      text: async () => '',
    })) as unknown as typeof fetch;

    const memory = new PraesidiaMemory(config);
    await expect(memory.delete('mem-1')).resolves.toBeUndefined();

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain('/organizations/org-uuid-123/memories/mem-1');
    expect(init.method).toBe('DELETE');
  });

  it('surfaces a PraesidiaApiError on a non-2xx response', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: false, status: 403, body: { message: 'forbidden' } },
    ]) as typeof fetch;

    const memory = new PraesidiaMemory(config);
    await expect(memory.get('mem-1')).rejects.toThrow(PraesidiaApiError);
  });
});
