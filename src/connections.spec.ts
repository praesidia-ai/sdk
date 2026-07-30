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
    expect(await connections.list()).toEqual([{ id: 'conn-1' }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/organizations/org-1/connections');
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
    const connections = new PraesidiaConnections({ apiKey: 'pk_x', orgId: 'org-1' });
    await expect(
      // @ts-expect-error deliberately invalid status for the runtime check
      connections.updateStatus('conn-1', 'BOGUS'),
    ).rejects.toThrow(PraesidiaConfigError);
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
});
