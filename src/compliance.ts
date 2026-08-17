import { encodePathSegment, PraesidiaClient } from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type {
  AuditorReportDocument,
  AuditorReportStatus,
  GuardConfig,
  ReportPollOptions,
  ReportRequestResult,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * PraesidiaCompliance — programmatic export of the EU AI Act auditor/DPO
 * compliance report (Q1-04).
 *
 * Report generation is asynchronous: request a report, poll its status until
 * it is `ready`, then download the structured JSON and/or the rendered PDF.
 *
 * Usage (zero config — reads from env vars):
 *   const compliance = new PraesidiaCompliance();
 *   const status = await compliance.generateAndWait();
 *   const doc = await compliance.getReportJson(status.reportId);
 *   const pdf = await compliance.getReportPdf(status.reportId);
 *   fs.writeFileSync('report.pdf', Buffer.from(pdf));
 *
 * Config resolution order: constructor arg → environment variable → default.
 * Unlike PraesidiaGuard there is no local/offline mode — every operation is a
 * connected, authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint base: /organizations/:orgId/compliance/eu-ai-act/reports
 * Auth: Authorization: Bearer <apiKey>. Requires COMPLIANCE_MANAGE (create)
 * and COMPLIANCE_VIEW (status/download) permissions.
 *
 * AUDIT-SDK-04 — genuinely API-key-reachable: the auditor-report controller's
 * route guard was opened to API keys (be-core commit 0bff5a0a), so a personal
 * `pk_` Bearer key whose owner holds COMPLIANCE_VIEW/MANAGE in the org
 * authenticates here (scoped by OrgMembershipGuard + PermissionsGuard) exactly
 * like a dashboard JWT.
 */
export class PraesidiaCompliance {
  private readonly orgId: string;
  private readonly baseUrl: string;
  private readonly client: PraesidiaClient;
  private readonly reportsBase: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    this.baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey || !orgId) {
      throw new PraesidiaConfigError(
        'PraesidiaCompliance requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
      );
    }

    this.orgId = encodePathSegment(orgId, 'orgId');
    this.client = new PraesidiaClient(
      this.baseUrl,
      apiKey,
      config.requestTimeoutMs,
      config.retry,
    );
    this.reportsBase = `/organizations/${this.orgId}/compliance/eu-ai-act/reports`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Enqueue a new auditor report. Returns the reportId used to poll status and
   * download artifacts. POST .../reports (requires COMPLIANCE_MANAGE).
   */
  async requestReport(): Promise<ReportRequestResult> {
    return this.client.post<ReportRequestResult>(this.reportsBase, {});
  }

  /**
   * Fetch the current generation status of a report.
   * GET .../reports/:reportId (requires COMPLIANCE_VIEW).
   */
  async getReportStatus(reportId: string): Promise<AuditorReportStatus> {
    return this.client.get<AuditorReportStatus>(
      `${this.reportsBase}/${encodePathSegment(reportId, 'reportId')}`,
    );
  }

  /**
   * Download the structured JSON auditor report (schemaVersion 'q1-04-v1').
   * GET .../reports/:reportId/json (requires COMPLIANCE_VIEW).
   * Throws PraesidiaApiError with status 409 if the report is not yet complete.
   */
  async getReportJson(reportId: string): Promise<AuditorReportDocument> {
    return this.client.get<AuditorReportDocument>(
      `${this.reportsBase}/${encodePathSegment(reportId, 'reportId')}/json`,
    );
  }

  /**
   * Download the rendered PDF auditor report as raw bytes.
   * GET .../reports/:reportId/pdf (requires COMPLIANCE_VIEW).
   * Throws PraesidiaApiError with status 409 if the report is not yet complete.
   *
   * In Node, write to disk with `fs.writeFileSync(path, Buffer.from(bytes))`.
   */
  async getReportPdf(reportId: string): Promise<Uint8Array> {
    return this.client.getBytes(
      `${this.reportsBase}/${encodePathSegment(reportId, 'reportId')}/pdf`,
    );
  }

  /**
   * Poll a report's status until it is ready (or fails / times out).
   *
   * Resolves with the final `ready` status. Throws:
   *   - Error if the report status becomes `failed` (message includes the
   *     server-provided reason).
   *   - Error if `timeoutMs` elapses before the report is ready.
   */
  async waitForReport(
    reportId: string,
    opts: ReportPollOptions = {},
  ): Promise<AuditorReportStatus> {
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertTimerValue(pollIntervalMs, 'pollIntervalMs', true);
    assertTimerValue(timeoutMs, 'timeoutMs', false);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const status = await this.getReportStatus(reportId);

      if (status.status === 'failed') {
        throw new Error(
          `Praesidia report ${reportId} failed: ${status.error ?? 'unknown error'}`,
        );
      }
      if (status.ready) {
        return status;
      }
      if (Date.now() + pollIntervalMs > deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for Praesidia report ${reportId} ` +
            `(last status: ${status.status})`,
        );
      }

      await sleep(pollIntervalMs);
    }
  }

  /**
   * Convenience helper: request a new report and poll until it is ready.
   * Resolves with the final `ready` status (which carries the reportId); call
   * getReportJson / getReportPdf with `status.reportId` to download artifacts.
   */
  async generateAndWait(
    opts: ReportPollOptions = {},
  ): Promise<AuditorReportStatus> {
    assertTimerValue(
      opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
      true,
    );
    assertTimerValue(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs', false);
    const { reportId } = await this.requestReport();
    return this.waitForReport(reportId, opts);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertTimerValue(
  value: number,
  label: string,
  allowZero: boolean,
): void {
  if (
    !Number.isInteger(value) ||
    (allowZero ? value < 0 : value < 1) ||
    value > 2_147_483_647
  ) {
    throw new PraesidiaConfigError(
      `${label} must be an integer from ${allowZero ? 0 : 1} to 2147483647`,
    );
  }
}
