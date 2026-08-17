import { describe, it, expect, vi, afterEach } from 'vitest';
import { PraesidiaAnalytics } from './analytics.js';
import { PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

describe('PraesidiaAnalytics (FINDING-1)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(() => new PraesidiaAnalytics({ apiKey: undefined, orgId: undefined })).toThrow(
      PraesidiaConfigError,
    );
  });

  it('rejects an out-of-range days value before calling the API', async () => {
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await expect(analytics.usage({ days: 0 })).rejects.toThrow(PraesidiaConfigError);
    await expect(analytics.usage({ days: 366 })).rejects.toThrow(PraesidiaConfigError);
  });

  it('usage() GETs the org-scoped analytics endpoint with ?days=', async () => {
    globalThis.fetch = makeFetchMock([{ json: { totalTasks: 42 } }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    const result = await analytics.usage({ days: 7 });
    expect(result).toEqual({ totalTasks: 42 });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/organizations/org-1/analytics');
    expect(url).toContain('days=7');
  });

  it('costTrends() GETs .../analytics/advanced/cost-trends', async () => {
    globalThis.fetch = makeFetchMock([{ json: { points: [] } }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await analytics.costTrends({ days: 30 });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/analytics/advanced/cost-trends');
  });

  it('agentPerformance() sends days and an ISO date window', async () => {
    globalThis.fetch = makeFetchMock([{ json: { agents: [] } }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await analytics.agentPerformance({
      days: 14,
      fromDate: '2026-07-01T00:00:00.000Z',
      toDate: '2026-07-14T23:59:59.000Z',
    });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/analytics/advanced/agent-performance');
    expect(url).toContain('days=14');
    expect(url).toContain('startDate=2026-07-01T00%3A00%3A00.000Z');
    expect(url).toContain('endDate=2026-07-14T23%3A59%3A59.000Z');
  });

  it.each([
    { fromDate: 'not-a-date' },
    { fromDate: '2026-02-31' },
    { fromDate: '2026-08-02', toDate: '2026-08-01' },
  ])('rejects an invalid analytics date window: %o', async (query) => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await expect(analytics.costTrends(query)).rejects.toThrow(PraesidiaConfigError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('topAgents() sends the full advanced analytics query', async () => {
    globalThis.fetch = makeFetchMock([{ json: { agents: [] } }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await analytics.topAgents({
      days: 7,
      fromDate: '2026-07-01',
      toDate: '2026-07-07',
      limit: 25,
    });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/analytics/advanced/top-agents');
    expect(url).toContain('limit=25');
    expect(url).toContain('days=7');
    expect(url).toContain('startDate=2026-07-01');
    expect(url).toContain('endDate=2026-07-07');
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { days: 366 }])(
    'topAgents() rejects backend-invalid query values: %o',
    async (query) => {
      const spy = makeFetchMock([]);
      globalThis.fetch = spy;
      const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
      await expect(analytics.topAgents(query)).rejects.toThrow(
        PraesidiaConfigError,
      );
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('export() returns raw CSV bytes', async () => {
    globalThis.fetch = makeFetchMock([{ bytes: new TextEncoder().encode('a,b\n1,2\n') }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    const bytes = await analytics.export();
    expect(new TextDecoder().decode(bytes)).toBe('a,b\n1,2\n');
  });

  it('rejects an unsafe rotated credential', () => {
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    expect(() => analytics.refreshCredential(' bad')).toThrow(PraesidiaConfigError);
  });
});
