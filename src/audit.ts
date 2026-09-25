import {
  assertIsoDateRange,
  assertPagination,
  encodePathSegment,
  PraesidiaClient,
} from './client.js';
import { PraesidiaConfigError } from './errors.js';
import { assertBundleDateRange } from './evidence-query.js';
import type {
  AuditBundleDownload,
  AuditBundleQuery,
  AuditBundleWindowClamp,
  AuditLogEntry,
  AuditPackageJob,
  DecisionReceipt,
  GuardConfig,
  ListAuditLogsQuery,
  RequestAuditPackageOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw new PraesidiaConfigError(`${label} must be a UUID`);
  return value;
}

/**
 * PraesidiaAudit — read-back of the organization audit log (FINDING-2 parity
 * with the Python SDK's `AuditResource`; closes the gap where a TS caller had
 * no way to list/stream/export the org audit trail via the SDK — only the
 * guardrail-trigger side-effect of `guard.run()` wrote entries, with no
 * read-back).
 *
 * Usage (zero config — reads from env vars):
 *   const audit = new PraesidiaAudit();
 *   for await (const event of audit.stream({ fromDate: '2026-01-01' })) { ... }
 *
 * Config resolution order: constructor arg → environment variable → default.
 * There is no local/offline mode — every operation is a connected,
 * authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint base: /organizations/:orgId/audit-logs
 * Auth: Authorization: Bearer <apiKey>. Requires AUDIT_VIEW (list) /
 * AUDIT_EXPORT (export) permissions.
 */
export class PraesidiaAudit {
  private readonly client: PraesidiaClient;
  private readonly auditBase: string;
  private readonly bundlePath: string;
  private readonly auditPath: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    const baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey || !orgId) {
      throw new PraesidiaConfigError(
        'PraesidiaAudit requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
      );
    }

    this.client = new PraesidiaClient(
      baseUrl,
      apiKey,
      config.requestTimeoutMs,
      config.retry,
      config.allowInsecureHttp,
    );
    this.auditBase = `/organizations/${encodePathSegment(orgId, 'orgId')}/audit-logs`;
    this.auditPath = `/organizations/${encodePathSegment(orgId, 'orgId')}/audit`;
    this.bundlePath = `/organizations/${encodePathSegment(orgId, 'orgId')}/audit/bundle`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Return a page of audit log entries. GET .../audit-logs.
   *
   * `limit` is validated against the backend maximum of 100.
   */
  async list(query: ListAuditLogsQuery = {}): Promise<AuditLogEntry[]> {
    assertPagination(query);
    assertIsoDateRange(query.fromDate, query.toDate);
    const qs = buildQueryString(query);
    const result = await this.client.get<
      AuditLogEntry[] | { data?: AuditLogEntry[]; logs?: AuditLogEntry[] }
    >(`${this.auditBase}${qs}`);
    if (Array.isArray(result)) return result;
    return result.data ?? result.logs ?? [];
  }

  /**
   * Yield audit log events as a lazy async generator, paging through
   * `/audit-logs` until the server returns an EMPTY page.
   *
   * Mirrors the Python SDK's `AuditResource.stream` fix (BUGHUNT-SDK-01): the
   * terminal condition is an empty page, NOT a short one. For compatibility,
   * a requested batch above the backend maximum is clamped client-side to 100.
   * Stopping on an empty page prevents a full-but-clamped first page from
   * silently dropping every event past the first 100.
   */
  async *stream(
    query: Omit<ListAuditLogsQuery, 'page'> = {},
  ): AsyncGenerator<AuditLogEntry, void, undefined> {
    const requestedLimit = query.limit ?? 100;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new PraesidiaConfigError('limit must be an integer greater than or equal to 1');
    }
    // The public iterator accepts a larger requested batch for compatibility,
    // but never sends a value the backend PaginationDto rejects (@Max(100)).
    const limit = Math.min(requestedLimit, 100);
    let page = 1;
    for (;;) {
      const events = await this.list({ ...query, page, limit });
      if (events.length === 0) return;
      for (const event of events) yield event;
      page += 1;
    }
  }

  /**
   * Export the audit log in bulk. GET .../audit-logs/export.
   * Returns raw bytes — write to disk or parse per `format`.
   */
  async export(
    query: Pick<
      ListAuditLogsQuery,
      'fromDate' | 'toDate' | 'search' | 'action'
    > & {
      format?: 'json' | 'csv';
    } = {},
  ): Promise<Uint8Array> {
    if (query.format !== undefined && !['json', 'csv'].includes(query.format)) {
      throw new PraesidiaConfigError('format must be json or csv');
    }
    assertIsoDateRange(query.fromDate, query.toDate);
    const params: Array<[string, string]> = [['format', query.format ?? 'json']];
    if (query.search) params.push(['search', query.search]);
    if (query.action) params.push(['action', query.action]);
    if (query.fromDate) params.push(['startDate', query.fromDate]);
    if (query.toDate) params.push(['endDate', query.toDate]);
    const qs =
      '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return this.client.getBytes(`${this.auditBase}/export${qs}`);
  }

  /**
   * Download a signed ZIP for offline verification; not the JSON/CSV log export.
   * Requires audit:read and owner/compliance-officer access with COMPLIANCE_VIEW.
   * Returns at most 128 MiB through the bounded transport. Does not verify it.
   */
  async exportBundle(query: AuditBundleQuery): Promise<Uint8Array> {
    return (await this.downloadBundle(query)).bytes;
  }

  /**
   * {@link exportBundle} plus the X-Praesidia-* window headers. The server cuts
   * the range at the last Merkle-rooted hour unless `includeUnrooted`; compare
   * `effectiveTo` with `requestedTo` (and read `windowClamp`) to see where the
   * bundle actually ends. Does not verify it: run `praesidia-verify`.
   */
  async downloadBundle(query: AuditBundleQuery): Promise<AuditBundleDownload> {
    assertBundleDateRange(query.from, query.to);
    const qs = new URLSearchParams({ from: query.from, to: query.to });
    if (query.includeUnrooted !== undefined) qs.set('includeUnrooted', String(query.includeUnrooted));
    const { bytes, headers } = await this.client.getBytesResponse(`${this.bundlePath}?${qs}`);
    return {
      bytes,
      requestedTo: headers.get('X-Praesidia-Requested-To'),
      effectiveTo: headers.get('X-Praesidia-Effective-To'),
      windowClamp: headers.get('X-Praesidia-Window-Clamp') as AuditBundleWindowClamp | null,
    };
  }

  /** Decision Receipt for one audit row. GET .../audit/:rowId/receipt. 404 when not a Decision Record. */
  async getReceipt(rowId: string): Promise<DecisionReceipt> {
    return this.client.get<DecisionReceipt>(`${this.auditPath}/${uuid(rowId, 'rowId')}/receipt`);
  }

  /**
   * Decision Receipt by the `decisionId` an interaction decision returned.
   * GET .../audit/decisions/:decisionId/receipt.
   */
  async getDecisionReceipt(decisionId: string): Promise<DecisionReceipt> {
    return this.client.get<DecisionReceipt>(
      `${this.auditPath}/decisions/${uuid(decisionId, 'decisionId')}/receipt`,
    );
  }

  /**
   * Queue a multi-artifact audit package (202). POST .../audit/packages.
   * Poll {@link getPackage} until `status` is `done`, then {@link downloadPackage}.
   * Not retried: a bare POST is not idempotent.
   */
  async requestPackage(options: RequestAuditPackageOptions = {}): Promise<AuditPackageJob> {
    assertIsoDateRange(options.from, options.to);
    const body: RequestAuditPackageOptions = {};
    if (options.from !== undefined) body.from = options.from;
    if (options.to !== undefined) body.to = options.to;
    if (options.aiSystemId !== undefined) body.aiSystemId = uuid(options.aiSystemId, 'aiSystemId');
    return this.client.post<AuditPackageJob>(`${this.auditPath}/packages`, body);
  }

  /** Status of an audit package export. GET .../audit/packages/:id. */
  async getPackage(id: string): Promise<AuditPackageJob> {
    return this.client.get<AuditPackageJob>(`${this.auditPath}/packages/${uuid(id, 'id')}`);
  }

  /**
   * Download a finished audit package ZIP (at most 128 MiB).
   * GET .../audit/packages/:id/download. Throws PraesidiaApiError 409 while
   * the export is not done, 410 once past its 7-day retention.
   * A download does not verify the package: run `praesidia-verify` on its
   * evidence/audit-bundle.zip.
   */
  async downloadPackage(id: string): Promise<Uint8Array> {
    return this.client.getBytes(`${this.auditPath}/packages/${uuid(id, 'id')}/download`);
  }

  /** Adopt a rotated credential in-process (zero-downtime swap). */
  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}

/** Build a `?a=b&c=d` query string, omitting undefined values. */
function buildQueryString(query: ListAuditLogsQuery): string {
  const params: Array<[string, string]> = [];
  if (query.page !== undefined) params.push(['page', String(query.page)]);
  if (query.limit !== undefined) params.push(['limit', String(query.limit)]);
  if (query.search) params.push(['search', query.search]);
  if (query.fromDate) params.push(['startDate', query.fromDate]);
  if (query.toDate) params.push(['endDate', query.toDate]);
  if (query.action) params.push(['action', query.action]);
  if (params.length === 0) return '';
  return (
    '?' +
    params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  );
}
