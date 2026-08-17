import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaAgents } from './agents.js';
import { PraesidiaGuard } from './guard.js';
import { PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PraesidiaAgents', () => {
  // ── Construction ──────────────────────────────────────────────────────────

  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(
      () => new PraesidiaAgents({ apiKey: undefined, orgId: undefined }),
    ).toThrow(PraesidiaConfigError);
  });

  // ── CRUD (FINDING-2 parity with the Python SDK's AgentsResource) ─────────────
  describe('CRUD', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('lists agents against the org-scoped endpoint', async () => {
      globalThis.fetch = makeFetchMock([
        { json: [{ id: 'agent-1' }] },
        { json: { agents: [{ id: 'agent-2' }] } },
        { json: { data: [{ id: 'agent-3' }] } },
      ]);
      const agents = new PraesidiaAgents({ apiKey: 'pk_x', orgId: 'org-1' });
      expect(await agents.list({ page: 2, limit: 25 })).toEqual([{ id: 'agent-1' }]);
      expect(await agents.list()).toEqual([{ id: 'agent-2' }]);
      expect(await agents.list()).toEqual([{ id: 'agent-3' }]);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('/organizations/org-1/agents');
      expect(url).toContain('page=2');
      expect(url).toContain('limit=25');
    });

    it('gets a single agent by id', async () => {
      globalThis.fetch = makeFetchMock([{ json: { id: 'agent-1', name: 'Bot' } }]);
      const agents = new PraesidiaAgents({ apiKey: 'pk_x', orgId: 'org-1' });
      expect(await agents.get('agent-1')).toEqual({ id: 'agent-1', name: 'Bot' });
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
      expect(url).toContain('/agents/agent-1');
    });

    it('creates an agent via POST', async () => {
      globalThis.fetch = makeFetchMock([
        { json: { id: 'agent-2', clientId: 'c-1', credentialMode: 'jit', clientSecret: null } },
      ]);
      const agents = new PraesidiaAgents({ apiKey: 'pk_x', orgId: 'org-1' });
      const created = await agents.create({ name: 'New Bot' });
      expect(created.credentialMode).toBe('jit');
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(init.method).toBe('POST');
      expect(url).toContain('/organizations/org-1/agents');
    });

    it('updates an agent via PATCH', async () => {
      globalThis.fetch = makeFetchMock([{ json: { id: 'agent-1', name: 'Renamed' } }]);
      const agents = new PraesidiaAgents({ apiKey: 'pk_x', orgId: 'org-1' });
      await agents.update('agent-1', { name: 'Renamed' });
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(init.method).toBe('PATCH');
      expect(url).toContain('/agents/agent-1');
    });

    it('deletes an agent via DELETE', async () => {
      globalThis.fetch = makeFetchMock([{ ok: true, status: 204 }]);
      const agents = new PraesidiaAgents({ apiKey: 'pk_x', orgId: 'org-1' });
      await agents.delete('agent-1');
      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(init.method).toBe('DELETE');
      expect(url).toContain('/agents/agent-1');
    });

    it('rejects invalid pagination before fetch', async () => {
      const spy = makeFetchMock([]);
      globalThis.fetch = spy;
      const agents = new PraesidiaAgents({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(agents.list({ page: 0 })).rejects.toThrow(PraesidiaConfigError);
      await expect(agents.list({ limit: 101 })).rejects.toThrow(PraesidiaConfigError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('refreshCredential swaps the Bearer token', async () => {
      globalThis.fetch = makeFetchMock([{ json: [] }]);
      const agents = new PraesidiaAgents({ apiKey: 'pk_old', orgId: 'org-1' });
      agents.refreshCredential('pk_new');
      await agents.list();
      const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer pk_new',
      );
    });
  });
});

describe('PraesidiaGuard.refreshCredential', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('swaps the credential used on subsequent guarded calls', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, body: { passed: true, triggered: [], processingTimeMs: 1 } },
    ]);

    const guard = new PraesidiaGuard({
      apiKey: 'pk_old',
      orgId: 'org-uuid-123',
    });
    guard.refreshCredential('pk_rotated');
    await guard.checkInput('hello');

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_rotated',
    );
  });

  it('throws PraesidiaConfigError in local/offline mode', () => {
    const guard = new PraesidiaGuard({ apiKey: undefined, orgId: undefined });
    expect(() => guard.refreshCredential('pk_new')).toThrow(
      PraesidiaConfigError,
    );
  });
});
