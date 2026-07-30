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

  it('topAgents() defaults limit to 10', async () => {
    globalThis.fetch = makeFetchMock([{ json: { agents: [] } }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await analytics.topAgents();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/analytics/advanced/top-agents');
    expect(url).toContain('limit=10');
  });

  it('export() returns raw CSV bytes', async () => {
    globalThis.fetch = makeFetchMock([{ bytes: new TextEncoder().encode('a,b\n1,2\n') }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    const bytes = await analytics.export();
    expect(new TextDecoder().decode(bytes)).toBe('a,b\n1,2\n');
  });
});
