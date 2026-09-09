import { normalizeBaseUrl, readBoundedJsonResponse, resolveRequestTimeoutMs } from './client.js';
import { PraesidiaApiError, PraesidiaConfigError } from './errors.js';

const JWT = 'urn:ietf:params:oauth:token-type:jwt' as const;
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token' as const;
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange' as const;

export interface FederatedCredential {
  access_token: string;
  issued_token_type: typeof ACCESS_TOKEN;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export interface FederatedAuthority {
  grantId: string; organizationId: string; agentId: string; userId?: string;
  resource: string; audience: string; scopes: string[]; expiresAt: string;
  subject: { issuer: string; subject: string; userId?: string };
  actor?: { issuer: string; subject: string; agentId: string };
  consentId?: string;
}

export interface ExternalAssertionExchange {
  organizationId: string;
  subjectBindingId: string;
  /** Fresh issuer-signed assertion. Reusing it is rejected by the replay ledger. */
  subjectToken: string;
  resource: string;
  scopes: string[];
  delegation?: { actorBindingId: string; actorToken: string; consentId: string };
}

/** RFC 8693 credential acquisition. No management key or client secret is sent. */
export class PraesidiaIdentity {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: { baseUrl?: string; requestTimeoutMs?: number } = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? 'https://api.praesidia.ai');
    const url = new URL(this.baseUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new PraesidiaConfigError('Identity assertions require HTTPS outside loopback development');
    this.timeoutMs = resolveRequestTimeoutMs(config.requestTimeoutMs);
  }

  exchange(input: ExternalAssertionExchange): Promise<FederatedCredential> {
    this.assertScopes(input.scopes);
    return this.requestCredential({ grant_type: EXCHANGE, subject_token_type: JWT, subject_token: input.subjectToken, organization_id: input.organizationId, subject_binding_id: input.subjectBindingId, resource: input.resource, scope: input.scopes.join(' '), ...(input.delegation ? { actor_token_type: JWT, actor_token: input.delegation.actorToken, actor_binding_id: input.delegation.actorBindingId, consent_id: input.delegation.consentId } : {}) });
  }

  /** Keeps subject/actor/expiry; omitted scopes preserve the parent's exact scope set. */
  downExchange(token: string, input: { subjectResource: string; resource: string; scopes?: string[] }): Promise<FederatedCredential> {
    this.assertToken(token);
    if (input.scopes !== undefined) this.assertScopes(input.scopes);
    return this.requestCredential({ grant_type: EXCHANGE, subject_token_type: ACCESS_TOKEN, subject_token: token, subject_resource: input.subjectResource, resource: input.resource, ...(input.scopes ? { scope: input.scopes.join(' ') } : {}) });
  }

  /** Live API-audience validation. Other resource tokens must first be down-exchanged. */
  async introspect(token: string): Promise<FederatedAuthority> {
    this.assertToken(token);
    return this.post<FederatedAuthority>('/identity/introspect', {}, token);
  }

  /** Call immediately before an SDK operation, then pass to refreshCredential(). */
  credentialProvider(freshAssertion: () => Promise<ExternalAssertionExchange>): () => Promise<string> {
    return async () => (await this.exchange(await freshAssertion())).access_token;
  }

  private assertScopes(scopes: string[]): void {
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > 64 || scopes.some((s) => typeof s !== 'string' || s === '*' || !/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(s))) throw new PraesidiaConfigError('Explicit non-empty OAuth scopes are required');
  }
  private assertToken(token: string): void {
    if (!/^pfa_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) throw new PraesidiaConfigError('Expected a federated access token');
  }
  private async requestCredential(body: Record<string, unknown>): Promise<FederatedCredential> {
    const credential = await this.post<FederatedCredential>('/oauth/token-exchange', body);
    this.assertToken(credential.access_token);
    if (credential.token_type !== 'Bearer' || credential.issued_token_type !== ACCESS_TOKEN || !Number.isInteger(credential.expires_in) || credential.expires_in < 1 || credential.expires_in > 300 || typeof credential.scope !== 'string') throw new PraesidiaApiError(502, '/oauth/token-exchange', 'Invalid credential response');
    return credential;
  }
  private async post<T>(path: string, body: Record<string, unknown>, token?: string): Promise<T> {
    // Exchange assertions are one-use. Network failures are never automatically replayed.
    const response = await fetch(`${this.baseUrl}${path}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw new PraesidiaApiError(response.status, path, 'Identity request rejected'); }
    return readBoundedJsonResponse<T>(response, path);
  }
}
