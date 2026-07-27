import { PraesidiaClient } from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type { GuardConfig } from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/**
 * PraesidiaAgents — agent credential management (Q4-01).
 *
 * Exposes a runtime credential-refresh affordance so a long-lived client can
 * adopt a newly provisioned agent client secret without a restart.
 *
 * Usage (zero config — reads from env vars):
 *   const agents = new PraesidiaAgents();
 *   agents.refreshCredential(newClientSecret); // adopt in-process
 *
 * Config resolution order: constructor arg → environment variable → default.
 * Like PraesidiaCompliance there is no local/offline mode — every operation is
 * a connected, authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint base: /organizations/:orgId/agents
 * Auth: Authorization: Bearer <apiKey>.
 */
export class PraesidiaAgents {
  private readonly client: PraesidiaClient;

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

    this.client = new PraesidiaClient(baseUrl, apiKey, config.requestTimeoutMs);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

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
