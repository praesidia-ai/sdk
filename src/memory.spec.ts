import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaMemory } from './memory.js';
import { PraesidiaApiError, PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

const config = { apiKey: 'pk_test_key', orgId: 'org-uuid-123' };

const MEMORY = {
  id: 'mem-1',
  organizationId: 'org-uuid-123',
  content: 'The customer prefers email.',
  memoryKey: null,
  tags: null,
  provenance: {
    sourceType: 'AGENT',
    sourceAgentId: null,
    authorUserId: 'u-1',
    sourceReference: null,
    writtenAt: '2026-07-06T00:00:00.000Z',
  },
  guardrail: { poisoningScore: 0.01, piiRedacted: false },
  retention: { regime: 'NONE', expiresAt: null },
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

  it('synchronizes source ACL and version, lists current sources, and preserves API conflicts', async () => {
    const input = { sourceReference: 'doc/1', contentVersion: 'v2', authorityUrl: 'https://authority.example.test/check', authorityPublicKey: 'public-key', allowedUserIds: ['reader-id'], validUntil: '2026-09-05T12:10:00Z', expectedRevision: 4, state: 'active' as const };
    globalThis.fetch = makeFetchMock([{ ok: true, status: 201, body: { ...input, id: 'source-1', revision: 5 } }, { ok: true, body: [{ id: 'source-1' }] }, { ok: false, status: 409, body: { message: 'Source ownership or revision changed' } }]);
    const memory = new PraesidiaMemory(config);
    expect(await memory.synchronizeSource(input)).toMatchObject({ id: 'source-1', revision: 5 });
    expect(await memory.listSources()).toEqual([{ id: 'source-1' }]);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toContain('/organizations/org-uuid-123/memory-sources/synchronize');
    expect(JSON.parse(calls[0][1].body)).toEqual(input);
    expect(calls[1][0]).toContain('/organizations/org-uuid-123/memory-sources');
    await expect(memory.synchronizeSource(input)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an unsafe rotated credential', () => {
    const memory = new PraesidiaMemory({ apiKey: 'pk_x', orgId: 'org-1' });
    expect(() => memory.refreshCredential(' bad')).toThrow(PraesidiaConfigError);
  });

  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(
      () => new PraesidiaMemory({ apiKey: undefined, orgId: undefined }),
    ).toThrow(PraesidiaConfigError);
    expect(
      () => new PraesidiaMemory({ apiKey: 'pk_test', orgId: '' }),
    ).toThrow(PraesidiaConfigError);
  });

  it('encodes the organization id as one path segment', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: { data: [], total: 0, meta: {} } }]);
    const memory = new PraesidiaMemory({
      apiKey: 'pk_test',
      orgId: '../other-org',
    });

    await memory.list();

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/organizations/..%2Fother-org/memories');
  });

  it('create POSTs the CreateMemoryDto to the memories endpoint', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, status: 201, body: MEMORY }]);

    const memory = new PraesidiaMemory(config);
    const result = await memory.create({
      content: 'The customer prefers email.',
      subjectId: 'subject-9',
      memoryKey: 'namespace-1',
      tags: ['crm'],
      sourceType: 'IMPORT',
      accessSourceId: '00000000-0000-4000-8000-000000000002',
      sourceAgentId: '00000000-0000-4000-8000-000000000001',
      sourceReference: 'import-job-1',
      retentionRegime: 'CUSTOM',
      retentionDays: 30,
    });

    expect(result.id).toBe('mem-1');
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain('/organizations/org-uuid-123/memories');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      content: 'The customer prefers email.',
      subjectId: 'subject-9',
      memoryKey: 'namespace-1',
      tags: ['crm'],
      sourceType: 'IMPORT',
      accessSourceId: '00000000-0000-4000-8000-000000000002',
      sourceAgentId: '00000000-0000-4000-8000-000000000001',
      sourceReference: 'import-job-1',
      retentionRegime: 'CUSTOM',
      retentionDays: 30,
    });
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_test_key',
    );
  });

  it.each([
    { content: '' },
    { content: 'x'.repeat(32_769) },
    { content: 'ok', sourceType: 'agent' },
    { content: 'ok', sourceType: 'TOOL' },
    { content: 'ok', retentionRegime: 'sox' },
    { content: 'ok', retentionRegime: 'SOX' },
    { content: 'ok', retentionDays: 30 },
    { content: 'ok', retentionRegime: 'SOC2', retentionDays: 30 },
    { content: 'ok', retentionRegime: 'CUSTOM' },
    { content: 'ok', retentionRegime: 'CUSTOM', retentionDays: 0 },
  ])('rejects backend-invalid or silently ignored create input: %o', async (input) => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const memory = new PraesidiaMemory(config);

    await expect(memory.create(input as never)).rejects.toThrow(
      PraesidiaConfigError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('list GETs with a built query string', async () => {
    globalThis.fetch = makeFetchMock([
      {
        ok: true,
        body: {
          data: [MEMORY],
          total: 1,
          meta: {
            page: 1,
            limit: 5,
            total: 1,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        },
      },
    ]);

    const memory = new PraesidiaMemory(config);
    const res = await memory.list({
      limit: 5,
      memoryKey: 'conv-1',
      sourceType: 'AGENT',
      tag: 'crm',
    });

    expect(res.data).toHaveLength(1);
    expect(res.meta.page).toBe(1);
    expect(res.meta.totalPages).toBe(1);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string];
    expect(url).toContain('/organizations/org-uuid-123/memories?');
    expect(url).toContain('limit=5');
    expect(url).toContain('memoryKey=conv-1');
    expect(url).toContain('sourceType=AGENT');
    expect(url).toContain('tag=crm');
  });

  it('rejects a backend-invalid list source type before fetch', async () => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const memory = new PraesidiaMemory(config);

    await expect(memory.list({ sourceType: 'agent' as never })).rejects.toThrow(
      PraesidiaConfigError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('search POSTs the SearchMemoryDto to /memories/search', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: [MEMORY] }]);

    const memory = new PraesidiaMemory(config);
    const hits = await memory.search({
      query: 'contact preference',
      memoryKey: 'conv-1',
      topK: 5,
    });

    expect(hits).toHaveLength(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain('/organizations/org-uuid-123/memories/search');
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'contact preference',
      memoryKey: 'conv-1',
      topK: 5,
    });
  });

  it.each([
    { query: '' },
    { query: 'x'.repeat(4_097) },
    { query: 'valid', topK: 0 },
    { query: 'valid', topK: 51 },
    { query: 'valid', topK: 1.5 },
  ])('rejects backend-invalid search input: %o', async (input) => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const memory = new PraesidiaMemory(config);

    await expect(memory.search(input)).rejects.toThrow(PraesidiaConfigError);
    expect(spy).not.toHaveBeenCalled();
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
    ]);

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
    globalThis.fetch = makeFetchMock([{ ok: true, body: MEMORY }]);

    const memory = new PraesidiaMemory(config);
    await memory.get('a/../b');

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string];
    expect(url).toContain('/memories/a%2F..%2Fb');
  });

  it('delete DELETEs the memory and tolerates a 204 empty body', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, status: 204 }]);

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
    ]);

    const memory = new PraesidiaMemory(config);
    await expect(memory.get('mem-1')).rejects.toThrow(PraesidiaApiError);
  });
});
