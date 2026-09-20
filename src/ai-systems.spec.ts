import { describe, it, expect, vi, afterEach } from 'vitest';
import { PraesidiaAiSystems } from './ai-systems.js';
import { PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

describe('PraesidiaAiSystems', () => {
  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(
      () => new PraesidiaAiSystems({ apiKey: undefined, orgId: undefined }),
    ).toThrow(PraesidiaConfigError);
  });

  describe('AI Systems CRUD + lifecycle', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('lists AI Systems against the org-scoped endpoint', async () => {
      globalThis.fetch = makeFetchMock([
        { json: [{ id: 'sys-1' }] },
        { json: { data: [{ id: 'sys-2' }] } },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      expect(await aiSystems.list({ page: 2, limit: 25 })).toEqual([{ id: 'sys-1' }]);
      expect(await aiSystems.list()).toEqual([{ id: 'sys-2' }]);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('/organizations/org-1/ai-systems');
      expect(url).toContain('page=2');
      expect(url).toContain('limit=25');
    });

    it('rejects an invalid lifecycleStatus filter before sending a request', async () => {
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(
        aiSystems.list({ lifecycleStatus: 'archived' as never }),
      ).rejects.toThrow(PraesidiaConfigError);
    });

    it('supports listAll auto-pagination across pages', async () => {
      globalThis.fetch = makeFetchMock([
        { json: { data: [{ id: 'sys-1' }], total: 2, meta: { page: 1, limit: 1, total: 2, totalPages: 2, hasNextPage: true } } },
        { json: { data: [{ id: 'sys-2' }], total: 2, meta: { page: 2, limit: 1, total: 2, totalPages: 2, hasNextPage: false } } },
        { json: { data: [] } },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const all: unknown[] = [];
      for await (const item of aiSystems.listAll()) all.push(item);
      expect(all).toEqual([{ id: 'sys-1' }, { id: 'sys-2' }]);
    });

    it('gets a single AI System by id', async () => {
      globalThis.fetch = makeFetchMock([{ json: { id: 'sys-1', name: 'Triage bot' } }]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      expect(await aiSystems.get('sys-1')).toEqual({ id: 'sys-1', name: 'Triage bot' });
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('/ai-systems/sys-1');
    });

    it('creates an AI System via POST', async () => {
      globalThis.fetch = makeFetchMock([{ json: { id: 'sys-2', name: 'New system' } }]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await aiSystems.create({ name: 'New system' });
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(init.method).toBe('POST');
      expect(url).toContain('/organizations/org-1/ai-systems');
    });

    it('updates an AI System via PATCH', async () => {
      globalThis.fetch = makeFetchMock([{ json: { id: 'sys-1', name: 'Renamed' } }]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await aiSystems.update('sys-1', { name: 'Renamed' });
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(init.method).toBe('PATCH');
      expect(url).toContain('/ai-systems/sys-1');
    });

    it('archives and restores an AI System via POST', async () => {
      globalThis.fetch = makeFetchMock([
        { json: { id: 'sys-1', archivedAt: '2026-09-20T00:00:00Z' } },
        { json: { id: 'sys-1', archivedAt: null } },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await aiSystems.archive('sys-1');
      await aiSystems.restore('sys-1');
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toContain('/ai-systems/sys-1/archive');
      expect((calls[0]![1] as RequestInit).method).toBe('POST');
      expect(calls[1]![0]).toContain('/ai-systems/sys-1/restore');
    });
  });

  describe('AI Assets + membership + relationships', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('lists AI Assets against the org-scoped endpoint', async () => {
      globalThis.fetch = makeFetchMock([{ json: [{ id: 'asset-1' }] }]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      expect(await aiSystems.listAssets({ assetType: 'AGENT' })).toEqual([{ id: 'asset-1' }]);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('/organizations/org-1/ai-assets');
      expect(url).toContain('assetType=AGENT');
    });

    it('rejects an invalid assetType filter before sending a request', async () => {
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(
        aiSystems.listAssets({ assetType: 'NOT_A_TYPE' as never }),
      ).rejects.toThrow(PraesidiaConfigError);
    });

    it('adopts an asset via POST .../ai-assets/adopt', async () => {
      globalThis.fetch = makeFetchMock([{ json: { id: 'asset-2', discoveryStatus: 'adopted' } }]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const asset = await aiSystems.adoptAsset({ entityType: 'agent', entityId: 'agent-1' });
      expect(asset).toEqual({ id: 'asset-2', discoveryStatus: 'adopted' });
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/ai-assets/adopt');
      expect(init.method).toBe('POST');
    });

    it('attaches and detaches an asset from an AI System', async () => {
      globalThis.fetch = makeFetchMock([
        { json: { id: 'link-1', aiSystemId: 'sys-1', assetId: 'asset-2', role: 'primary' } },
        { ok: true, status: 204 },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const link = await aiSystems.attachAsset('sys-1', { assetId: 'asset-2', role: 'primary' });
      expect(link).toEqual({ id: 'link-1', aiSystemId: 'sys-1', assetId: 'asset-2', role: 'primary' });
      await expect(aiSystems.detachAsset('sys-1', 'asset-2')).resolves.toBeUndefined();
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toContain('/ai-systems/sys-1/assets');
      expect((calls[0]![1] as RequestInit).method).toBe('POST');
      expect(calls[1]![0]).toContain('/ai-systems/sys-1/assets/asset-2');
      expect((calls[1]![1] as RequestInit).method).toBe('DELETE');
    });

    it('creates and lists asset relationships (graph edges)', async () => {
      globalThis.fetch = makeFetchMock([
        { json: { id: 'rel-1', sourceAssetId: 'a', targetAssetId: 'b', relationshipType: 'USES' } },
        { json: [{ id: 'rel-1' }] },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const created = await aiSystems.createRelationship({
        sourceAssetId: 'a',
        targetAssetId: 'b',
        relationshipType: 'USES',
      });
      expect(created).toEqual({ id: 'rel-1', sourceAssetId: 'a', targetAssetId: 'b', relationshipType: 'USES' });
      expect(await aiSystems.listRelationships({ assetId: 'a' })).toEqual([{ id: 'rel-1' }]);
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toContain('/organizations/org-1/asset-relationships');
      expect((calls[0]![1] as RequestInit).method).toBe('POST');
      expect(calls[1]![0]).toContain('assetId=a');
    });

    it('rejects an invalid relationshipType filter before sending a request', async () => {
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(
        aiSystems.listRelationships({ relationshipType: 'FRIENDS_WITH' as never }),
      ).rejects.toThrow(PraesidiaConfigError);
    });
  });

  it('adopts a rotated credential in-process', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetchMock([{ json: { id: 'sys-1' } }]);
    const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_old', orgId: 'org-1' });
    aiSystems.refreshCredential('pk_new');
    await aiSystems.get('sys-1');
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0]![1]!.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_new',
    );
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
});
