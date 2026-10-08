import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PraesidiaAgents, PraesidiaConnections, PraesidiaWorkflows, PraesidiaAiSystems,
  PraesidiaConfigError, CROSS_BORDER_STATUSES } from './index.js';
import type { ListAgentsQuery, ListConnectionsQuery, ListWorkflowsQuery,
  ListAssetRelationshipsQuery, ListAiSystemLifecycleRequestsQuery,
  CreateAssetRelationshipInput, UpdateAssetRelationshipInput } from './types.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

// Same query contract is replayed in the Python SDK. Values include characters
// requiring URL encoding; every field comes from the backend's list DTOs.
const fixture = JSON.parse(readFileSync(new URL('../test-fixtures/management-query-v1.json', import.meta.url), 'utf8'));
const config = { apiKey: 'pk_test', orgId: 'org-1' };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

const cases = [
  ['agents', (q: object) => new PraesidiaAgents(config).list(q as ListAgentsQuery)],
  ['connections', (q: object) => new PraesidiaConnections(config).list(q as ListConnectionsQuery)],
  ['workflows', (q: object) => new PraesidiaWorkflows(config).list(q as ListWorkflowsQuery)],
  ['asset-relationships', (q: object) => new PraesidiaAiSystems(config).listRelationships(q as ListAssetRelationshipsQuery)],
  ['ai-systems/lifecycle-requests', (q: object) => new PraesidiaAiSystems(config).listLifecycleRequests(q as ListAiSystemLifecycleRequestsQuery)],
] as const;

describe('app management query contract', () => {
  it.each(cases)('forwards every %s filter with the backend field names', async (route, call) => {
    const query = { ...fixture[route].query };
    if (route === 'asset-relationships') query.includeArchived = false;
    globalThis.fetch = makeFetchMock([{ json: { data: [{ id: 'row-1' }] } }]);
    expect(await call(query)).toEqual([{ id: 'row-1' }]);
    const url = new URL((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url.pathname).toBe(`/organizations/org-1/${route}`);
    expect(Object.fromEntries(url.searchParams)).toEqual(
      Object.fromEntries(Object.entries(fixture[route].query).map(([key, value]) => [key, String(value)])),
    );
  });

  it.each(['role', 'status', 'visibility', 'tier', 'scope'])('rejects an invalid agent %s before sending', async (field) => {
    globalThis.fetch = makeFetchMock([]);
    await expect(new PraesidiaAgents(config).list({ [field]: 'invalid' })).rejects.toThrow(PraesidiaConfigError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('preserves agent filters on every page of listAll', async () => {
    globalThis.fetch = makeFetchMock([{ json: { data: [{ id: '1' }] } }, { json: { data: [{ id: '2' }] } }, { json: { data: [] } }]);
    const rows = [];
    for await (const row of new PraesidiaAgents(config).listAll({ tier: 'OBSERVED', skillTag: 'maps', limit: 1 })) rows.push(row);
    expect(rows).toHaveLength(2);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map(([url]) => Object.fromEntries(new URL(url).searchParams))).toEqual(
      [1, 2, 3].map(page => ({ page: String(page), limit: '1', tier: 'OBSERVED', skillTag: 'maps' })),
    );
  });

  it('rejects an invalid cross-border filter', async () => {
    globalThis.fetch = makeFetchMock([]);
    await expect(new PraesidiaAiSystems(config).listRelationships({ crossBorderStatus: 'invalid' as never })).rejects.toThrow(PraesidiaConfigError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect([...CROSS_BORDER_STATUSES].sort()).toEqual([...fixture['asset-relationships'].enums.crossBorderStatus].sort());
  });

  it('sends numeric relationship confidence and preserves null geography clears', async () => {
    const create: CreateAssetRelationshipInput = { sourceAssetId: 'source', targetAssetId: 'target', relationshipType: 'WRITES',
      confidence: 0.8, sourceGeography: 'EU', processingGeography: 'DE', destinationGeography: 'US',
      vendorAiAssetId: 'vendor', crossBorderStatus: 'review_required' };
    const update: UpdateAssetRelationshipInput = { confidence: 1, sourceGeography: null,
      processingGeography: null, destinationGeography: null, vendorAiAssetId: null, crossBorderStatus: 'compliant' };
    globalThis.fetch = makeFetchMock([{ json: { id: 'edge' } }, { json: { id: 'edge' } }]);
    const systems = new PraesidiaAiSystems(config);
    await systems.createRelationship(create);
    await systems.updateRelationship('edge', update);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([create, update]);
  });

  const specPath = process.env['BE_SWAGGER_PATH'] ?? new URL('../../be/openapi.json', import.meta.url).pathname;
  it.skipIf(!existsSync(specPath) && process.env['REQUIRE_SWAGGER'] !== '1')('covers all query fields and enums in the current backend spec', () => {
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    for (const [route, contract] of Object.entries(fixture) as [string, { query: object; enums: Record<string, string[]> }][]) {
      const params = spec.paths[`/organizations/{orgId}/${route}`].get.parameters.filter((p: { in: string }) => p.in === 'query');
      expect(params.map((p: { name: string }) => p.name).sort(), route).toEqual(Object.keys(contract.query).sort());
      for (const [name, values] of Object.entries(contract.enums)) {
        let schema = params.find((p: { name: string }) => p.name === name).schema;
        if (schema.$ref) schema = spec.components.schemas[schema.$ref.split('/').pop()];
        expect([...schema.enum].sort(), `${route}.${name}`).toEqual([...values].sort());
      }
    }
  });
});
