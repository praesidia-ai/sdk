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

  it(
    'stream() stops on an EMPTY page, not a page shorter than the requested limit ' +
      '(BUGHUNT-SDK-01 parity — the server clamps limit to 100, so a short-but-full ' +
      'first page must not be treated as the last one)',
    async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` }));
      globalThis.fetch = makeFetchMock([
        { json: fullPage }, // page 1: full (clamped) page, requested limit was 500
        { json: [] }, // page 2: empty -> real end of stream
      ]);
      const audit = new PraesidiaAudit({ apiKey: 'pk_x', orgId: 'org-1' });
      const collected: unknown[] = [];
      for await (const event of audit.stream({ limit: 500 })) {
        collected.push(event);
      }
      expect(collected).toHaveLength(100);
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    },
  );

  it('export() GETs .../audit-logs/export and returns raw bytes', async () => {
    globalThis.fetch = makeFetchMock([{ bytes: new TextEncoder().encode('id,action\n') }]);
    const audit = new PraesidiaAudit({ apiKey: 'pk_x', orgId: 'org-1' });
    const bytes = await audit.export({ format: 'csv' });
    expect(new TextDecoder().decode(bytes)).toBe('id,action\n');
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/audit-logs/export');
    expect(url).toContain('format=csv');
  });
});
