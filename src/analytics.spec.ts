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

  // ── AUD-0063 — new routes: path encoding, retry classification, defaults ──

  it('agentAnalytics() percent-encodes the agentId path segment', async () => {
    globalThis.fetch = makeFetchMock([{ json: {} }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await analytics.agentAnalytics('agent/../evil', { days: 5 });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/analytics/agents/agent%2F..%2Fevil');
    expect(url).toContain('days=5');
  });

  it('agentAnalytics() rejects a bare "." or ".." agentId (path-segment guard)', async () => {
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await expect(analytics.agentAnalytics('..')).rejects.toThrow(PraesidiaConfigError);
  });

  it('anomalies() defaults to a 7-day window (matches be\'s DefaultValuePipe(7))', async () => {
    globalThis.fetch = makeFetchMock([{ json: [] }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await analytics.anomalies();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/analytics/advanced/anomalies?days=7');
  });

  it.each([
    ['costByTeam', '/analytics/advanced/cost-by-team?days=30'],
    ['modelComparison', '/analytics/advanced/model-comparison?days=30'],
  ] as const)('%s() defaults to a 30-day window', async (method, expectedSuffix) => {
    globalThis.fetch = makeFetchMock([{ json: [] }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await analytics[method]();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain(expectedSuffix);
  });

  it('captureState() GETs .../analytics/capture-state with no query', async () => {
    globalThis.fetch = makeFetchMock([
      { json: { enabled: true, piiCapture: false, sampleRate: 1, retentionDays: 90 } },
    ]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    const result = await analytics.captureState();
    expect(result).toEqual({ enabled: true, piiCapture: false, sampleRate: 1, retentionDays: 90 });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://api.praesidia.ai/organizations/org-1/analytics/capture-state');
  });

  it('events() unwraps the { data, meta } pagination envelope', async () => {
    globalThis.fetch = makeFetchMock([
      { json: { data: [{ id: 'evt-1' }], total: 1, meta: { page: 1, limit: 20 } } },
    ]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    const events = await analytics.events({ agentId: 'agent-1', page: 2, limit: 10 });
    expect(events).toEqual([{ id: 'evt-1' }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/analytics/events?');
    expect(url).toContain('agentId=agent-1');
    expect(url).toContain('page=2');
    expect(url).toContain('limit=10');
  });

  it('events() accepts a bare-array response (defensive unwrap, matches agents.list/audit.list)', async () => {
    globalThis.fetch = makeFetchMock([{ json: [{ id: 'evt-legacy' }] }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    const events = await analytics.events({ fromDate: '2026-07-01', toDate: '2026-07-31' });
    expect(events).toEqual([{ id: 'evt-legacy' }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('startDate=2026-07-01');
    expect(url).toContain('endDate=2026-07-31');
  });

  it('events() rejects an out-of-range limit before calling the API (PaginationDto parity)', async () => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await expect(analytics.events({ limit: 101 })).rejects.toThrow(PraesidiaConfigError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('activityLog() hits the PRA-QA-261 alias path with identical query semantics to events()', async () => {
    globalThis.fetch = makeFetchMock([{ json: { data: [] } }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await analytics.activityLog({ eventType: 'ERROR' });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/analytics/activity-log?eventType=ERROR');
  });

  it('recordEvent() POSTs the body as-is and is a bare, never-retried write (R-SDK-1)', async () => {
    globalThis.fetch = makeFetchMock([{ json: { id: 'evt-new', eventType: 'REQUEST' } }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    const result = await analytics.recordEvent({ eventType: 'REQUEST', agentId: 'agent-1' });
    expect(result).toEqual({ id: 'evt-new', eventType: 'REQUEST' });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.praesidia.ai/organizations/org-1/analytics/events');
    expect(init.method).toBe('POST');
    // `recordEvent` exposes no idempotencyKey option — this route is not in
    // be-core's Idempotency-Key allowlist (only POST .../tasks + A2A task
    // routes are), so a bare POST here is correctly never retried on a
    // transient 5xx (generic bare-POST-never-retried behavior is proven once,
    // client-wide, in client.spec.ts).
    expect(init.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('securityMetrics() / usageHeatmap() / complianceMetrics() send the full AnalyticsWindowQuery', async () => {
    globalThis.fetch = makeFetchMock([{ json: {} }, { json: {} }, { json: {} }]);
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await analytics.securityMetrics({ days: 14 });
    await analytics.usageHeatmap({ fromDate: '2026-07-01', toDate: '2026-07-14' });
    await analytics.complianceMetrics({ days: 60 });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(calls[0][0]).toContain('/analytics/advanced/security');
    expect(calls[0][0]).toContain('days=14');
    expect(calls[1][0]).toContain('/analytics/advanced/usage-heatmap');
    expect(calls[1][0]).toContain('startDate=2026-07-01');
    expect(calls[2][0]).toContain('/analytics/advanced/compliance');
    expect(calls[2][0]).toContain('days=60');
  });
});
