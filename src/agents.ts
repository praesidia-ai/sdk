import { PraesidiaClient } from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type {
  GuardConfig,
  RotateClientSecretOptions,
  RotateClientSecretResult,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/**
 * PraesidiaAgents — agent credential management (Q4-01).
 *
 * Currently exposes A2A client-secret rotation with an optional grace/overlap
 * window, plus a runtime credential-refresh affordance so a long-lived client
 * can adopt a rotated secret without a restart.
 *
 * Usage (zero config — reads from env vars):
 *   const agents = new PraesidiaAgents();
 *   const rotated = await agents.rotateClientSecret(agentId, {
 *     gracePeriodSeconds: 3600, // old secret stays valid for 1h overlap
 *   });
 *   // rotated.clientSecret is shown ONCE — store it now, never log it.
 *   agents.refreshCredential(rotated.clientSecret); // adopt in-process
 *
 * Config resolution order: constructor arg → environment variable → default.
 * Like PraesidiaCompliance there is no local/offline mode — every operation is
 * a connected, authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint base: /organizations/:orgId/agents
 * Auth: Authorization: Bearer <apiKey>. Rotation requires the
 * AGENTS_CONFIGURE permission.
 */
export class PraesidiaAgents {
  private readonly orgId: string;
  private readonly baseUrl: string;
  private readonly client: PraesidiaClient;
  private readonly agentsBase: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    this.baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey || !orgId) {
      throw new PraesidiaConfigError(
        'PraesidiaAgents requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
      );
    }

    this.orgId = orgId;
    this.client = new PraesidiaClient(this.baseUrl, apiKey);
    this.agentsBase = `/organizations/${this.orgId}/agents`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Rotate an agent's A2A client secret, minting a fresh plaintext secret.
   *
   * POST .../agents/:agentId/client-secret/rotate (requires AGENTS_CONFIGURE).
   *
   * Pass `gracePeriodSeconds` (0..604800) to keep the OUTGOING secret valid for
   * a bounded overlap so live consumers can swap over with zero downtime; omit
   * it (or pass 0) for an instant, fail-closed rotation that revokes the old
   * secret immediately (the emergency/panic path).
   *
   * SECURITY: the returned `clientSecret` is the NEW plaintext and is shown
   * EXACTLY ONCE — store it now (it is never recoverable) and never log it.
   * Distinct from the instant `regenerate-secret` endpoint, which has no grace
   * window.
   */
  async rotateClientSecret(
    agentId: string,
    opts: RotateClientSecretOptions = {},
  ): Promise<RotateClientSecretResult> {
    const body: RotateClientSecretOptions = {};
    if (opts.gracePeriodSeconds !== undefined) {
      body.gracePeriodSeconds = opts.gracePeriodSeconds;
    }
    return this.client.post<RotateClientSecretResult>(
      `${this.agentsBase}/${encodeURIComponent(agentId)}/client-secret/rotate`,
      body,
    );
  }

  /**
   * Adopt a rotated client secret in-process, at runtime (zero-downtime swap).
   *
   * Call this after `rotateClientSecret` with the returned `clientSecret` (or
   * any newly provisioned credential): subsequent requests from this instance
   * authenticate with the new secret. Combined with the grace window returned
   * by `rotateClientSecret`, the previous secret keeps working until
   * `graceEndsAt`, so no in-flight caller is rejected during the swap.
   *
   * SECURITY: the credential is held only in memory and is never logged.
   */
  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}
