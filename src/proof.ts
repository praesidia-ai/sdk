import { PraesidiaClient, assertPagination, encodePathSegment } from './client.js';
import { PraesidiaConfigError } from './errors.js';
import { assertEvidenceDateRange } from './evidence-query.js';
import { PROTECTED_ACTION_CLOSURES } from './proof-types.js';
import type { CaptureScopeEntry, ListProtectedActionsQuery, ProtectedActionCoverage, ProtectedActionDetail, ProtectedActionEvent, ProtectedActionList } from './proof-types.js';
import type { GuardConfig } from './types.js';

/**
 * Read protected-action evidence using a personal, user-backed management key.
 * Requires audit:read, the user's protected_actions.view permission, and the
 * proof.actions feature. A successful read is not cryptographic verification.
 */
export class PraesidiaProof {
  private readonly client: PraesidiaClient;
  private readonly proofBase: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    if (!apiKey || !orgId) throw new PraesidiaConfigError('PraesidiaProof requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID');
    this.client = new PraesidiaClient(config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? 'https://api.praesidia.ai', apiKey, config.requestTimeoutMs, config.retry);
    this.proofBase = `/organizations/${encodePathSegment(orgId, 'orgId')}/protected-actions`;
  }

  /** Preserve pagination metadata; closure and verification are distinct fields. */
  async list(query: ListProtectedActionsQuery = {}): Promise<ProtectedActionList> {
    assertPagination(query);
    assertEvidenceDateRange(query.from, query.to);
    if (query.closure !== undefined && !PROTECTED_ACTION_CLOSURES.includes(query.closure)) {
      throw new PraesidiaConfigError('closure must be a supported protected-action closure');
    }
    const params = new URLSearchParams();
    for (const key of ['agentId', 'taskId', 'chainId', 'state', 'closure', 'from', 'to', 'page', 'limit'] as const) {
      const value = query[key];
      if (value !== undefined) {
        if (typeof value === 'string') encodePathSegment(value, key);
        params.set(key, String(value));
      }
    }
    const queryString = params.toString();
    const qs = queryString ? `?${queryString}` : '';
    return this.client.get<ProtectedActionList>(`${this.proofBase}${qs}`);
  }

  get(actionId: string): Promise<ProtectedActionDetail> {
    return this.client.get<ProtectedActionDetail>(`${this.proofBase}/${encodePathSegment(actionId, 'actionId')}`);
  }

  /** Return ordered signed events unchanged, including redacted null payloads. */
  events(actionId: string): Promise<ProtectedActionEvent[]> {
    return this.client.get<ProtectedActionEvent[]>(`${this.proofBase}/${encodePathSegment(actionId, 'actionId')}/events`);
  }

  /** Declared coverage denominator, including partial and unsupported edges. */
  captureScope(): Promise<CaptureScopeEntry[]> {
    return this.client.get<CaptureScopeEntry[]>(`${this.proofBase}/capture-scope`);
  }

  /** Exact server totals, never a percentage extrapolated from a sampled page. */
  coverageSummary(): Promise<ProtectedActionCoverage> {
    return this.client.get<ProtectedActionCoverage>(`${this.proofBase}/coverage-summary`);
  }

  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}
