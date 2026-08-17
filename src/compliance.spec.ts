import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaCompliance } from './compliance.js';
import { PraesidiaApiError, PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

const CONFIG = {
  apiKey: 'pk_test_key',
  orgId: 'org-uuid-123',
};

const REQUEST_RESULT = {
  reportId: 'rep-1',
  jobId: 'job-9',
  status: 'pending',
};

const STATUS_PENDING = {
  reportId: 'rep-1',
  status: 'processing',
  ready: false,
  pdfByteLength: null,
  error: null,
  requestedAt: '2026-07-05T00:00:00.000Z',
  completedAt: null,
};

const STATUS_READY = {
  reportId: 'rep-1',
  status: 'completed',
  ready: true,
  pdfByteLength: 2048,
  error: null,
  requestedAt: '2026-07-05T00:00:00.000Z',
  completedAt: '2026-07-05T00:01:00.000Z',
};

const STATUS_FAILED = {
  reportId: 'rep-1',
  status: 'failed',
  ready: false,
  pdfByteLength: null,
  error: 'assembler exploded',
  requestedAt: '2026-07-05T00:00:00.000Z',
  completedAt: '2026-07-05T00:01:00.000Z',
};

const DOCUMENT = {
  schemaVersion: 'q1-04-v1',
  reportId: 'rep-1',
  organizationId: 'org-uuid-123',
  generatedAt: '2026-07-05T00:01:00.000Z',
  metadata: { title: 'EU AI Act Report' },
  summary: { totalDiscovered: 3, totalClassified: 2 },
  discoveredInventory: [],
  classifiedEntities: [],
  articleMatrix: [],
  tamperEvidence: { statement: 'ok' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PraesidiaCompliance', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('construction', () => {
    it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
      expect(
        () => new PraesidiaCompliance({ apiKey: undefined, orgId: undefined }),
      ).toThrow(PraesidiaConfigError);
    });
  });

  describe('requestReport', () => {
    it('POSTs to the reports endpoint and returns the id + status', async () => {
      globalThis.fetch = makeFetchMock([{ ok: true, json: REQUEST_RESULT }]);

      const compliance = new PraesidiaCompliance(CONFIG);
      const result = await compliance.requestReport();

      expect(result.reportId).toBe('rep-1');
      expect(result.jobId).toBe('job-9');
      expect(result.status).toBe('pending');

      const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      expect(url).toContain(
        '/organizations/org-uuid-123/compliance/eu-ai-act/reports',
      );
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer pk_test_key',
      );
    });
  });

  describe('getReportStatus', () => {
    it('GETs the status endpoint for the report id', async () => {
      globalThis.fetch = makeFetchMock([{ ok: true, json: STATUS_READY }]);

      const compliance = new PraesidiaCompliance(CONFIG);
      const status = await compliance.getReportStatus('rep-1');

      expect(status.ready).toBe(true);
      expect(status.pdfByteLength).toBe(2048);

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string];
      expect(url).toContain(
        '/organizations/org-uuid-123/compliance/eu-ai-act/reports/rep-1',
      );
    });
  });

  describe('getReportJson', () => {
    it('returns the structured document', async () => {
      globalThis.fetch = makeFetchMock([{ ok: true, json: DOCUMENT }]);

      const compliance = new PraesidiaCompliance(CONFIG);
      const doc = await compliance.getReportJson('rep-1');

      expect(doc.schemaVersion).toBe('q1-04-v1');
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string];
      expect(url).toContain('/reports/rep-1/json');
    });

    it('surfaces a 409 as PraesidiaApiError when the report is not complete', async () => {
      globalThis.fetch = makeFetchMock([
        { ok: false, status: 409, text: 'Report not completed' },
      ]);

      const compliance = new PraesidiaCompliance(CONFIG);
      await expect(compliance.getReportJson('rep-1')).rejects.toThrow(
        PraesidiaApiError,
      );
    });
  });

  describe('getReportPdf', () => {
    it('returns raw PDF bytes', async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
      globalThis.fetch = makeFetchMock([{ ok: true, bytes: pdfBytes }]);

      const compliance = new PraesidiaCompliance(CONFIG);
      const bytes = await compliance.getReportPdf('rep-1');

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string];
      expect(url).toContain('/reports/rep-1/pdf');
    });
  });

  describe('waitForReport', () => {
    it('polls until the report is ready', async () => {
      globalThis.fetch = makeFetchMock([
        { ok: true, json: STATUS_PENDING },
        { ok: true, json: STATUS_PENDING },
        { ok: true, json: STATUS_READY },
      ]);

      const compliance = new PraesidiaCompliance(CONFIG);
      const status = await compliance.waitForReport('rep-1', {
        pollIntervalMs: 1,
        timeoutMs: 5000,
      });

      expect(status.ready).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('throws when the report fails', async () => {
      globalThis.fetch = makeFetchMock([{ ok: true, json: STATUS_FAILED }]);

      const compliance = new PraesidiaCompliance(CONFIG);
      await expect(
        compliance.waitForReport('rep-1', { pollIntervalMs: 1 }),
      ).rejects.toThrow(/failed: assembler exploded/);
    });

    it('throws on timeout when the report never becomes ready', async () => {
      globalThis.fetch = makeFetchMock([{ ok: true, json: STATUS_PENDING }]);

      const compliance = new PraesidiaCompliance(CONFIG);
      await expect(
        compliance.waitForReport('rep-1', {
          pollIntervalMs: 5,
          timeoutMs: 1,
        }),
      ).rejects.toThrow(/Timed out/);
    });

    it.each([
      { pollIntervalMs: -1 },
      { pollIntervalMs: Number.NaN },
      { timeoutMs: 0 },
      { timeoutMs: 2_147_483_648 },
    ])('rejects invalid polling timers: %o', async (opts) => {
      globalThis.fetch = makeFetchMock([]);
      const compliance = new PraesidiaCompliance(CONFIG);
      await expect(compliance.waitForReport('rep-1', opts)).rejects.toThrow(
        PraesidiaConfigError,
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('generateAndWait', () => {
    it('requests then polls to a ready status', async () => {
      globalThis.fetch = makeFetchMock([
        { ok: true, json: REQUEST_RESULT }, // POST create
        { ok: true, json: STATUS_PENDING }, // poll 1
        { ok: true, json: STATUS_READY }, // poll 2
      ]);

      const compliance = new PraesidiaCompliance(CONFIG);
      const status = await compliance.generateAndWait({ pollIntervalMs: 1 });

      expect(status.ready).toBe(true);
      expect(status.reportId).toBe('rep-1');
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it.each([
      { timeoutMs: 0 },
      { pollIntervalMs: Number.NaN },
    ])('validates polling options before enqueueing: %o', async (opts) => {
      const spy = makeFetchMock([]);
      globalThis.fetch = spy;
      const compliance = new PraesidiaCompliance(CONFIG);

      await expect(compliance.generateAndWait(opts)).rejects.toThrow(
        PraesidiaConfigError,
      );
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
