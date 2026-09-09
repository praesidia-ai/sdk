import { jcsCanonicalize, jcsCommitment, type JsonValue } from './jcs-canonical.js';
import { PraesidiaConfigError } from './errors.js';
import type { SignedHttpReceipt } from './http-receipt.js';
import type { RuntimeAttemptStore } from './runtime-attempt-store.js';
import {
  PROTECTED_HTTP_RUNTIMES,
  type PraesidiaProtectedHttp,
  type ProtectedHttpCheckpoint,
  type ProtectedHttpRequest,
  type ProtectedHttpResult,
  type ProtectedHttpRuntime,
} from './protected-http.js';

/** Values supplied by the host runtime, never by the model's tool arguments. */
export interface RuntimeCall {
  threadId: string;
  callId: string;
  taskId?: string;
}
export interface RuntimeToolConfig {
  runtime: ProtectedHttpRuntime;
  name: string;
  targetId: string;
  description: string;
}
export type RuntimeToolResource = Pick<PraesidiaProtectedHttp, 'prepare' | 'checkpoint' | 'resume' | 'revoke'> & { readonly runtimeInstallationId?: string };
export interface RuntimeToolOutcome {
  kind: 'approval_required' | 'ready' | 'denied' | 'completed' | 'failed_no_effect' | 'partial' | 'outcome_unknown';
  approvalId: string;
  actionId: string;
  requestCommitment: string;
  checkpoint: ProtectedHttpRequest['checkpoint'];
  closure: string | null;
  result: JsonValue;
  evidenceGrade: 'A' | 'B' | 'C' | 'D' | null;
  resultCommitment: string | null;
  receipt: SignedHttpReceipt | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED']);
const GRADES = new Set(['A', 'B', 'C', 'D']);
function outcomeKind(closure?: string | null): RuntimeToolOutcome['kind'] {
  return closure === 'SUCCEEDED' ? 'completed' : closure === 'FAILED_NO_EFFECT' ? 'failed_no_effect' :
    closure === 'PARTIAL' ? 'partial' : 'outcome_unknown';
}
function text(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PraesidiaConfigError(`${label} must be a non-empty string of at most ${max} characters`);
  }
}
function assertCheckpoint(value: ProtectedHttpCheckpoint): void {
  if (!value || !UUID.test(value.approvalId) || !UUID.test(value.actionId) ||
    !HASH.test(value.requestCommitment) || !STATUSES.has(value.status) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    (value.consumedAt !== null && !Number.isFinite(Date.parse(value.consumedAt))) ||
    (value.approverId !== null && !UUID.test(value.approverId)) ||
    (value.evidenceGrade !== undefined && !GRADES.has(value.evidenceGrade))) {
    throw new PraesidiaConfigError('Invalid protected checkpoint response; execution remains blocked');
  }
  if (value.resultCommitment !== undefined && value.resultCommitment !== null &&
    (!HASH.test(value.resultCommitment) || jcsCommitment(value.result ?? null) !== value.resultCommitment)) {
    throw new PraesidiaConfigError('Checkpoint result does not match its commitment');
  }
}

/**
 * A framework-neutral tool whose only effect is an approved, registered HTTP dispatch.
 * No native callable or model-selected destination is accepted. Backend checkpoints are
 * the durable store: replay with the same host call ID recovers the same action, including
 * after a process restart. prepare revalidates the exact arguments and current authority.
 */
export class PraesidiaRuntimeTool {
  readonly config: Readonly<RuntimeToolConfig>;
  private readonly inFlight = new Map<string, { requestHash: string; result: Promise<RuntimeToolOutcome> }>();
  constructor(private readonly resource: RuntimeToolResource, config: RuntimeToolConfig,
    private readonly attempts: RuntimeAttemptStore) {
    if (!attempts || typeof attempts.claim !== 'function') throw new PraesidiaConfigError('A durable host-owned RuntimeAttemptStore is required');
    if (!PROTECTED_HTTP_RUNTIMES.includes(config.runtime)) throw new PraesidiaConfigError('Unsupported protected runtime');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(config.name)) throw new PraesidiaConfigError('Tool name must be a lowercase identifier of at most 64 characters');
    text(config.targetId, 'targetId', 128);
    text(config.description, 'description', 1000);
    this.config = Object.freeze({ ...config });
  }

  private request(args: Record<string, JsonValue>, call: RuntimeCall): ProtectedHttpRequest {
    text(call.threadId, 'Host threadId', 256);
    text(call.callId, 'Host callId', 190);
    if (call.taskId !== undefined && !UUID.test(call.taskId)) throw new PraesidiaConfigError('Host taskId must be a UUID');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new PraesidiaConfigError('Tool arguments must be a JSON object');
    // Canonicalization rejects coercions; parse creates an owned snapshot before any await.
    const body = JSON.parse(jcsCanonicalize(args).toString('utf8')) as Record<string, JsonValue>;
    return {
      targetId: this.config.targetId, body,
      checkpoint: {
        runtime: this.config.runtime, threadId: call.threadId,
        nodeId: `${this.config.name}:${call.callId}`,
        ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
        ...(this.resource.runtimeInstallationId === undefined ? {} : { installationId: this.resource.runtimeInstallationId }),
      },
    };
  }

  invoke(args: Record<string, JsonValue>, call: RuntimeCall): Promise<RuntimeToolOutcome> {
    const request = this.request(args, call);
    const key = jcsCommitment(request.checkpoint as unknown as JsonValue);
    const requestHash = jcsCommitment(request as unknown as JsonValue);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new PraesidiaConfigError('Concurrent call ID already binds different tool arguments');
      return existing.result;
    }
    const result = this.execute(request).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, { requestHash, result });
    return result;
  }

  /** Prepare/inspect without dispatch; suitable for a framework's approval callback. */
  prepare(args: Record<string, JsonValue>, call: RuntimeCall): Promise<RuntimeToolOutcome> {
    return this.execute(this.request(args, call), false);
  }

  private outcome(request: ProtectedHttpRequest, checkpoint: ProtectedHttpCheckpoint,
    kind: RuntimeToolOutcome['kind']): RuntimeToolOutcome {
    return {
      kind, approvalId: checkpoint.approvalId, actionId: checkpoint.actionId,
      requestCommitment: checkpoint.requestCommitment, checkpoint: request.checkpoint,
      closure: checkpoint.closure ?? null, result: checkpoint.result ?? null,
      evidenceGrade: checkpoint.consumedAt || checkpoint.closure ? checkpoint.evidenceGrade ?? 'C' : null,
      resultCommitment: checkpoint.resultCommitment ?? null, receipt: checkpoint.receipt ?? null,
    };
  }

  private assertSame(prepared: ProtectedHttpCheckpoint, current: ProtectedHttpCheckpoint): void {
    assertCheckpoint(current);
    if (current.approvalId !== prepared.approvalId || current.actionId !== prepared.actionId ||
      current.requestCommitment !== prepared.requestCommitment) {
      throw new PraesidiaConfigError('Checkpoint identity or request commitment changed');
    }
  }

  private async execute(request: ProtectedHttpRequest, dispatch = true): Promise<RuntimeToolOutcome> {
    const prepared = await this.resource.prepare({ ...request, description: this.config.description });
    assertCheckpoint(prepared);
    const current = await this.resource.checkpoint(prepared.approvalId);
    this.assertSame(prepared, current);
    if (current.consumedAt) {
      return this.outcome(request, current, outcomeKind(current.closure));
    }
    if (Date.parse(current.expiresAt) <= Date.now() || ['REJECTED', 'EXPIRED', 'CANCELLED'].includes(current.status)) {
      return this.outcome(request, current, 'denied');
    }
    if (current.status !== 'APPROVED') return this.outcome(request, current, 'approval_required');
    if (!current.approverId) throw new PraesidiaConfigError('Approved checkpoint has no reviewer identity');
    if (!dispatch) return this.outcome(request, current, 'ready');
    if (!await this.attempts.claim({ approvalId: prepared.approvalId, actionId: prepared.actionId,
      requestCommitment: prepared.requestCommitment })) {
      return this.outcome(request, current, 'outcome_unknown');
    }

    let result: ProtectedHttpResult;
    try {
      // Backend revalidates authority and atomically consumes approval before dispatch.
      result = await this.resource.resume({ ...request, approvalId: prepared.approvalId });
    } catch {
      // A network error cannot establish whether the target changed. Read only; never
      // automatically repeat resume, even when the readback has no consumption yet.
      const observed = await this.resource.checkpoint(prepared.approvalId);
      this.assertSame(prepared, observed);
      return this.outcome(request, observed, observed.consumedAt ? outcomeKind(observed.closure) : 'outcome_unknown');
    }
    if (result.approvalId !== prepared.approvalId || result.actionId !== prepared.actionId ||
      result.requestCommitment !== prepared.requestCommitment || !GRADES.has(result.evidenceGrade) ||
      (result.resultCommitment === null ? result.result !== null : jcsCommitment(result.result) !== result.resultCommitment)) {
      throw new PraesidiaConfigError('Execution response is inconsistent; read the checkpoint before taking further action');
    }
    return {
      kind: outcomeKind(result.closure),
      approvalId: result.approvalId, actionId: result.actionId,
      requestCommitment: result.requestCommitment, checkpoint: request.checkpoint,
      closure: result.closure, result: result.result, evidenceGrade: result.evidenceGrade,
      resultCommitment: result.resultCommitment, receipt: result.receipt,
    };
  }
}
