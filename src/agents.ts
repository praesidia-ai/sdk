import {
  assertPagination,
  encodePathSegment,
  PraesidiaClient,
} from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type { GuardConfig, ListAgentsQuery, AgentRecord } from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/**
 * PraesidiaAgents — agent CRUD + credential management (Q4-01, FINDING-2 parity
 * with the Python SDK's `AgentsResource`).
 *
 * Usage (zero config — reads from env vars):
 *   const agents = new PraesidiaAgents();
 *   const list = await agents.list();
 *   agents.refreshCredential(newClientSecret); // adopt in-process
 *
 * Config resolution order: constructor arg → environment variable → default.
 * Like PraesidiaCompliance there is no local/offline mode — every operation is
 * a connected, authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint base: /organizations/:orgId/agents
 * Auth: Authorization: Bearer <apiKey>.
 *
 * Task submission (`run`), polling (`poll_pending_tasks`), and task-scoped MCP
 * tool calls live on `PraesidiaGuard` (`run`/`logTask`/`trackToolCall`) — not
 * duplicated here, matching this SDK's existing organization (see
 * FIND-sdks.md FINDING-2).
 */
export class PraesidiaAgents {
  private readonly client: PraesidiaClient;
  private readonly agentsBase: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    const baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey || !orgId) {
      throw new PraesidiaConfigError(
        'PraesidiaAgents requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
      );
    }

    this.client = new PraesidiaClient(
      baseUrl,
      apiKey,
      config.requestTimeoutMs,
      config.retry,
    );
    this.agentsBase = `/organizations/${encodePathSegment(orgId, 'orgId')}/agents`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** List agents for the organization. GET .../agents (paginated). */
  async list(query: ListAgentsQuery = {}): Promise<AgentRecord[]> {
    assertPagination(query);
    const qs = buildQueryString(query);
    const result = await this.client.get<
      AgentRecord[] | { data?: AgentRecord[]; agents?: AgentRecord[] }
    >(`${this.agentsBase}${qs}`);
    if (Array.isArray(result)) return result;
    return result.data ?? result.agents ?? [];
  }

  /** Fetch a single agent by id. GET .../agents/:id. */
  async get(agentId: string): Promise<AgentRecord> {
    return this.client.get<AgentRecord>(
      `${this.agentsBase}/${encodePathSegment(agentId, 'agentId')}`,
    );
  }

  /**
   * Create a new agent. POST .../agents.
   *
   * The response carries `credentialMode` (`'jit'` | `'static'`) and
   * `clientSecret` (`string | null`). `credentialMode === 'jit'` (default for
   * ephemeral-first orgs) → `clientSecret` is `null`; the agent authenticates
   * with ephemeral JIT capability tokens minted per task instead — do not
   * expect a static secret. `credentialMode === 'static'` (legacy opt-in) →
   * `clientSecret` is the plaintext secret, shown ONCE; persist it
   * immediately. `clientId` (public, non-secret) is always returned. Never
   * log `clientSecret`.
   */
  async create(data: Record<string, unknown>): Promise<AgentRecord> {
    return this.client.post<AgentRecord>(this.agentsBase, data);
  }

  /** Partially update an agent (only supplied fields change). PATCH .../agents/:id. */
  async update(
    agentId: string,
    data: Record<string, unknown>,
  ): Promise<AgentRecord> {
    return this.client.patch<AgentRecord>(
      `${this.agentsBase}/${encodePathSegment(agentId, 'agentId')}`,
      data,
    );
  }

  /** Delete an agent. DELETE .../agents/:id. */
  async delete(agentId: string): Promise<void> {
    return this.client.del(
      `${this.agentsBase}/${encodePathSegment(agentId, 'agentId')}`,
    );
  }

  /**
   * Adopt a newly provisioned client secret in-process, at runtime
   * (zero-downtime swap).
   *
   * Call this with a freshly provisioned credential: subsequent requests from
   * this instance authenticate with the new secret, so a long-lived client can
   * swap credentials without recreating the instance or restarting the process.
   *
   * SECURITY: the credential is held only in memory and is never logged.
   */
  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}

/** Build a `?a=b&c=d` query string, omitting undefined values. */
function buildQueryString(query: ListAgentsQuery): string {
  const params: Array<[string, string]> = [];
  if (query.page !== undefined) params.push(['page', String(query.page)]);
  if (query.limit !== undefined) params.push(['limit', String(query.limit)]);
  if (params.length === 0) return '';
  const encoded = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `?${encoded}`;
}
