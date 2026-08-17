import { describe, it, expect, vi, afterEach } from 'vitest';
import { PraesidiaAudit } from './audit.js';
import { PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

describe('PraesidiaAudit', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(() => new PraesidiaAudit({ apiKey: undefined, orgId: undefined })).toThrow(
      PraesidiaConfigError,
    );
  });

  it('lists audit entries against the org-scoped endpoint', async () => {
    globalThis.fetch = makeFetchMock([{ json: [{ id: 'row-1' }] }]);
    const audit = new PraesidiaAudit({ apiKey: 'pk_x', orgId: 'org-1' });
    expect(await audit.list()).toEqual([{ id: 'row-1' }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/organizations/org-1/audit-logs');
  });

  it('unwraps the backend data envelope and serializes all list filters', async () => {
    globalThis.fetch = makeFetchMock([{ json: { data: [{ id: 'row-2' }] } }]);
    const audit = new PraesidiaAudit({ apiKey: 'pk_x', orgId: 'org-1' });
    expect(
      await audit.list({
        page: 2,
        limit: 25,
        search: 'customer 42',
        fromDate: '2026-08-01',
        toDate: '2026-08-02',
        action: 'AGENT_UPDATED',
      }),
    ).toEqual([{ id: 'row-2' }]);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('page=2');
    expect(url).toContain('limit=25');
    expect(url).toContain('search=customer%2042');
    expect(url).toContain('startDate=2026-08-01');
    expect(url).toContain('endDate=2026-08-02');
    expect(url).toContain('action=AGENT_UPDATED');
  });

  it(
    'stream() stops on an EMPTY page, not a page shorter than the requested limit ' +
      '(BUGHUNT-SDK-01 parity — the SDK clamps limit to 100, so a short-but-full ' +
      'first page must not be treated as the last one)',
    async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` }));
      globalThis.fetch = makeFetchMock([
        { json: fullPage }, // page 1: full client-clamped page; caller requested 500
        { json: [] }, // page 2: empty -> real end of stream
      ]);
      const audit = new PraesidiaAudit({ apiKey: 'pk_x', orgId: 'org-1' });
      const collected: unknown[] = [];
      for await (const event of audit.stream({ limit: 500 })) {
        collected.push(event);
      }
      expect(collected).toHaveLength(100);
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
      const [firstUrl] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string];
      expect(firstUrl).toContain('limit=100');
      expect(firstUrl).not.toContain('limit=500');
    },
  );

  it('export() GETs .../audit-logs/export and returns raw bytes', async () => {
    globalThis.fetch = makeFetchMock([{ bytes: new TextEncoder().encode('id,action\n') }]);
    const audit = new PraesidiaAudit({ apiKey: 'pk_x', orgId: 'org-1' });
    const bytes = await audit.export({
      format: 'csv',
      search: 'customer 42',
      action: 'AGENT_UPDATED',
      fromDate: '2026-08-01',
      toDate: '2026-08-02',
    });
    expect(new TextDecoder().decode(bytes)).toBe('id,action\n');
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/audit-logs/export');
    expect(url).toContain('format=csv');
    expect(url).toContain('search=customer%2042');
    expect(url).toContain('action=AGENT_UPDATED');
    expect(url).toContain('startDate=2026-08-01');
    expect(url).toContain('endDate=2026-08-02');
  });

  it('rejects an unsupported export format before fetch', async () => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const audit = new PraesidiaAudit({ apiKey: 'pk_x', orgId: 'org-1' });

    await expect(audit.export({ format: 'xml' as never })).rejects.toThrow(
      PraesidiaConfigError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects invalid pagination and date windows before fetch', async () => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const audit = new PraesidiaAudit({ apiKey: 'pk_x', orgId: 'org-1' });

    await expect(audit.list({ limit: 101 })).rejects.toThrow(PraesidiaConfigError);
    await expect(audit.list({ fromDate: 'not-a-date' })).rejects.toThrow(
      PraesidiaConfigError,
    );
    await expect(
      audit.export({ fromDate: '2026-08-02', toDate: '2026-08-01' }),
    ).rejects.toThrow(PraesidiaConfigError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an unsafe rotated credential', () => {
    const audit = new PraesidiaAudit({ apiKey: 'pk_x', orgId: 'org-1' });
    expect(() => audit.refreshCredential('bad\nkey')).toThrow(PraesidiaConfigError);
  });
});
