import {
  assertIsoDateRange,
  assertPagination,
  encodePathSegment,
  PraesidiaClient,
} from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type {
  AgentAnalyticsResult,
  AnalyticsAnomaly,
  AnalyticsCaptureState,
  AnalyticsEvent,
  AnalyticsEventsQuery,
  AnalyticsResult,
  AnalyticsWindowQuery,
  ComplianceMetricsResult,
  CostByTeamEntry,
  GuardConfig,
  ModelComparisonEntry,
  RecordAnalyticsEventInput,
  SecurityMetricsResult,
  UsageHeatmapResult,
} from './types.js';

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

  // ── AUD-0063 — closes the 9/10-route gap vs be's AnalyticsController ───────

  /** Per-org analytics-capture configuration. GET .../analytics/capture-state. Idempotent GET — retried per policy. */
  async captureState(): Promise<AnalyticsCaptureState> {
    return this.client.get<AnalyticsCaptureState>(`${this.analyticsBase}/capture-state`);
  }

  /** Per-agent analytics breakdown. GET .../analytics/agents/:agentId. Idempotent GET — retried per policy. */
  async agentAnalytics(
    agentId: string,
    query: Pick<AnalyticsWindowQuery, 'days'> = {},
  ): Promise<AgentAnalyticsResult> {
    assertDays(query.days);
    const qs = query.days !== undefined ? `?days=${query.days}` : '';
    return this.client.get<AgentAnalyticsResult>(
      `${this.analyticsBase}/agents/${encodePathSegment(agentId, 'agentId')}${qs}`,
    );
  }

  /**
   * Paginated raw analytics events. GET .../analytics/events. Idempotent GET —
   * retried per policy. Unwraps the `{ data, meta }` envelope, matching
   * `PraesidiaAgents.list` / `PraesidiaAudit.list`.
   */
  async events(query: AnalyticsEventsQuery = {}): Promise<AnalyticsEvent[]> {
    assertPagination(query);
    assertIsoDateRange(query.fromDate, query.toDate);
    const result = await this.client.get<
      AnalyticsEvent[] | { data?: AnalyticsEvent[] }
    >(`${this.analyticsBase}/events${buildEventsQuery(query)}`);
    return Array.isArray(result) ? result : (result.data ?? []);
  }

  /**
   * PRA-QA-261 — identical semantics to `events()`; be-core exposes this
   * alias because some browser privacy-extension tracker lists block XHR
   * paths ending in `/analytics/events`. Delegates server-side to the same
   * validated, permission-gated handler. GET .../analytics/activity-log.
   * Idempotent GET — retried per policy.
   */
  async activityLog(query: AnalyticsEventsQuery = {}): Promise<AnalyticsEvent[]> {
    assertPagination(query);
    assertIsoDateRange(query.fromDate, query.toDate);
    const result = await this.client.get<
      AnalyticsEvent[] | { data?: AnalyticsEvent[] }
    >(`${this.analyticsBase}/activity-log${buildEventsQuery(query)}`);
    return Array.isArray(result) ? result : (result.data ?? []);
  }

  /**
   * Record an analytics event. POST .../analytics/events.
   *
   * Retry classification (R-SDK-1): this path is NOT in be-core's
   * `Idempotency-Key`-honoured allowlist (only `POST .../tasks` and the A2A
   * task routes are), so this is a bare, never-retried POST — a transient
   * 5xx surfaces to the caller instead of risking a double-recorded event.
   * AUDIT-021 also gates this on `ANALYTICS_CREATE`, distinct from the
   * read-only `ANALYTICS_VIEW` every other method on this class needs, and
   * has no mintable API-key scope in be-core's taxonomy (see
   * `analytics.controller.ts`'s AUDIT-SDK-04 docblock) — authenticate with a
   * JWT bearer, not a `pk_` API key, for this call.
   */
  async recordEvent(input: RecordAnalyticsEventInput): Promise<AnalyticsEvent> {
    return this.client.post<AnalyticsEvent>(`${this.analyticsBase}/events`, input);
  }

  /** Security metrics (failed auth, rate limits, risk score). GET .../analytics/advanced/security (ADVANCED_ANALYTICS). */
  async securityMetrics(query: AnalyticsWindowQuery = {}): Promise<SecurityMetricsResult> {
    assertWindow(query);
    return this.client.get<SecurityMetricsResult>(
      `${this.analyticsBase}/advanced/security${buildWindowQuery(query)}`,
    );
  }

  /** Activity heatmap by hour/day-of-week. GET .../analytics/advanced/usage-heatmap (ADVANCED_ANALYTICS). */
  async usageHeatmap(query: AnalyticsWindowQuery = {}): Promise<UsageHeatmapResult> {
    assertWindow(query);
    return this.client.get<UsageHeatmapResult>(
      `${this.analyticsBase}/advanced/usage-heatmap${buildWindowQuery(query)}`,
    );
  }

  /** Policy/guardrail/access-review compliance metrics. GET .../analytics/advanced/compliance (ADVANCED_ANALYTICS). */
  async complianceMetrics(query: AnalyticsWindowQuery = {}): Promise<ComplianceMetricsResult> {
    assertWindow(query);
    return this.client.get<ComplianceMetricsResult>(
      `${this.analyticsBase}/advanced/compliance${buildWindowQuery(query)}`,
    );
  }

  /**
   * Connections whose error rate/latency is >2 std-dev above the org mean.
   * GET .../analytics/advanced/anomalies (ADVANCED_ANALYTICS). Default window
   * is 7 days (matches be's `DefaultValuePipe(7)` — narrower than every
   * other `days` default on this class, which default to 30).
   */
  async anomalies(
    query: Pick<AnalyticsWindowQuery, 'days'> = {},
  ): Promise<AnalyticsAnomaly[]> {
    assertDays(query.days);
    const days = query.days ?? 7;
    return this.client.get<AnalyticsAnomaly[]>(
      `${this.analyticsBase}/advanced/anomalies?days=${days}`,
    );
  }

  /** Cost allocation by team. GET .../analytics/advanced/cost-by-team (ADVANCED_ANALYTICS). */
  async costByTeam(
    query: Pick<AnalyticsWindowQuery, 'days'> = {},
  ): Promise<CostByTeamEntry[]> {
    assertDays(query.days);
    const days = query.days ?? 30;
    return this.client.get<CostByTeamEntry[]>(
      `${this.analyticsBase}/advanced/cost-by-team?days=${days}`,
    );
  }

  /** Per-model cost/latency/success-rate comparison. GET .../analytics/advanced/model-comparison (ADVANCED_ANALYTICS). */
  async modelComparison(
    query: Pick<AnalyticsWindowQuery, 'days'> = {},
  ): Promise<ModelComparisonEntry[]> {
    assertDays(query.days);
    const days = query.days ?? 30;
    return this.client.get<ModelComparisonEntry[]>(
      `${this.analyticsBase}/advanced/model-comparison?days=${days}`,
    );
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

/** Build the query string for `events()`/`activityLog()`, omitting undefined values. */
function buildEventsQuery(query: AnalyticsEventsQuery): string {
  const params: Array<[string, string]> = [];
  if (query.agentId) params.push(['agentId', query.agentId]);
  if (query.eventType) params.push(['eventType', query.eventType]);
  if (query.fromDate) params.push(['startDate', query.fromDate]);
  if (query.toDate) params.push(['endDate', query.toDate]);
  if (query.page !== undefined) params.push(['page', String(query.page)]);
  if (query.limit !== undefined) params.push(['limit', String(query.limit)]);
  if (params.length === 0) return '';
  return (
    '?' +
    params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  );
}
