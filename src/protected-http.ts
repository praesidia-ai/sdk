import { PraesidiaClient, encodePathSegment } from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type { GuardConfig } from './types.js';
import { jcsCommitment, type JsonValue } from './jcs-canonical.js';
import { httpRequestCommitment, httpTargetKeyFingerprint, verifyHttpReceipt, type HttpRequestEnvelope, type SignedHttpReceipt } from './http-receipt.js';
export const PROTECTED_HTTP_RUNTIMES = ['openclaw', 'hermes', 'zeroclaw', 'langgraph', 'crewai', 'openai-agents', 'google-adk', 'microsoft-agent-framework', 'agno', 'custom'] as const;
export type ProtectedHttpRuntime = typeof PROTECTED_HTTP_RUNTIMES[number];
export interface RuntimeCheckpoint { runtime: ProtectedHttpRuntime; threadId: string; nodeId: string; taskId?: string; installationId?: string }
export interface ProtectedHttpRequest { targetId: string; body: Record<string, JsonValue>; checkpoint: RuntimeCheckpoint }
export interface ProtectedHttpCheckpoint { approvalId: string; actionId: string; requestCommitment: string; status: string; expiresAt: string; consumedAt: string | null; approverId: string | null; closure?: string | null; result?: JsonValue; resultCommitment?: string | null; receipt?: SignedHttpReceipt | null; evidenceGrade?: 'A' | 'B' | 'C' | 'D' }
export interface ProtectedHttpResult { approvalId: string; actionId: string; closure: string; evidenceGrade: 'A' | 'B' | 'C' | 'D'; result: JsonValue; resultCommitment: string | null; requestCommitment: string; receipt: SignedHttpReceipt | null }
export interface TrustedHttpTarget { targetId: string; destination: string; keyId: string; publicKeyPem: string }

/** Durable approvals and exact-request HTTP dispatch. Personal/delegated user credentials only. */
export class PraesidiaProtectedHttp {
  private readonly client: PraesidiaClient;
  private readonly base: string;
  readonly organizationId: string;
  readonly runtimeInstallationId?: string;
  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    if (!apiKey || !orgId) throw new PraesidiaConfigError('Protected HTTP requires apiKey and orgId');
    this.organizationId = orgId;
    const installationId = config.runtimeInstallationId ?? process.env['PRAESIDIA_RUNTIME_INSTALLATION_ID'];
    if (installationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(installationId)) throw new PraesidiaConfigError('runtimeInstallationId must be a UUID');
    this.runtimeInstallationId = installationId?.toLowerCase();
    // Never transparently repeat dispatch after an ambiguous transport outcome.
    this.client = new PraesidiaClient(config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? 'https://api.praesidia.ai', apiKey, config.requestTimeoutMs, false);
    this.base = `/organizations/${encodePathSegment(orgId, 'orgId')}/protected-actions/http`;
  }
  prepare(request: ProtectedHttpRequest & { description: string; expiresInHours?: number }): Promise<ProtectedHttpCheckpoint> {
    return this.client.post(`${this.base}/prepare`, this.bindInstallation(request));
  }
  checkpoint(approvalId: string): Promise<ProtectedHttpCheckpoint> {
    return this.client.get(`${this.base}/checkpoints/${encodePathSegment(approvalId, 'approvalId')}`);
  }
  revoke(approvalId: string): Promise<{ approvalId: string; status: 'CANCELLED' }> {
    return this.client.post(`${this.base}/checkpoints/${encodePathSegment(approvalId, 'approvalId')}/revoke`, {});
  }
  resume(request: ProtectedHttpRequest & { approvalId: string }): Promise<ProtectedHttpResult> {
    return this.client.post(`${this.base}/resume`, this.bindInstallation(request));
  }
  /** Caller acknowledges its observed result; this does not upgrade the target's evidence grade. */
  acknowledge(result: ProtectedHttpResult): Promise<{ acknowledged: boolean; actionId: string; resultCommitment: string }> {
    const commitment = jcsCommitment(result.result);
    if (commitment !== result.resultCommitment) throw new PraesidiaConfigError('Observed result does not match the returned commitment');
    return this.client.post(`${this.base}/acknowledge`, { approvalId: result.approvalId, resultCommitment: commitment });
  }
  refreshCredential(apiKey: string): void { this.client.setApiKey(apiKey); }
  private bindInstallation<T extends ProtectedHttpRequest>(request: T): T {
    if (!this.runtimeInstallationId) return request;
    if (request.checkpoint.installationId !== undefined && request.checkpoint.installationId.toLowerCase() !== this.runtimeInstallationId) throw new PraesidiaConfigError('Checkpoint installation conflicts with the configured runtime installation');
    return { ...request, checkpoint: { ...request.checkpoint, installationId: this.runtimeInstallationId } };
  }
}
/** Independent of API grade labels. Pin is out-of-band and request is the caller's original request. */
export function verifyProtectedHttpResult(result: ProtectedHttpResult, original: ProtectedHttpRequest,
  target: TrustedHttpTarget, organizationId: string): boolean {
  try {
  if (original.targetId !== target.targetId) return false;
  const request: HttpRequestEnvelope = { version: 'praesidia.http-request.v1', targetId: target.targetId,
    destination: new URL(target.destination).href, targetKeyFingerprint: httpTargetKeyFingerprint(target.publicKeyPem),
    method: 'POST', contentType: 'application/json', body: original.body };
  const expectedClosure = result.receipt && ({ succeeded: 'SUCCEEDED', failed_no_effect: 'FAILED_NO_EFFECT', partial: 'PARTIAL', unknown: 'OUTCOME_UNKNOWN' } as const)[result.receipt.statement.effect];
  if (!expectedClosure || result.closure !== expectedClosure) return false;
  const commitment = httpRequestCommitment(request);
  const resultCommitment = jcsCommitment(result.result);
  return result.requestCommitment === commitment && result.resultCommitment === resultCommitment &&
    verifyHttpReceipt(result.receipt, target.publicKeyPem, { actionId: result.actionId, organizationId,
      targetId: target.targetId, keyId: target.keyId, requestCommitment: commitment, resultCommitment });
  } catch { return false; }
}
