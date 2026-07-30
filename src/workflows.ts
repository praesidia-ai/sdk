import { encodePathSegment, PraesidiaClient } from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type {
  GuardConfig,
  ListWorkflowRunsQuery,
  ListWorkflowsQuery,
  TriggerWorkflowOptions,
  WorkflowRecord,
  WorkflowRunRecord,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/**
 * PraesidiaWorkflows — approval workflow management (FINDING-2 parity with
 * the Python SDK's `WorkflowsResource`).
 *
 * Usage (zero config — reads from env vars):
 *   const workflows = new PraesidiaWorkflows();
 *   const run = await workflows.trigger(workflowId, { input: { message: '...' } });
 *
 * Config resolution order: constructor arg → environment variable → default.
 * There is no local/offline mode — every operation is a connected,
 * authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint base: /organizations/:orgId/workflows
 * Auth: Authorization: Bearer <apiKey>. Requires the APPROVAL_WORKFLOWS
 * feature and WORKFLOWS_* permissions.
 */
export class PraesidiaWorkflows {
  private readonly client: PraesidiaClient;
  private readonly workflowsBase: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    const baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey || !orgId) {
      throw new PraesidiaConfigError(
        'PraesidiaWorkflows requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
      );
    }

    this.client = new PraesidiaClient(
      baseUrl,
      apiKey,
      config.requestTimeoutMs,
      config.retry,
    );
    this.workflowsBase = `/organizations/${encodePathSegment(orgId, 'orgId')}/workflows`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** List workflows for the organization. GET .../workflows (paginated). */
  async list(query: ListWorkflowsQuery = {}): Promise<WorkflowRecord[]> {
    const qs = buildPageQuery(query);
    const result = await this.client.get<
      WorkflowRecord[] | { data?: WorkflowRecord[]; workflows?: WorkflowRecord[] }
    >(`${this.workflowsBase}${qs}`);
    if (Array.isArray(result)) return result;
    return result.data ?? result.workflows ?? [];
  }

  /** Fetch a single workflow by id. GET .../workflows/:id. */
  async get(workflowId: string): Promise<WorkflowRecord> {
    return this.client.get<WorkflowRecord>(
      `${this.workflowsBase}/${encodePathSegment(workflowId, 'workflowId')}`,
    );
  }

  /** Create a new workflow. POST .../workflows. */
  async create(data: Record<string, unknown>): Promise<WorkflowRecord> {
    return this.client.post<WorkflowRecord>(this.workflowsBase, data);
  }

  /** Partially update a workflow. PATCH .../workflows/:id. */
  async update(
    workflowId: string,
    data: Record<string, unknown>,
  ): Promise<WorkflowRecord> {
    return this.client.patch<WorkflowRecord>(
      `${this.workflowsBase}/${encodePathSegment(workflowId, 'workflowId')}`,
      data,
    );
  }

  /** Delete a workflow. DELETE .../workflows/:id. */
  async delete(workflowId: string): Promise<void> {
    return this.client.del(
      `${this.workflowsBase}/${encodePathSegment(workflowId, 'workflowId')}`,
    );
  }

  /**
   * Start a new run for a workflow. POST .../workflows/:id/runs.
   *
   * @throws PraesidiaConfigError if `budgetLimitUsd` is negative.
   */
  async trigger(
    workflowId: string,
    options: TriggerWorkflowOptions = {},
  ): Promise<WorkflowRunRecord> {
    if (
      options.budgetLimitUsd !== undefined &&
      (typeof options.budgetLimitUsd !== 'number' ||
        !Number.isFinite(options.budgetLimitUsd) ||
        options.budgetLimitUsd < 0)
    ) {
      throw new PraesidiaConfigError(
        'budgetLimitUsd must be a non-negative number',
      );
    }
    const body: Record<string, unknown> = { initialInput: options.input ?? {} };
    if (options.budgetLimitUsd !== undefined) {
      body['budgetLimitUsd'] = options.budgetLimitUsd;
    }
    return this.client.post<WorkflowRunRecord>(
      `${this.workflowsBase}/${encodePathSegment(workflowId, 'workflowId')}/runs`,
      body,
    );
  }

  /** List execution runs for a workflow. GET .../workflows/:id/runs (paginated). */
  async listRuns(
    workflowId: string,
    query: ListWorkflowRunsQuery = {},
  ): Promise<WorkflowRunRecord[]> {
    const qs = buildPageQuery(query);
    const result = await this.client.get<
      WorkflowRunRecord[] | { data?: WorkflowRunRecord[]; runs?: WorkflowRunRecord[] }
    >(
      `${this.workflowsBase}/${encodePathSegment(workflowId, 'workflowId')}/runs${qs}`,
    );
    if (Array.isArray(result)) return result;
    return result.data ?? result.runs ?? [];
  }

  /** Fetch a specific workflow run. GET .../workflows/:id/runs/:runId. */
  async getRun(workflowId: string, runId: string): Promise<WorkflowRunRecord> {
    return this.client.get<WorkflowRunRecord>(
      `${this.workflowsBase}/${encodePathSegment(workflowId, 'workflowId')}` +
        `/runs/${encodePathSegment(runId, 'runId')}`,
    );
  }

  /** Adopt a rotated credential in-process (zero-downtime swap). */
  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}

/** Build a `?page=&limit=` query string, omitting undefined values. */
function buildPageQuery(query: {
  page?: number;
  limit?: number;
}): string {
  const params: Array<[string, string]> = [];
  if (query.page !== undefined) params.push(['page', String(query.page)]);
  if (query.limit !== undefined) params.push(['limit', String(query.limit)]);
  if (params.length === 0) return '';
  return (
    '?' +
    params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  );
}
