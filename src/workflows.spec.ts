import { describe, it, expect, vi, afterEach } from 'vitest';
import { PraesidiaWorkflows } from './workflows.js';
import { PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

describe('PraesidiaWorkflows', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(
      () => new PraesidiaWorkflows({ apiKey: undefined, orgId: undefined }),
    ).toThrow(PraesidiaConfigError);
  });

  it('lists workflows against the org-scoped endpoint', async () => {
    globalThis.fetch = makeFetchMock([{ json: [{ id: 'wf-1' }] }]);
    const workflows = new PraesidiaWorkflows({ apiKey: 'pk_x', orgId: 'org-1' });
    const result = await workflows.list({ page: 2, limit: 25, status: 'ACTIVE' });
    expect(result).toEqual([{ id: 'wf-1' }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/organizations/org-1/workflows');
    expect(url).toContain('page=2');
    expect(url).toContain('limit=25');
    expect(url).toContain('status=ACTIVE');
  });

  it('unwraps a paginated {data} envelope', async () => {
    globalThis.fetch = makeFetchMock([{ json: { data: [{ id: 'wf-2' }] } }]);
    const workflows = new PraesidiaWorkflows({ apiKey: 'pk_x', orgId: 'org-1' });
    expect(await workflows.list()).toEqual([{ id: 'wf-2' }]);
  });

  it('rejects a negative budgetLimitUsd before calling the API', async () => {
    const workflows = new PraesidiaWorkflows({ apiKey: 'pk_x', orgId: 'org-1' });
    await expect(
      workflows.trigger('wf-1', { budgetLimitUsd: -1 }),
    ).rejects.toThrow(PraesidiaConfigError);
  });

  it('rejects invalid list filters before calling the API', async () => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const workflows = new PraesidiaWorkflows({ apiKey: 'pk_x', orgId: 'org-1' });
    await expect(workflows.list({ page: 0 })).rejects.toThrow(PraesidiaConfigError);
    await expect(
      workflows.list({ status: 'DELETED' as never }),
    ).rejects.toThrow(PraesidiaConfigError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('triggers a run and posts to .../workflows/:id/runs', async () => {
    globalThis.fetch = makeFetchMock([{ json: { id: 'run-1', status: 'RUNNING' } }]);
    const workflows = new PraesidiaWorkflows({ apiKey: 'pk_x', orgId: 'org-1' });
    const run = await workflows.trigger('wf-1', {
      input: { message: 'hi' },
      budgetLimitUsd: 12.5,
    });
    expect(run).toEqual({ id: 'run-1', status: 'RUNNING' });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/organizations/org-1/workflows/wf-1/runs');
    expect(JSON.parse(init.body as string)).toEqual({
      initialInput: { message: 'hi' },
      budgetLimitUsd: 12.5,
    });
  });

  it('covers workflow CRUD, run listing/get, and credential refresh', async () => {
    globalThis.fetch = makeFetchMock([
      { json: { id: 'wf-1' } },
      { json: { id: 'wf-1' } },
      { json: { id: 'wf-1', name: 'Updated' } },
      { ok: true, status: 204 },
      { json: { runs: [{ id: 'run-1' }] } },
      { json: { id: 'run-1' } },
    ]);
    const workflows = new PraesidiaWorkflows({ apiKey: 'pk_old', orgId: 'org-1' });
    workflows.refreshCredential('pk_new');

    expect(await workflows.get('wf-1')).toEqual({ id: 'wf-1' });
    expect(await workflows.create({ name: 'Review' })).toEqual({ id: 'wf-1' });
    expect(await workflows.update('wf-1', { name: 'Updated' })).toEqual({
      id: 'wf-1',
      name: 'Updated',
    });
    await expect(workflows.delete('wf-1')).resolves.toBeUndefined();
    expect(await workflows.listRuns('wf-1', { page: 2, limit: 5 })).toEqual([
      { id: 'run-1' },
    ]);
    expect(await workflows.getRun('wf-1', 'run-1')).toEqual({ id: 'run-1' });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0]![1]!.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_new',
    );
    expect(calls[1]![0]).toContain('/organizations/org-1/workflows');
    expect(calls[2]![1]!.method).toBe('PATCH');
    expect(calls[3]![1]!.method).toBe('DELETE');
    expect(calls[4]![0]).toContain('/workflows/wf-1/runs?page=2&limit=5');
    expect(calls[5]![0]).toContain('/workflows/wf-1/runs/run-1');
  });
});
