import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PraesidiaAiSystems } from './ai-systems.js';
import { PraesidiaConfigError } from './errors.js';
import {
  AI_ASSET_CLIENT_SOURCES,
  AI_ASSET_SOURCES,
  AI_ASSET_TYPES,
  ASSET_RELATIONSHIP_TYPES,
} from './types.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

// SDK-0303 — spec-path resolution mirrors `scripts/audit-api-contract.mjs`:
// BE_SWAGGER_PATH override > `../ui/swagger.json` sibling checkout (this
// monorepo's committed, gate-verified spec; be's frozen `openapi.json` export is a stale
// snapshot nothing regenerates -- see SDK-0303). Skips with a reason (never
// throws) when neither exists, so this package still builds/tests from a
// bare `sdk` clone or its published npm tarball (no `ui` sibling).
const HERE = dirname(fileURLToPath(import.meta.url));
const SWAGGER_ENV_OVERRIDE = process.env['BE_SWAGGER_PATH'];
const SWAGGER_PATH =
  SWAGGER_ENV_OVERRIDE && existsSync(resolve(process.cwd(), SWAGGER_ENV_OVERRIDE))
    ? resolve(process.cwd(), SWAGGER_ENV_OVERRIDE)
    : join(HERE, '..', '..', 'ui', 'swagger.json');
const swaggerAvailable = existsSync(SWAGGER_PATH);
if (!swaggerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[SDK-0007] no swagger.json at ${SWAGGER_PATH} (BE_SWAGGER_PATH override or ` +
      "ui/swagger.json sibling checkout) -- enum-sync check skipped so sdk still builds/tests " +
      'standalone.',
  );
}

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

    it('gets an AI System summary via GET .../ai-systems/:id/summary (SDK-0005)', async () => {
      globalThis.fetch = makeFetchMock([
        {
          json: {
            compliance: { available: true, counts: { classified: 2 } },
            risk: { available: true, counts: { open: 0 } },
            evaluations: { available: true, counts: { runs: 4 } },
            cost: { available: false, reason: 'no per-entity cost filter yet (AISYS-0025)' },
            evidence: { available: true, counts: { logs: 10 } },
            unlinkedAssets: 1,
          },
        },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const summary = await aiSystems.getSummary('sys-1');
      expect(summary.cost.available).toBe(false);
      expect(summary.unlinkedAssets).toBe(1);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('/ai-systems/sys-1/summary');
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

    it('updates AI System owners via PATCH .../ai-systems/:id/owners (SDK-0003)', async () => {
      globalThis.fetch = makeFetchMock([{ json: { id: 'sys-1', ownerId: 'user-1' } }]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await aiSystems.updateOwners('sys-1', { ownerType: 'user', ownerId: 'user-1' });
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/ai-systems/sys-1/owners');
      expect(init.method).toBe('PATCH');
    });

    it('transitions AI System lifecycle via PATCH .../ai-systems/:id/lifecycle (SDK-0003)', async () => {
      globalThis.fetch = makeFetchMock([{ json: { id: 'sys-1', lifecycleStatus: 'approved' } }]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await aiSystems.transitionLifecycle('sys-1', 'approved');
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/ai-systems/sys-1/lifecycle');
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe(JSON.stringify({ lifecycleStatus: 'approved' }));
    });

    it('rejects an invalid lifecycleStatus before sending a request (SDK-0003)', async () => {
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(
        aiSystems.transitionLifecycle('sys-1', 'archived' as never),
      ).rejects.toThrow(PraesidiaConfigError);
    });

    it('soft-deletes an AI System via DELETE .../ai-systems/:id (SDK-0003)', async () => {
      globalThis.fetch = makeFetchMock([{ ok: true, status: 204 }]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(aiSystems.delete('sys-1')).resolves.toBeUndefined();
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/ai-systems/sys-1');
      expect(init.method).toBe('DELETE');
    });

    it('creates-or-updates an AI System by externalId via PUT, idempotent on repeat (SDK-0302)', async () => {
      globalThis.fetch = makeFetchMock([
        {
          json: {
            id: 'sys-1',
            externalId: 'ext-1',
            created: true,
            changed: true,
            updatedAt: '2026-09-22T00:00:00Z',
            resource: { id: 'sys-1', externalId: 'ext-1', name: 'Support triage bot' },
          },
        },
        {
          json: {
            id: 'sys-1',
            externalId: 'ext-1',
            created: false,
            changed: false,
            updatedAt: '2026-09-22T00:00:00Z',
            resource: { id: 'sys-1', externalId: 'ext-1', name: 'Support triage bot' },
          },
        },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const body = { name: 'Support triage bot' };
      const first = await aiSystems.putSystemByExternalId('ext-1', body);
      const second = await aiSystems.putSystemByExternalId('ext-1', body);
      expect(first.created).toBe(true);
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.updatedAt).toBe(first.updatedAt);
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toContain('/ai-systems/by-external-id/ext-1');
      expect((calls[0]![1] as RequestInit).method).toBe('PUT');
    });

    it('archives an AI System by externalId via DELETE returning the outcome body (SDK-0302)', async () => {
      globalThis.fetch = makeFetchMock([
        {
          json: {
            id: 'sys-1',
            externalId: 'ext-1',
            created: false,
            changed: true,
            updatedAt: '2026-09-22T00:00:01Z',
            resource: { id: 'sys-1', externalId: 'ext-1', archivedAt: '2026-09-22T00:00:01Z' },
          },
        },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const outcome = await aiSystems.deleteSystemByExternalId('ext-1');
      expect(outcome.resource['archivedAt']).toBe('2026-09-22T00:00:01Z');
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/ai-systems/by-external-id/ext-1');
      expect(init.method).toBe('DELETE');
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

    it('creates, gets, updates, archives and restores an AI Asset (SDK-0003)', async () => {
      globalThis.fetch = makeFetchMock([
        { json: { id: 'asset-3', assetType: 'VENDOR' } },
        { json: { id: 'asset-3', name: 'Vendor Co' } },
        { json: { id: 'asset-3', name: 'Renamed Vendor' } },
        { json: { id: 'asset-3', archivedAt: '2026-09-20T00:00:00Z' } },
        { json: { id: 'asset-3', archivedAt: null } },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await aiSystems.createAsset({ name: 'Vendor Co', assetType: 'VENDOR' });
      await aiSystems.getAsset('asset-3');
      await aiSystems.updateAsset('asset-3', { name: 'Renamed Vendor' });
      await aiSystems.archiveAsset('asset-3');
      await aiSystems.restoreAsset('asset-3');
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toContain('/organizations/org-1/ai-assets');
      expect((calls[0]![1] as RequestInit).method).toBe('POST');
      expect(calls[1]![0]).toContain('/ai-assets/asset-3');
      expect((calls[1]![1] as RequestInit).method).toBe('GET');
      expect((calls[2]![1] as RequestInit).method).toBe('PATCH');
      expect(calls[3]![0]).toContain('/ai-assets/asset-3/archive');
      expect(calls[4]![0]).toContain('/ai-assets/asset-3/restore');
    });

    it('rejects an invalid assetType on createAsset before sending a request (SDK-0003)', async () => {
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(
        aiSystems.createAsset({ name: 'x', assetType: 'NOT_A_TYPE' as never }),
      ).rejects.toThrow(PraesidiaConfigError);
    });

    it('creates-or-updates an AI Asset by externalId via PUT, validating assetType first (SDK-0302)', async () => {
      globalThis.fetch = makeFetchMock([
        {
          json: {
            id: 'asset-3',
            externalId: 'ext-asset-1',
            created: true,
            changed: true,
            updatedAt: '2026-09-22T00:00:00Z',
            resource: { id: 'asset-3', externalId: 'ext-asset-1', assetType: 'VENDOR' },
          },
        },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const outcome = await aiSystems.putAssetByExternalId('ext-asset-1', {
        name: 'Vendor Co',
        assetType: 'VENDOR',
      });
      expect(outcome.created).toBe(true);
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/ai-assets/by-external-id/ext-asset-1');
      expect(init.method).toBe('PUT');
      await expect(
        aiSystems.putAssetByExternalId('ext-asset-1', {
          name: 'x',
          assetType: 'NOT_A_TYPE' as never,
        }),
      ).rejects.toThrow(PraesidiaConfigError);
    });

    it('rejects pipeline-owned sources on createAsset/putAssetByExternalId before sending (SDK-0317, BE-1529)', async () => {
      globalThis.fetch = makeFetchMock([]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      for (const source of ['runtime_observation', 'discovery_connector', 'entitlement_projection']) {
        const data = { name: 'x', assetType: 'VENDOR' as const, source: source as never };
        await expect(aiSystems.createAsset(data)).rejects.toThrow('source must be one of manual, api, import');
        await expect(aiSystems.putAssetByExternalId('ext-1', data)).rejects.toThrow(PraesidiaConfigError);
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('sends client sources on create/put and filters listAssets by any stored source (SDK-0317)', async () => {
      globalThis.fetch = makeFetchMock([
        { json: { id: 'asset-3' } },
        { json: { id: 'asset-3', externalId: 'ext-1', created: false, changed: false, resource: {} } },
        { json: [] },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await aiSystems.createAsset({ name: 'x', assetType: 'VENDOR', source: 'import' });
      await aiSystems.putAssetByExternalId('ext-1', { name: 'x', assetType: 'VENDOR', source: 'api' });
      await aiSystems.listAssets({ source: 'entitlement_projection' });
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(JSON.parse((calls[0]![1] as RequestInit).body as string).source).toBe('import');
      expect(JSON.parse((calls[1]![1] as RequestInit).body as string).source).toBe('api');
      expect(calls[2]![0]).toContain('source=entitlement_projection');
    });

    it('archives an AI Asset by externalId via DELETE returning the outcome body (SDK-0302)', async () => {
      globalThis.fetch = makeFetchMock([
        {
          json: {
            id: 'asset-3',
            externalId: 'ext-asset-1',
            created: false,
            changed: true,
            updatedAt: '2026-09-22T00:00:01Z',
            resource: { id: 'asset-3', externalId: 'ext-asset-1', archivedAt: '2026-09-22T00:00:01Z' },
          },
        },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const outcome = await aiSystems.deleteAssetByExternalId('ext-asset-1');
      expect(outcome.changed).toBe(true);
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/ai-assets/by-external-id/ext-asset-1');
      expect(init.method).toBe('DELETE');
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

    it('changes an attached asset role via PATCH .../assets/:assetId/role (SDK-0003)', async () => {
      globalThis.fetch = makeFetchMock([
        { json: { id: 'link-1', aiSystemId: 'sys-1', assetId: 'asset-2', role: 'dependency' } },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const link = await aiSystems.changeAssetRole('sys-1', 'asset-2', { role: 'dependency' });
      expect(link).toEqual({ id: 'link-1', aiSystemId: 'sys-1', assetId: 'asset-2', role: 'dependency' });
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/ai-systems/sys-1/assets/asset-2/role');
      expect(init.method).toBe('PATCH');
    });

    it('rejects an invalid role on changeAssetRole before sending a request (SDK-0003)', async () => {
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(
        aiSystems.changeAssetRole('sys-1', 'asset-2', { role: 'owner' as never }),
      ).rejects.toThrow(PraesidiaConfigError);
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

    it('gets, updates, archives and restores an asset relationship (SDK-0003)', async () => {
      globalThis.fetch = makeFetchMock([
        { json: { id: 'rel-1', relationshipType: 'USES' } },
        { json: { id: 'rel-1', relationshipType: 'CALLS', version: 2 } },
        { json: { id: 'rel-1', archivedAt: '2026-09-20T00:00:00Z', version: 3 } },
        { json: { id: 'rel-1', archivedAt: null, version: 4 } },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await aiSystems.getRelationship('rel-1');
      await aiSystems.updateRelationship('rel-1', { relationshipType: 'CALLS' });
      await aiSystems.archiveRelationship('rel-1');
      await aiSystems.restoreRelationship('rel-1');
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toContain('/asset-relationships/rel-1');
      expect((calls[0]![1] as RequestInit).method).toBe('GET');
      expect((calls[1]![1] as RequestInit).method).toBe('PATCH');
      expect(calls[2]![0]).toContain('/asset-relationships/rel-1/archive');
      expect(calls[3]![0]).toContain('/asset-relationships/rel-1/restore');
    });

    it('rejects an invalid relationshipType on updateRelationship before sending a request (SDK-0003)', async () => {
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(
        aiSystems.updateRelationship('rel-1', { relationshipType: 'FRIENDS_WITH' as never }),
      ).rejects.toThrow(PraesidiaConfigError);
    });

    it('rejects an invalid relationshipType filter before sending a request', async () => {
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(
        aiSystems.listRelationships({ relationshipType: 'FRIENDS_WITH' as never }),
      ).rejects.toThrow(PraesidiaConfigError);
    });

    it('creates-or-updates a relationship by externalId via PUT, validating relationshipType first (SDK-0302)', async () => {
      globalThis.fetch = makeFetchMock([
        {
          json: {
            id: 'rel-1',
            externalId: 'ext-rel-1',
            created: true,
            changed: true,
            updatedAt: '2026-09-22T00:00:00Z',
            resource: { id: 'rel-1', externalId: 'ext-rel-1', relationshipType: 'USES' },
          },
        },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const outcome = await aiSystems.putRelationshipByExternalId('ext-rel-1', {
        sourceAssetId: 'a',
        targetAssetId: 'b',
        relationshipType: 'USES',
      });
      expect(outcome.created).toBe(true);
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/asset-relationships/by-external-id/ext-rel-1');
      expect(init.method).toBe('PUT');
      await expect(
        aiSystems.putRelationshipByExternalId('ext-rel-1', {
          sourceAssetId: 'a',
          targetAssetId: 'b',
          relationshipType: 'FRIENDS_WITH' as never,
        }),
      ).rejects.toThrow(PraesidiaConfigError);
    });

    it('archives a relationship by externalId via DELETE returning the outcome body (SDK-0302)', async () => {
      globalThis.fetch = makeFetchMock([
        {
          json: {
            id: 'rel-1',
            externalId: 'ext-rel-1',
            created: false,
            changed: true,
            updatedAt: '2026-09-22T00:00:01Z',
            resource: { id: 'rel-1', externalId: 'ext-rel-1', archivedAt: '2026-09-22T00:00:01Z' },
          },
        },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const outcome = await aiSystems.deleteRelationshipByExternalId('ext-rel-1');
      expect(outcome.changed).toBe(true);
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/asset-relationships/by-external-id/ext-rel-1');
      expect(init.method).toBe('DELETE');
    });

    it('traverses the asset graph via GET .../asset-relationships/graph/traverse (SDK-0005)', async () => {
      globalThis.fetch = makeFetchMock([
        {
          json: {
            nodes: [{ id: 'a', assetType: 'AGENT', name: 'Agent A' }],
            edges: [],
            stats: { depth: 3, nodeCount: 1, edgeCount: 0, depthClamped: false, truncated: false },
          },
        },
      ]);
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      const result = await aiSystems.traverse({
        assetId: 'a',
        direction: 'both',
        assetTypes: ['AGENT', 'MODEL'],
      });
      expect(result.stats.nodeCount).toBe(1);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('/organizations/org-1/asset-relationships/graph/traverse');
      expect(url).toContain('assetId=a');
      expect(url).toContain('direction=both');
      expect(url).toContain('assetTypes=AGENT%2CMODEL');
    });

    it('rejects an invalid direction/assetTypes/relationshipTypes on traverse before sending a request (SDK-0005)', async () => {
      const aiSystems = new PraesidiaAiSystems({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(
        aiSystems.traverse({ assetId: 'a', direction: 'sideways' as never }),
      ).rejects.toThrow(PraesidiaConfigError);
      await expect(
        aiSystems.traverse({ assetId: 'a', assetTypes: ['NOT_A_TYPE' as never] }),
      ).rejects.toThrow(PraesidiaConfigError);
      await expect(
        aiSystems.traverse({ assetId: 'a', relationshipTypes: ['FRIENDS_WITH' as never] }),
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

  it.skipIf(!swaggerAvailable)(
    'AI_ASSET_TYPES/ASSET_RELATIONSHIP_TYPES/AI_ASSET_SOURCES match ui/swagger.json (SDK-0007, SDK-0317)',
    () => {
      // Reads the gate-verified ui/swagger.json (never regenerated here) and
      // fails if it drifts from these tuples again -- see SDK-0007/SDK-0303.
      const spec = JSON.parse(readFileSync(SWAGGER_PATH, 'utf8'));
      const schemas = spec.components.schemas;
      const openapiAssetTypes: string[] = schemas.AiAsset.properties.assetType.enum;
      const openapiRelationshipTypes: string[] =
        schemas.AssetRelationship.properties.relationshipType.enum;
      expect(new Set(AI_ASSET_TYPES)).toEqual(new Set(openapiAssetTypes));
      expect(new Set(ASSET_RELATIONSHIP_TYPES)).toEqual(new Set(openapiRelationshipTypes));
      // SDK-0317: the list filter covers every stored source; the create/put subset must stay
      // inside CreateAiAssetDto's enum (a superset until swagger is re-exported after BE-1529).
      expect(new Set(AI_ASSET_SOURCES)).toEqual(new Set(schemas.AiAsset.properties.source.enum));
      const createSources: string[] = schemas.CreateAiAssetDto.properties.source.enum;
      for (const source of AI_ASSET_CLIENT_SOURCES) expect(createSources).toContain(source);
    },
  );
});
