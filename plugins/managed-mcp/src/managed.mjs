import { join } from 'node:path';
import { FileRuntimeAttemptStore, PraesidiaProtectedHttp, PraesidiaClient, jcsCommitment,
  jcsCanonicalize, httpRequestCommitment, httpTargetKeyFingerprint, verifyProtectedHttpResult } from '@praesidia/sdk';
import { z } from 'zod';
import { State } from './state.mjs';
import { callRemote } from './client.mjs';

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TOOL_NAME = 'praesidia_managed_action';
export const argumentSchema = z.object({
  operation: z.enum(['connection', 'prepare', 'checkpoint', 'resume', 'list_actions']).default('connection'),
  operationKey: z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/).optional(),
  body: z.record(z.unknown()).optional(), approvalId: uuid.optional(),
  requestCommitment: hash.optional(), confirm: z.string().optional(),
}).strict();

/** One operator-owned installation and target. No model-selected identity or destination. */
export class ManagedActions {
  constructor(config) {
    this.config = config;
    this.state = new State(config.stateDirectory);
    this.attempts = new FileRuntimeAttemptStore(join(config.stateDirectory, 'attempts'));
    this.resource = new PraesidiaProtectedHttp({ baseUrl: config.apiUrl, apiKey: config.apiKey, orgId: config.organizationId,
      runtimeInstallationId: config.installationId, requestTimeoutMs: 30000 });
    this.client = new PraesidiaClient(config.apiUrl, config.apiKey, 30000, false);
  }
  binding() {
    const c = this.config;
    return { organizationId: c.organizationId, createdByUserId: c.createdByUserId, installationId: c.installationId,
      ecosystemId: c.ecosystemId, profileId: c.profileId, targetId: c.target?.targetId ?? null, threadId: c.threadId };
  }
  installationBinding() {
    const { threadId: _threadId, ...binding } = this.binding();
    return binding;
  }
  installationStateName() {
    return 'installation-' + this.config.installationId + '-' + jcsCommitment(this.installationBinding()).slice(0, 24);
  }
  async verifyInstallation() {
    const c = this.config;
    if (!/^[A-Za-z0-9_-]{43}$/.test(c.challenge ?? '')) throw new Error('One-use installation challenge required; generate it in Praesidia');
    const response = await this.client.post(`/organizations/${c.organizationId}/runtime-installations/${c.installationId}/verify`,
      { challenge: c.challenge, runtimeVersion: c.runtimeVersion });
    this.assertInstallation(response);
    // Stable identity only: repeated reads never misrepresent this as live authority.
    await this.state.writeOnce(this.installationStateName(), this.installationBinding());
    return { installationId: response.id, organizationId: response.organizationId, createdByUserId: response.createdByUserId,
      status: response.status, verifiedAt: response.verifiedAt, credentialConnectionVerified: true,
      hostAttestationPerformed: false, executionObserved: response.checks?.executionObserved === true };
  }
  assertInstallation(value) {
    const c = this.config;
    if (!value || value.id !== c.installationId || value.organizationId !== c.organizationId || value.createdByUserId !== c.createdByUserId ||
      value.ecosystemId !== c.ecosystemId || value.profileId !== c.profileId || (value.targetId ?? null) !== (c.target?.targetId ?? null) ||
      value.status !== 'CONNECTED' || !Number.isFinite(Date.parse(value.verifiedAt))) throw new Error('Installation verification binding failed');
  }
  async connected() {
    const stored = await this.state.read(this.installationStateName());
    if (!jcsCanonicalize(stored).equals(jcsCanonicalize(this.installationBinding()))) throw new Error('Installation state belongs to a different identity or target');
  }
  async execute(raw) {
    const args = argumentSchema.parse(raw);
    await this.connected();
    if (args.operation === 'connection') {
      const value = await this.client.get(`/organizations/${this.config.organizationId}/runtime-installations/${this.config.installationId}`);
      this.assertInstallation(value);
      return { ...this.binding(), status: value.status, verifiedAt: value.verifiedAt, runtimeVersion: value.runtimeVersion,
        credentialConnectionPreviouslyVerified: true, liveAuthorityChecked: true, hostAttestationPerformed: false,
        executionObserved: value.checks?.executionObserved === true, lastActionId: value.lastActionId ?? null,
        enabled: { prepare: this.config.enablePrepare, resume: this.config.enableResume } };
    }
    if (args.operation === 'list_actions') {
      if (!this.config.mcpUrl || !this.config.mcpToken) throw new Error('Separate MCP resource credential and endpoint required');
      return { ...await callRemote(this.config.mcpUrl, this.config.mcpToken, this.config.organizationId, 'list_protected_actions', { limit: 20 }), installationId: this.config.installationId };
    }
    if (args.operation === 'prepare') return this.prepare(args);
    const record = await this.record(uuid.parse(args.approvalId));
    const current = await this.resource.checkpoint(record.approvalId);
    this.assertCheckpoint(record, current);
    if (args.operation === 'checkpoint') return this.readback(record, current);
    if (!this.config.enableResume) throw new Error('Resume is disabled by the operator');
    if (this.requestCommitment(record.request) !== record.requestCommitment) throw new Error('Original request or independent target pin changed; execution blocked');
    if (args.requestCommitment !== record.requestCommitment || args.confirm !== `RESUME ${record.approvalId} ${record.requestCommitment}`) {
      throw new Error('Explicit confirmation must name this approval and exact request commitment');
    }
    if (current.consumedAt || current.closure) return this.readback(record, current);
    if (current.status !== 'APPROVED' || Date.parse(current.expiresAt) <= Date.now() ||
      !uuid.safeParse(current.approverId).success || current.approverId === this.config.createdByUserId) {
      throw new Error('Fresh, unexpired, distinct-human approval required; no dispatch occurred');
    }
    if (!await this.attempts.claim({ approvalId: record.approvalId, actionId: record.actionId, requestCommitment: record.requestCommitment })) {
      return { ...this.readback(record, current), dispatchAttemptPreviouslyClaimed: true, outcome: 'unknown', retryAllowed: false };
    }
    try {
      const result = await this.resource.resume({ ...record.request, approvalId: record.approvalId });
      this.assertCheckpoint(record, result, true);
      return this.readback(record, result);
    } catch {
      // Even failure before an observable receipt leaves the durable attempt consumed.
      // The only follow-up is an authoritative READ; no transparent resend.
      try {
        const observed = await this.resource.checkpoint(record.approvalId);
        this.assertCheckpoint(record, observed);
        const readback = this.readback(record, observed);
        return { ...readback, outcome: observed.closure ? readback.outcome : 'unknown', dispatchResponseUncertain: true, retryAllowed: false };
      } catch { return { organizationId: this.config.organizationId, installationId: this.config.installationId,
        approvalId: record.approvalId, actionId: record.actionId, outcome: 'unknown', retryAllowed: false, readbackUnavailable: true }; }
    }
  }
  async prepare(args) {
    if (!this.config.enablePrepare) throw new Error('Preparation is disabled by the operator');
    if (!args.operationKey || !args.body) throw new Error('operationKey and JSON object body required');
    const request = { targetId: this.config.target.targetId, body: JSON.parse(jcsCanonicalize(args.body).toString()),
      checkpoint: { runtime: this.config.checkpointRuntime, threadId: this.config.threadId, nodeId: 'managed:' + args.operationKey,
        installationId: this.config.installationId } };
    const expected = this.requestCommitment(request);
    const checkpoint = await this.resource.prepare({ ...request, description: `${this.config.ecosystemId}: separately reviewed managed action` });
    const record = { ...this.binding(), request, approvalId: checkpoint.approvalId, actionId: checkpoint.actionId, requestCommitment: expected };
    this.assertCheckpoint(record, checkpoint);
    await this.state.writeOnce('request-' + checkpoint.approvalId, record);
    return { ...this.readback(record, checkpoint), dispatchPerformed: false, nextStep: 'Separate human approval, then an explicit resume of this exact checkpoint' };
  }
  requestCommitment(request) {
    return httpRequestCommitment({ version: 'praesidia.http-request.v1', targetId: request.targetId,
      destination: new URL(this.config.target.destination).href, targetKeyFingerprint: httpTargetKeyFingerprint(this.config.target.publicKeyPem),
      method: 'POST', contentType: 'application/json', body: request.body });
  }
  async record(id) {
    const record = await this.state.read('request-' + id);
    for (const [key, value] of Object.entries(this.binding())) if (record[key] !== value) throw new Error('Stored action is outside this installation, creator or host run');
    if (record.approvalId !== id || record.request?.checkpoint?.installationId !== this.config.installationId ||
      record.request?.checkpoint?.threadId !== this.config.threadId || record.request?.targetId !== this.config.target.targetId) throw new Error('Stored request binding failed');
    return record;
  }
  assertCheckpoint(record, value, result = false) {
    if (!value || !uuid.safeParse(value.approvalId).success || !uuid.safeParse(value.actionId).success ||
      !hash.safeParse(value.requestCommitment).success || value.approvalId !== record.approvalId ||
      value.actionId !== record.actionId || value.requestCommitment !== record.requestCommitment ||
      (!result && (!['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(value.status) ||
        !Number.isFinite(Date.parse(value.expiresAt)) || (value.consumedAt !== null && !Number.isFinite(Date.parse(value.consumedAt)))))) {
      throw new Error('Checkpoint identity, commitment or state is invalid');
    }
    if (value.resultCommitment != null && jcsCommitment(value.result ?? null) !== value.resultCommitment) throw new Error('Result commitment is invalid');
  }
  readback(record, value) {
    const independentlyVerified = value.receipt ? verifyProtectedHttpResult(value, record.request, this.config.target, this.config.organizationId) : false;
    return { organizationId: this.config.organizationId, installationId: this.config.installationId, approvalId: record.approvalId,
      actionId: record.actionId, requestCommitment: record.requestCommitment, status: value.status ?? 'APPROVED',
      consumedAt: value.consumedAt ?? null, approverId: value.approverId ?? null, expiresAt: value.expiresAt ?? null,
      closure: value.closure ?? null, result: value.result ?? null, resultCommitment: value.resultCommitment ?? null,
      receipt: value.receipt ?? null, reportedEvidenceGrade: value.evidenceGrade ?? null,
      targetReceiptIndependentlyVerified: independentlyVerified, auditBundleIndependentlyVerified: false,
      outcome: ['OUTCOME_UNKNOWN', 'EVIDENCE_INCOMPLETE'].includes(value.closure) ? 'unknown'
        : value.closure ? (independentlyVerified ? value.closure : 'unverified') : 'pending', retryAllowed: false,
      untrustedResultContent: true };
  }
}
