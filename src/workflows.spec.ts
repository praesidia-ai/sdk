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
    const result = await workflows.list();
    expect(result).toEqual([{ id: 'wf-1' }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/organizations/org-1/workflows');
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

  it('triggers a run and posts to .../workflows/:id/runs', async () => {
    globalThis.fetch = makeFetchMock([{ json: { id: 'run-1', status: 'RUNNING' } }]);
    const workflows = new PraesidiaWorkflows({ apiKey: 'pk_x', orgId: 'org-1' });
    const run = await workflows.trigger('wf-1', { input: { message: 'hi' } });
    expect(run).toEqual({ id: 'run-1', status: 'RUNNING' });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/organizations/org-1/workflows/wf-1/runs');
    expect(JSON.parse(init.body as string)).toEqual({ initialInput: { message: 'hi' } });
  });
});
