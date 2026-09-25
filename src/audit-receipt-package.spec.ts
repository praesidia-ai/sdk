import { describe, it, expect, vi, afterEach } from 'vitest';
import { PraesidiaAudit } from './audit.js';
import { PraesidiaApiError, PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';
import type { AuditBundleWindowClamp } from './types.js';

const ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const BASE = 'https://api.test/organizations/org-1/audit';
const JOB = {
  id: ID,
  status: 'queued',
  error: null,
  createdAt: '2026-09-25T10:00:00.000Z',
  completedAt: null,
};

function audit() {
  return new PraesidiaAudit({
    apiKey: 'pk_x',
    orgId: 'org-1',
    baseUrl: 'https://api.test',
    retry: false,
  });
}

function call(n = 0): [string, RequestInit] {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[n] as [string, RequestInit];
}

describe('PraesidiaAudit receipts + audit packages (SDK-0326)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('getDecisionReceipt() reads audit/decisions/:decisionId/receipt', async () => {
    globalThis.fetch = makeFetchMock([{ json: { rowId: 'r', decisionId: ID } }]);
    expect(await audit().getDecisionReceipt(ID)).toEqual({ rowId: 'r', decisionId: ID });
    expect(call()[0]).toBe(`${BASE}/decisions/${ID}/receipt`);
    expect(call()[1].method).toBe('GET');
  });

  it('getReceipt() reads audit/:rowId/receipt', async () => {
    globalThis.fetch = makeFetchMock([{ json: { rowId: ID } }]);
    expect(await audit().getReceipt(ID)).toEqual({ rowId: ID });
    expect(call()[0]).toBe(`${BASE}/${ID}/receipt`);
  });

  it.each([
    ['getReceipt', (a: PraesidiaAudit) => a.getReceipt('row-1')],
    ['getDecisionReceipt', (a: PraesidiaAudit) => a.getDecisionReceipt('../x')],
    ['getPackage', (a: PraesidiaAudit) => a.getPackage('not-a-uuid')],
    ['downloadPackage', (a: PraesidiaAudit) => a.downloadPackage('')],
  ])('%s() rejects a non-UUID id before any request', async (_name, run) => {
    globalThis.fetch = makeFetchMock([{ json: {} }]);
    await expect(run(audit())).rejects.toBeInstanceOf(PraesidiaConfigError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('requestPackage() POSTs CreateAuditPackageDto fields to audit/packages', async () => {
    globalThis.fetch = makeFetchMock([{ status: 202, json: JOB }]);
    const job = await audit().requestPackage({
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-25T00:00:00Z',
      aiSystemId: ID,
    });
    expect(job).toEqual(JOB);
    const [url, init] = call();
    expect(url).toBe(`${BASE}/packages`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-25T00:00:00Z',
      aiSystemId: ID,
    });
  });

  it('requestPackage() sends an empty body by default (server defaults the range)', async () => {
    globalThis.fetch = makeFetchMock([{ status: 202, json: JOB }]);
    await audit().requestPackage();
    expect(JSON.parse(call()[1].body as string)).toEqual({});
  });

  it('requestPackage() rejects a bad aiSystemId or an inverted range', async () => {
    globalThis.fetch = makeFetchMock([{ json: JOB }]);
    await expect(audit().requestPackage({ aiSystemId: 'x' })).rejects.toBeInstanceOf(
      PraesidiaConfigError,
    );
    await expect(
      audit().requestPackage({ from: '2026-09-25', to: '2026-09-01' }),
    ).rejects.toBeInstanceOf(PraesidiaConfigError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('getPackage() reads audit/packages/:id', async () => {
    globalThis.fetch = makeFetchMock([{ json: { ...JOB, status: 'running' } }]);
    expect((await audit().getPackage(ID)).status).toBe('running');
    expect(call()[0]).toBe(`${BASE}/packages/${ID}`);
  });

  it('downloadPackage() uses the binary path and returns the zip bytes', async () => {
    globalThis.fetch = makeFetchMock([{ bytes: new Uint8Array([0x50, 0x4b, 3, 4]) }]);
    const bytes = await audit().downloadPackage(ID);
    expect(Array.from(bytes)).toEqual([0x50, 0x4b, 3, 4]);
    const [url, init] = call();
    expect(url).toBe(`${BASE}/packages/${ID}/download`);
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/octet-stream');
  });

  it.each([409, 410])('downloadPackage() surfaces a %i as PraesidiaApiError', async (status) => {
    globalThis.fetch = makeFetchMock([{ status, json: { message: 'not ready' } }]);
    const err = await audit().downloadPackage(ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect((err as PraesidiaApiError).status).toBe(status);
  });

  it('downloadBundle() sends includeUnrooted and surfaces the X-Praesidia window headers', async () => {
    globalThis.fetch = makeFetchMock([
      {
        bytes: new Uint8Array([1, 2]),
        headers: {
          'X-Praesidia-Requested-To': '2026-09-25T10:30:00.000Z',
          'X-Praesidia-Effective-To': '2026-09-25T10:00:00.000Z',
          'X-Praesidia-Window-Clamp': 'clamped_to_last_rooted_hour',
        },
      },
    ]);
    const out = await audit().downloadBundle({
      from: '2026-09-24T00:00:00Z',
      to: '2026-09-25T10:30:00Z',
      includeUnrooted: false,
    });
    expect(Array.from(out.bytes)).toEqual([1, 2]);
    expect(out).toMatchObject({
      requestedTo: '2026-09-25T10:30:00.000Z',
      effectiveTo: '2026-09-25T10:00:00.000Z',
      windowClamp: 'clamped_to_last_rooted_hour',
    });
    expect(call()[0]).toBe(
      `${BASE}/bundle?from=2026-09-24T00%3A00%3A00Z&to=2026-09-25T10%3A30%3A00Z&includeUnrooted=false`,
    );
  });

  it('downloadBundle() passes clamped_to_unrooted_gap (BE-1638) through as a typed clamp', async () => {
    globalThis.fetch = makeFetchMock([
      { bytes: new Uint8Array([1]), headers: { 'X-Praesidia-Window-Clamp': 'clamped_to_unrooted_gap' } },
    ]);
    const expected: AuditBundleWindowClamp = 'clamped_to_unrooted_gap'; // typecheck:spec fails if the union drops it
    const out = await audit().downloadBundle({ from: '2026-09-24', to: '2026-09-25' });
    expect(out.windowClamp).toBe(expected);
  });

  it('downloadBundle() reports null window fields when an older server omits the headers', async () => {
    globalThis.fetch = makeFetchMock([{ bytes: new Uint8Array([1]) }]);
    const out = await audit().downloadBundle({ from: '2026-09-24', to: '2026-09-25' });
    expect(out).toMatchObject({ requestedTo: null, effectiveTo: null, windowClamp: null });
    expect(call()[0]).not.toContain('includeUnrooted');
  });

  it('exportBundle() still returns bare bytes and forwards includeUnrooted', async () => {
    globalThis.fetch = makeFetchMock([{ bytes: new Uint8Array([7]) }]);
    const bytes = await audit().exportBundle({
      from: '2026-09-24',
      to: '2026-09-25',
      includeUnrooted: true,
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(call()[0]).toContain('includeUnrooted=true');
  });
});
