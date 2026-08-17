import { describe, it, expect, vi, afterEach } from 'vitest';
import { PraesidiaConnections } from './connections.js';
import { PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

describe('PraesidiaConnections', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(
      () => new PraesidiaConnections({ apiKey: undefined, orgId: undefined }),
    ).toThrow(PraesidiaConfigError);
  });

  it('lists connections against the org-scoped endpoint', async () => {
    globalThis.fetch = makeFetchMock([{ json: [{ id: 'conn-1' }] }]);
    const connections = new PraesidiaConnections({ apiKey: 'pk_x', orgId: 'org-1' });
    expect(
      await connections.list({
        page: 2,
        limit: 25,
        clientAgentId: 'client-1',
        serverAgentId: 'server-1',
        mcpServerId: 'mcp-1',
        status: 'ACTIVE',
        search: 'prod',
      }),
    ).toEqual([{ id: 'conn-1' }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/organizations/org-1/connections');
    expect(url).toContain('page=2');
    expect(url).toContain('clientAgentId=client-1');
    expect(url).toContain('serverAgentId=server-1');
    expect(url).toContain('mcpServerId=mcp-1');
    expect(url).toContain('status=ACTIVE');
    expect(url).toContain('search=prod');
  });

  it('unwraps a paginated {data} envelope and supports an empty query', async () => {
    globalThis.fetch = makeFetchMock([{ json: { data: [{ id: 'conn-2' }] } }]);
    const connections = new PraesidiaConnections({ apiKey: 'pk_x', orgId: 'org-1' });
    expect(await connections.list()).toEqual([{ id: 'conn-2' }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://api.praesidia.ai/organizations/org-1/connections');
  });

  it('createAgent posts to .../connections/agent', async () => {
    globalThis.fetch = makeFetchMock([{ json: { id: 'conn-2' } }]);
    const connections = new PraesidiaConnections({ apiKey: 'pk_x', orgId: 'org-1' });
    await connections.createAgent({ clientAgentId: 'a', serverAgentId: 'b' });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/connections/agent');
  });

  it('createMcp posts to .../connections/mcp', async () => {
    globalThis.fetch = makeFetchMock([{ json: { id: 'conn-3' } }]);
    const connections = new PraesidiaConnections({ apiKey: 'pk_x', orgId: 'org-1' });
    await connections.createMcp({ name: 'x' });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/connections/mcp');
  });

  it('rejects an invalid status before calling the API', async () => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const connections = new PraesidiaConnections({ apiKey: 'pk_x', orgId: 'org-1' });
    await expect(
      // @ts-expect-error deliberately invalid status for the runtime check
      connections.updateStatus('conn-1', 'BOGUS'),
    ).rejects.toThrow(PraesidiaConfigError);
    await expect(
      connections.list({ status: 'BOGUS' as never }),
    ).rejects.toThrow(PraesidiaConfigError);
    await expect(connections.list({ limit: 101 })).rejects.toThrow(
      PraesidiaConfigError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('updateStatus PATCHes .../connections/:id/status', async () => {
    globalThis.fetch = makeFetchMock([{ json: { id: 'conn-1', status: 'ACTIVE' } }]);
    const connections = new PraesidiaConnections({ apiKey: 'pk_x', orgId: 'org-1' });
    await connections.updateStatus('conn-1', 'ACTIVE');
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/connections/conn-1/status');
    expect(init.method).toBe('PATCH');
  });

  it('covers get, create alias, delete, test, health, and credential refresh', async () => {
    globalThis.fetch = makeFetchMock([
      { json: { id: 'conn-1' } },
      { json: { id: 'conn-2' } },
      { ok: true, status: 204 },
      { json: { success: true } },
      { json: { healthy: true } },
    ]);
    const connections = new PraesidiaConnections({ apiKey: 'pk_old', orgId: 'org-1' });
    connections.refreshCredential('pk_new');

    expect(await connections.get('conn-1')).toEqual({ id: 'conn-1' });
    expect(await connections.create({ clientAgentId: 'a' })).toEqual({ id: 'conn-2' });
    await expect(connections.delete('conn-1')).resolves.toBeUndefined();
    expect(await connections.test('conn-1')).toEqual({ success: true });
    expect(await connections.health('conn-1')).toEqual({ healthy: true });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0]![1]!.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_new',
    );
    expect(calls[1]![0]).toContain('/connections/agent');
    expect(calls[2]![1]!.method).toBe('DELETE');
    expect(calls[3]![0]).toContain('/connections/conn-1/test');
    expect(calls[4]![0]).toContain('/connections/conn-1/health');
  });
});
