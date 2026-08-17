import {
  assertIsoDateRange,
  encodePathSegment,
  PraesidiaClient,
} from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type { AnalyticsResult, AnalyticsWindowQuery, GuardConfig } from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

function assertDays(days: number | undefined): void {
  if (
    days !== undefined &&
    (!Number.isInteger(days) || days < 1 || days > 365)
  ) {
    throw new PraesidiaConfigError('days must be an integer from 1 to 365');
  }
}

/**
 * PraesidiaAnalytics — organization usage/cost/performance analytics
 * (FINDING-1: the README has claimed an "analytics" capability since v0.1.0;
 * this class makes that claim true instead of only documenting it. Mirrors
 * the Python SDK's `AnalyticsResource`).
 *
 * Usage (zero config — reads from env vars):
 *   const analytics = new PraesidiaAnalytics();
 *   const usage = await analytics.usage({ days: 7 });
 *
 * Config resolution order: constructor arg → environment variable → default.
 * There is no local/offline mode — every operation is a connected,
 * authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint base: /organizations/:orgId/analytics
 * Auth: Authorization: Bearer <apiKey>. Requires ANALYTICS_VIEW / EXPORT
 * permissions; the `advanced/*` routes additionally require the
 * ADVANCED_ANALYTICS feature flag.
 */
export class PraesidiaAnalytics {
  private readonly client: PraesidiaClient;
  private readonly analyticsBase: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    const baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey || !orgId) {
      throw new PraesidiaConfigError(
        'PraesidiaAnalytics requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
      );
    }

    this.client = new PraesidiaClient(
      baseUrl,
      apiKey,
      config.requestTimeoutMs,
      config.retry,
    );
    this.analyticsBase = `/organizations/${encodePathSegment(orgId, 'orgId')}/analytics`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Aggregate usage metrics for a rolling day window. GET .../analytics. */
  async usage(query: Pick<AnalyticsWindowQuery, 'days'> = {}): Promise<AnalyticsResult> {
    assertDays(query.days);
    const qs = query.days !== undefined ? `?days=${query.days}` : '';
    return this.client.get<AnalyticsResult>(`${this.analyticsBase}${qs}`);
  }

  /** Cost-over-time data. GET .../analytics/advanced/cost-trends (ADVANCED_ANALYTICS). */
  async costTrends(query: AnalyticsWindowQuery = {}): Promise<AnalyticsResult> {
    assertWindow(query);
    const qs = buildWindowQuery(query);
    return this.client.get<AnalyticsResult>(`${this.analyticsBase}/advanced/cost-trends${qs}`);
  }

  /**
   * Per-agent performance breakdown.
   * GET .../analytics/advanced/agent-performance (ADVANCED_ANALYTICS).
   */
  async agentPerformance(
    query: AnalyticsWindowQuery = {},
  ): Promise<AnalyticsResult> {
    assertWindow(query);
    const qs = buildWindowQuery(query);
    return this.client.get<AnalyticsResult>(
      `${this.analyticsBase}/advanced/agent-performance${qs}`,
    );
  }

  /** Top agents by task volume/cost. GET .../analytics/advanced/top-agents (ADVANCED_ANALYTICS). */
  async topAgents(
    query: AnalyticsWindowQuery & { limit?: number } = {},
  ): Promise<AnalyticsResult> {
    assertWindow(query);
    const limit = query.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new PraesidiaConfigError('limit must be an integer from 1 to 100');
    }
    const params: Array<[string, string]> = [['limit', String(limit)]];
    if (query.days !== undefined) params.push(['days', String(query.days)]);
    if (query.fromDate) params.push(['startDate', query.fromDate]);
    if (query.toDate) params.push(['endDate', query.toDate]);
    const qs = '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return this.client.get<AnalyticsResult>(`${this.analyticsBase}/advanced/top-agents${qs}`);
  }

  /**
   * Export analytics data (CSV) in bulk. GET .../analytics/export.
   * Returns raw bytes (ANALYTICS_EXPORT + ADVANCED_ANALYTICS).
   */
  async export(
    query: Omit<AnalyticsWindowQuery, 'days'> = {},
  ): Promise<Uint8Array> {
    assertIsoDateRange(query.fromDate, query.toDate);
    const qs = buildWindowQuery(query);
    return this.client.getBytes(`${this.analyticsBase}/export${qs}`);
  }

  /** Adopt a rotated credential in-process (zero-downtime swap). */
  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}

/** Build a `?days=&startDate=&endDate=` query string, omitting undefined values. */
function buildWindowQuery(query: AnalyticsWindowQuery): string {
  const params: Array<[string, string]> = [];
  if (query.days !== undefined) params.push(['days', String(query.days)]);
  if (query.fromDate) params.push(['startDate', query.fromDate]);
  if (query.toDate) params.push(['endDate', query.toDate]);
  if (params.length === 0) return '';
  return (
    '?' +
    params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  );
}

function assertWindow(query: AnalyticsWindowQuery): void {
  assertDays(query.days);
  assertIsoDateRange(query.fromDate, query.toDate);
}
