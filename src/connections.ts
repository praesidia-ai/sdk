import {
  assertPagination,
  encodePathSegment,
  PraesidiaClient,
} from './client.js';
import { PraesidiaConfigError } from './errors.js';
import {
  normalizePagedEnvelope,
  paginateAll,
  type PaginatedEnvelope,
} from './pagination.js';
import type {
  ConnectionRecord,
  ConnectionStatus,
  GuardConfig,
  ListConnectionsQuery,
} from './types.js';
import { CONNECTION_STATUSES } from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/**
 * PraesidiaConnections — agent-to-agent / agent-to-MCP connection management
 * (FINDING-2 parity with the Python SDK's `ConnectionsResource`).
 *
 * Usage (zero config — reads from env vars):
 *   const connections = new PraesidiaConnections();
 *   const conn = await connections.createAgent({ clientAgentId, serverAgentId });
 *
 * Config resolution order: constructor arg → environment variable → default.
 * There is no local/offline mode — every operation is a connected,
 * authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint base: /organizations/:orgId/connections
 * Auth: Authorization: Bearer <apiKey>. Requires the A2A_COMMUNICATION
 * feature and CONNECTIONS_* permissions.
 */
export class PraesidiaConnections {
  private readonly client: PraesidiaClient;
  private readonly connectionsBase: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    const baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey || !orgId) {
      throw new PraesidiaConfigError(
        'PraesidiaConnections requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
      );
    }

    this.client = new PraesidiaClient(
      baseUrl,
      apiKey,
      config.requestTimeoutMs,
      config.retry,
    );
    this.connectionsBase = `/organizations/${encodePathSegment(orgId, 'orgId')}/connections`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * List connections for the organization. GET .../connections (paginated +
   * filterable).
   *
   * SCAN2-011 — returns only the requested page as a bare array, exactly as
   * before (backwards compatible); use {@link listPage} for the full envelope
   * or {@link listAll} to auto-paginate through every connection.
   */
  async list(query: ListConnectionsQuery = {}): Promise<ConnectionRecord[]> {
    return (await this.listPage(query)).data;
  }

  /** Like {@link list}, but returns be's full pagination envelope (SCAN2-011). */
  async listPage(
    query: ListConnectionsQuery = {},
  ): Promise<PaginatedEnvelope<ConnectionRecord>> {
    assertPagination(query);
    if (query.status !== undefined && !CONNECTION_STATUSES.includes(query.status)) {
      throw new PraesidiaConfigError(
        `status must be one of ${CONNECTION_STATUSES.join(', ')}`,
      );
    }
    const qs = buildQueryString(query);
    const result = await this.client.get<ConnectionRecord[] | Record<string, unknown>>(
      `${this.connectionsBase}${qs}`,
    );
    return normalizePagedEnvelope<ConnectionRecord>(result, 'connections');
  }

  /** Auto-paginate through every connection, across every page (SCAN2-011). */
  async *listAll(
    query: Omit<ListConnectionsQuery, 'page'> = {},
  ): AsyncGenerator<ConnectionRecord, void, undefined> {
    yield* paginateAll((page) => this.listPage({ ...query, page }));
  }

  /** Fetch a single connection by id. GET .../connections/:id. */
  async get(connectionId: string): Promise<ConnectionRecord> {
    return this.client.get<ConnectionRecord>(
      `${this.connectionsBase}/${encodePathSegment(connectionId, 'connectionId')}`,
    );
  }

  /** Create a direct agent-to-agent connection. POST .../connections/agent. */
  async createAgent(data: Record<string, unknown>): Promise<ConnectionRecord> {
    return this.client.post<ConnectionRecord>(`${this.connectionsBase}/agent`, data);
  }

  /** Create an agent-to-MCP-server connection. POST .../connections/mcp. */
  async createMcp(data: Record<string, unknown>): Promise<ConnectionRecord> {
    return this.client.post<ConnectionRecord>(`${this.connectionsBase}/mcp`, data);
  }

  /** Convenience alias for {@link createAgent}. */
  async create(data: Record<string, unknown>): Promise<ConnectionRecord> {
    return this.createAgent(data);
  }

  /**
   * Update the active/inactive status of a connection.
   * PATCH .../connections/:id/status.
   *
   * @throws PraesidiaConfigError if `status` is not one of {@link CONNECTION_STATUSES}.
   */
  async updateStatus(
    connectionId: string,
    status: ConnectionStatus,
  ): Promise<ConnectionRecord> {
    if (!CONNECTION_STATUSES.includes(status)) {
      throw new PraesidiaConfigError(
        `status must be one of ${CONNECTION_STATUSES.join(', ')}; got ${String(status)}`,
      );
    }
    return this.client.patch<ConnectionRecord>(
      `${this.connectionsBase}/${encodePathSegment(connectionId, 'connectionId')}/status`,
      { status },
    );
  }

  /** Delete (disconnect) a connection. DELETE .../connections/:id. */
  async delete(connectionId: string): Promise<void> {
    return this.client.del(
      `${this.connectionsBase}/${encodePathSegment(connectionId, 'connectionId')}`,
    );
  }

  /** Trigger a connectivity test for a connection. POST .../connections/:id/test. */
  async test(connectionId: string): Promise<ConnectionRecord> {
    return this.client.post<ConnectionRecord>(
      `${this.connectionsBase}/${encodePathSegment(connectionId, 'connectionId')}/test`,
      {},
    );
  }

  /** Fetch the current health status of a connection. GET .../connections/:id/health. */
  async health(connectionId: string): Promise<ConnectionRecord> {
    return this.client.get<ConnectionRecord>(
      `${this.connectionsBase}/${encodePathSegment(connectionId, 'connectionId')}/health`,
    );
  }

  /** Adopt a rotated credential in-process (zero-downtime swap). */
  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}

/** Build a `?a=b&c=d` query string, omitting undefined/empty values. */
function buildQueryString(query: ListConnectionsQuery): string {
  const params: Array<[string, string]> = [];
  if (query.page !== undefined) params.push(['page', String(query.page)]);
  if (query.limit !== undefined) params.push(['limit', String(query.limit)]);
  if (query.clientAgentId) params.push(['clientAgentId', query.clientAgentId]);
  if (query.serverAgentId) params.push(['serverAgentId', query.serverAgentId]);
  if (query.mcpServerId) params.push(['mcpServerId', query.mcpServerId]);
  if (query.status) params.push(['status', query.status]);
  if (query.search) params.push(['search', query.search]);
  if (params.length === 0) return '';
  return (
    '?' +
    params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  );
}
