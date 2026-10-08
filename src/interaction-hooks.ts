import { randomUUID } from 'node:crypto';
import { PraesidiaClient, encodePathSegment } from './client.js';
import {
  InteractionDecisionUnavailableError,
  InteractionDeniedError,
  InteractionTaskNotLiveError,
  isOutage,
  markOutage,
  PraesidiaApiError,
  PraesidiaConfigError,
} from './errors.js';
import { jcsCommitment, type JsonValue } from './jcs-canonical.js';
import { sleep } from './retry.js';
import type { GuardConfig } from './types.js';

/**
 * SDK-0300 — interaction hooks: an ADVISORY IN-RUNTIME GUARD.
 *
 * Before your agent runs a shell command, touches a file, drives a browser or
 * calls a tool, a hook asks Praesidia (`POST /organizations/:orgId/
 * interaction-decisions`, be BE-1486) and honours the verdict in your process.
 * Praesidia does not run or intercept that runtime: an agent that does not load
 * the SDK, or skips a hook, is not governed by it.
 */

/** be `InteractionType` (`be/src/protected-actions/interaction-type.ts`), same order. */
export const INTERACTION_TYPES = [
  'prompt_to_model',
  'model_to_tool',
  'agent_to_mcp',
  'agent_to_api',
  'agent_to_agent',
  'agent_to_db',
  'agent_to_saas',
  'agent_to_browser',
  'agent_to_code_execution',
  'agent_to_shell',
  'agent_to_filesystem',
  'agent_to_email',
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

/** be `InteractionVerdict` (`interaction-decision.dto.ts`). */
export const INTERACTION_VERDICTS = ['allow', 'deny', 'require_approval'] as const;
export type InteractionVerdict = (typeof INTERACTION_VERDICTS)[number];

/** be `InteractionActionDto`. `name` is matched as `<interactionType>.<name>` against tool-policy globs. */
export interface InteractionAction {
  name: string;
  arguments?: Record<string, JsonValue>;
}

/** be `InteractionDecisionResponseDto`. */
export interface InteractionDecision {
  verdict: InteractionVerdict;
  reasonCode: string;
  approvalId: string | null;
  policyFingerprint: string;
  ttlSeconds: number;
  enforcementMode: 'off' | 'observe' | 'enforce';
  decisionId: string;
  /** BE-1609 — the layer that denied or required approval; null/absent = nothing constrained it. */
  constrainedBy?: 'org_policy' | 'delegation' | 'assurance' | null;
}

/**
 * SDK-2800 — delegation keys be BE-2836 adds to the `details` of an `interaction.decision`
 * Decision Record (an `audit.list()` row). Absent from older servers and from decisions they
 * do not apply to; every other `details` key stays untyped here.
 */
export interface InteractionDecisionRecordDetails {
  /** The caller sent no capability token and was held to the live delegated tasks it executes. */
  delegationReason?: 'delegation_implicit_live_task';
  /** With `delegationReason`: the live task whose envelope decided; null = none narrowed the verdict. */
  constrainingTaskId?: string | null;
  /** An owner-level human decided without a token, so no task envelope applied. */
  delegationBypass?: 'owner';
  [key: string]: unknown;
}

export type FailMode = 'open' | 'closed';
/** The fail-mode classes the four hooks map onto. */
export type InteractionHookClass = 'toolCall' | 'exec' | 'fsRead' | 'fsWrite' | 'browser';
/** Require an authorization decision for every hook; fail-open is an explicit opt-in. */
export const DEFAULT_FAIL_MODES: Readonly<Record<InteractionHookClass, FailMode>> = Object.freeze({
  toolCall: 'closed',
  exec: 'closed',
  fsRead: 'closed',
  fsWrite: 'closed',
  browser: 'closed',
});

export interface ToolCallRequest { toolName: string; arguments?: Record<string, JsonValue> }
/** `runtime: 'code'` asks as `agent_to_code_execution`; the default is `agent_to_shell`. */
export interface ExecRequest { command: string; args?: string[]; cwd?: string; runtime?: 'shell' | 'code' }
/** `read` / `list` are read-only (fail class `fsRead`); any other mode is a write (`fsWrite`). */
export type FsAccessMode = 'read' | 'list' | 'write' | 'delete';
export interface FsAccessRequest { path: string; mode: FsAccessMode }
export interface BrowserActionRequest { action: string; url?: string; arguments?: Record<string, JsonValue> }

/**
 * What an allowing hook resolves to. `decision` is `null` only when the
 * decision API was unavailable and the hook failed open; `failOpenError` is
 * then the reason.
 */
export interface InteractionHookResult {
  decision: InteractionDecision | null;
  failOpenError?: unknown;
}

/** be `InteractionOutcomeStatus` (BE-1582). */
export const INTERACTION_OUTCOME_STATUSES = ['succeeded', 'failed_no_effect', 'partial', 'unknown'] as const;
export type InteractionOutcomeStatus = (typeof INTERACTION_OUTCOME_STATUSES)[number];

interface InteractionOutcomeFields {
  status: InteractionOutcomeStatus;
  result?: JsonValue;
  targetSystem?: string;
  targetTransactionId?: string;
  /** SDK-2503 — `Idempotency-Key` for this report (1-255 chars); default a fresh UUID v4. */
  idempotencyKey?: string;
}

/** Outcome of an `allow` with reasonCode `approval_consumed`, keyed by `decision.approvalId`. */
export interface InteractionApprovalOutcomeReport extends InteractionOutcomeFields {
  approvalId: string;
  decisionId?: never;
}

/** Outcome of a plain `allow` (`approvalId: null`), keyed by `decision.decisionId` (BE-1808). */
export interface InteractionDecisionOutcomeReport extends InteractionOutcomeFields {
  decisionId: string;
  approvalId?: never;
}

/**
 * What the agent saw after running an allowed interaction: exactly one of
 * `approvalId` | `decisionId`. `result` is committed locally (sha256 of its
 * JCS form) and never sent.
 */
export type InteractionOutcomeReport = InteractionApprovalOutcomeReport | InteractionDecisionOutcomeReport;

/** be `InteractionOutcomeResponseDto`. */
export interface InteractionOutcomeReceipt {
  /** Echo of the reported approvalId; null on the decisionId path. */
  approvalId: string | null;
  /** Echo of the reported decisionId; null on the approvalId path (BE-1808). */
  reportedDecisionId: string | null;
  /** Decision Record id of the outcome — the receipt key for `audit/decisions/:decisionId/receipt`. */
  decisionId: string;
}

export interface InteractionHooksConfig
  extends Pick<GuardConfig, 'apiKey' | 'orgId' | 'agentId' | 'baseUrl' | 'requestTimeoutMs' | 'allowInsecureHttp' | 'retry'> {
  /** Per-class override of {@link DEFAULT_FAIL_MODES}. */
  failMode?: Partial<Record<InteractionHookClass, FailMode>>;
  /** Re-ask interval while a verdict is `require_approval` (default 2000 ms). */
  approvalPollIntervalMs?: number;
  /** Give up waiting for an approval after this long and deny (default 600000 ms). */
  approvalTimeoutMs?: number;
  /** Called once when a hook starts waiting, e.g. to tell a human which approval to act on. */
  onApprovalRequired?: (decision: InteractionDecision) => void;
  /**
   * BE-1609 — the agent task (UUID) these interactions run under, e.g.
   * `toolCallContextFromTask(task).taskId`; its delegation envelope narrows
   * every verdict. Use one hooks instance per task.
   */
  taskId?: string;
}

const ACTION_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const FS_READ_MODES: ReadonlySet<string> = new Set(['read', 'list']);
const MAX_CACHE_ENTRIES = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PraesidiaInteractionHooks {
  readonly organizationId: string;
  readonly agentId: string;
  readonly taskId?: string;
  private readonly client: PraesidiaClient;
  private readonly path: string;
  private readonly failModes: Record<InteractionHookClass, FailMode>;
  private readonly pollMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly onApprovalRequired?: (decision: InteractionDecision) => void;
  /** Keyed by sha256(JCS({interactionType, action})); valid only under `fingerprint`. */
  private readonly cache = new Map<string, { decision: InteractionDecision; expiresAt: number }>();
  private fingerprint: string | undefined;

  constructor(config: InteractionHooksConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    const agentId = config.agentId ?? process.env['PRAESIDIA_AGENT_ID'];
    if (!apiKey || !orgId || !agentId) {
      throw new PraesidiaConfigError('Interaction hooks require apiKey, orgId and agentId');
    }
    this.failModes = { ...DEFAULT_FAIL_MODES };
    for (const [cls, mode] of Object.entries(config.failMode ?? {})) {
      if (!(cls in DEFAULT_FAIL_MODES) || (mode !== 'open' && mode !== 'closed')) {
        throw new PraesidiaConfigError(`failMode.${cls} must be 'open' or 'closed' for a known hook class`);
      }
      this.failModes[cls as InteractionHookClass] = mode;
    }
    this.pollMs = positiveInt(config.approvalPollIntervalMs ?? 2000, 'approvalPollIntervalMs');
    this.approvalTimeoutMs = positiveInt(config.approvalTimeoutMs ?? 600_000, 'approvalTimeoutMs');
    this.onApprovalRequired = config.onApprovalRequired;
    if (config.taskId !== undefined && !UUID.test(config.taskId)) throw new PraesidiaConfigError('taskId must be a UUID');
    this.taskId = config.taskId;
    this.organizationId = orgId;
    this.agentId = agentId;
    // SDK-2503 — retried (429/5xx/network) only because every POST carries an
    // Idempotency-Key (BE-1759): a retry replays the stored response, no new rows.
    this.client = new PraesidiaClient(
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? 'https://api.praesidia.ai',
      apiKey,
      config.requestTimeoutMs,
      config.retry,
      config.allowInsecureHttp,
    );
    this.path = `/organizations/${encodePathSegment(orgId, 'orgId')}/interaction-decisions`;
  }

  /** Tool call chosen by the model: `model_to_tool.<toolName>`. Default fail-closed. */
  beforeToolCall(req: ToolCallRequest): Promise<InteractionHookResult> {
    return this.guard('model_to_tool', action(req.toolName, req.arguments), this.failModes.toolCall);
  }

  /** Shell command or code run: `agent_to_shell.exec` / `agent_to_code_execution.exec`. Default fail-closed. */
  beforeExec(req: ExecRequest): Promise<InteractionHookResult> {
    const type = req.runtime === 'code' ? 'agent_to_code_execution' : 'agent_to_shell';
    const { command, args, cwd } = req;
    return this.guard(type, action('exec', { command, args, cwd }), this.failModes.exec);
  }

  /** Filesystem access: `agent_to_filesystem.<mode>`. Default fail-closed for every mode (`fsRead` / `fsWrite`). */
  beforeFsAccess(req: FsAccessRequest): Promise<InteractionHookResult> {
    const cls = FS_READ_MODES.has(req.mode) ? 'fsRead' : 'fsWrite';
    return this.guard('agent_to_filesystem', action(req.mode, { path: req.path }), this.failModes[cls]);
  }

  /** Browser action: `agent_to_browser.<action>`. Default fail-closed. */
  beforeBrowserAction(req: BrowserActionRequest): Promise<InteractionHookResult> {
    const args = { ...req.arguments, url: req.url };
    return this.guard('agent_to_browser', action(req.action, args), this.failModes.browser);
  }

  /** Any other interaction type (e.g. `agent_to_email`). Default fail-closed. */
  beforeInteraction(
    interactionType: InteractionType,
    act: InteractionAction,
    opts: { failMode?: FailMode } = {},
  ): Promise<InteractionHookResult> {
    return this.guard(interactionType, act, opts.failMode ?? 'closed');
  }

  /**
   * One raw decision request: no cache, no approval wait, no fail mode.
   * SDK-2503 — sent with `opts.idempotencyKey` (default a fresh UUID v4 per
   * call), reused across the client's retries of this call only.
   */
  async decide(
    interactionType: InteractionType,
    act: InteractionAction,
    approvalId?: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<InteractionDecision> {
    assertRequest(interactionType, act);
    const wireAction = act.arguments === undefined ? { name: act.name } : { name: act.name, arguments: act.arguments };
    let response: unknown;
    try {
      response = await this.client.post<unknown>(this.path, {
        interactionType,
        agentId: this.agentId,
        action: wireAction,
        ...(approvalId === undefined ? {} : { approvalId }),
        ...(this.taskId === undefined ? {} : { taskId: this.taskId }),
      }, undefined, { idempotencyKey: opts.idempotencyKey ?? randomUUID() });
    } catch (err) {
      throw taskNotLive(err, this.taskId);
    }
    return assertDecision(response);
  }

  /**
   * Record the result of an allowed interaction, once: by `approvalId` for a
   * consumed approval (BE-1582), by `decisionId` for a plain allow (BE-1808).
   * A refusal (unknown, not consumed/not a plain allow, already reported) is a
   * `PraesidiaApiError` with status 409; it is not retried. Reusing
   * `idempotencyKey` with a different report throws `IdempotencyKeyReusedError`. A verdict reused
   * from the decision cache shares its decisionId, so only its first run can report.
   */
  async reportOutcome(report: InteractionApprovalOutcomeReport): Promise<InteractionOutcomeReceipt & { approvalId: string }>;
  async reportOutcome(report: InteractionDecisionOutcomeReport): Promise<InteractionOutcomeReceipt & { approvalId: null }>;
  async reportOutcome(report: InteractionOutcomeReport): Promise<InteractionOutcomeReceipt>;
  async reportOutcome(report: InteractionOutcomeReport): Promise<InteractionOutcomeReceipt> {
    const { approvalId, decisionId, status, result, targetSystem, targetTransactionId, idempotencyKey } = report;
    if ((approvalId === undefined) === (decisionId === undefined)) {
      throw new PraesidiaConfigError('exactly one of approvalId or decisionId is required');
    }
    const [key, id] = approvalId !== undefined ? ['approvalId', approvalId] : ['decisionId', decisionId];
    if (typeof id !== 'string' || id.length === 0) {
      throw new PraesidiaConfigError(`${key} must be a non-empty string`);
    }
    if (!(INTERACTION_OUTCOME_STATUSES as readonly string[]).includes(status)) {
      throw new PraesidiaConfigError(`status must be one of ${INTERACTION_OUTCOME_STATUSES.join(', ')}`);
    }
    return this.client.post<InteractionOutcomeReceipt>(`${this.path}/outcome`, {
      agentId: this.agentId,
      [key]: id,
      status,
      ...(result === undefined ? {} : { resultCommitment: jcsCommitment(result) }),
      ...(targetSystem === undefined ? {} : { targetSystem }),
      ...(targetTransactionId === undefined ? {} : { targetTransactionId }),
    }, undefined, { idempotencyKey: idempotencyKey ?? randomUUID() });
  }

  private async guard(
    type: InteractionType,
    act: InteractionAction,
    failMode: FailMode,
  ): Promise<InteractionHookResult> {
    assertRequest(type, act);
    const key = jcsCommitment({ interactionType: type, action: act as unknown as JsonValue });
    const hit = this.cache.get(key);
    let decision: InteractionDecision;
    if (hit && hit.expiresAt > Date.now()) {
      decision = hit.decision;
    } else {
      try {
        decision = await this.ask(key, type, act);
      } catch (err) {
        if (!isOutage(err)) throw err;
        if (failMode === 'closed') throw new InteractionDecisionUnavailableError(type, act.name, err);
        return { decision: null, failOpenError: err };
      }
    }
    if (decision.verdict === 'require_approval') decision = await this.awaitApproval(key, type, act, decision);
    if (decision.verdict === 'deny') {
      throw new InteractionDeniedError(type, act.name, decision.reasonCode, decision);
    }
    return { decision };
  }

  /**
   * Re-POST echoing the approvalId until the verdict changes. An outage while
   * waiting never turns a pending approval into an allow: it keeps waiting,
   * then denies with `approval_wait_timeout`.
   */
  private async awaitApproval(
    key: string,
    type: InteractionType,
    act: InteractionAction,
    pending: InteractionDecision,
  ): Promise<InteractionDecision> {
    this.onApprovalRequired?.(pending);
    const deadline = Date.now() + this.approvalTimeoutMs;
    let current = pending;
    while (Date.now() < deadline) {
      await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
      try {
        current = await this.ask(key, type, act, current.approvalId ?? undefined);
      } catch (err) {
        if (!isOutage(err)) throw err;
        continue;
      }
      if (current.verdict !== 'require_approval') return current;
    }
    throw new InteractionDeniedError(type, act.name, 'approval_wait_timeout', current);
  }

  /** Fresh decision; a new policy fingerprint evicts every cached verdict (BE-0328 pattern). */
  private async ask(
    key: string,
    type: InteractionType,
    act: InteractionAction,
    approvalId?: string,
  ): Promise<InteractionDecision> {
    const decision = await this.decide(type, act, approvalId);
    if (decision.policyFingerprint !== this.fingerprint) {
      this.cache.clear();
      this.fingerprint = decision.policyFingerprint;
    }
    if (decision.ttlSeconds > 0 && decision.verdict !== 'require_approval') {
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, { decision, expiresAt: Date.now() + decision.ttlSeconds * 1000 });
    }
    return decision;
  }
}

/** Drop undefined argument values; omit `arguments` when nothing is left. */
function action(name: string, args?: Record<string, JsonValue | undefined>): InteractionAction {
  const kept = Object.entries(args ?? {}).filter(([, v]) => v !== undefined) as [string, JsonValue][];
  return kept.length === 0 ? { name } : { name, arguments: Object.fromEntries(kept) };
}

function assertRequest(type: InteractionType, act: InteractionAction): void {
  if (!(INTERACTION_TYPES as readonly string[]).includes(type)) {
    throw new PraesidiaConfigError(`interactionType must be one of ${INTERACTION_TYPES.join(', ')}`);
  }
  if (typeof act?.name !== 'string' || act.name.length > 200 || !ACTION_NAME.test(act.name)) {
    throw new PraesidiaConfigError('action name must be dot-separated segments of [A-Za-z0-9_-], at most 200 chars');
  }
  const args: unknown = act.arguments;
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    throw new PraesidiaConfigError('action arguments must be a JSON object');
  }
}

/** be BE-2836's 403 message (no `code` is sent) for a token-less `taskId` that is not a live task. */
const TASK_NOT_LIVE = 'taskId is not a live task this agent executes';

/** `err` as {@link InteractionTaskNotLiveError} when it is be's BE-2836 403 for the `taskId` sent. */
function taskNotLive(err: unknown, taskId: string | undefined): unknown {
  return taskId !== undefined && err instanceof PraesidiaApiError && err.status === 403 && err.body?.message === TASK_NOT_LIVE
    ? new InteractionTaskNotLiveError(taskId, err.path, JSON.stringify(err.body), err.body)
    : err;
}

function assertDecision(value: unknown): InteractionDecision {
  const d = value as Partial<InteractionDecision> | null;
  const ttl = d?.ttlSeconds;
  if (
    !d || typeof d !== 'object' ||
    !(INTERACTION_VERDICTS as readonly unknown[]).includes(d.verdict) ||
    typeof d.reasonCode !== 'string' ||
    typeof d.policyFingerprint !== 'string' ||
    typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0 ||
    (d.verdict === 'require_approval' && typeof d.approvalId !== 'string')
  ) {
    throw markOutage(new Error('malformed interaction decision response')); // malformed 2xx = outage
  }
  return d as InteractionDecision;
}

function positiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new PraesidiaConfigError(`${label} must be a positive integer`);
  return value;
}
