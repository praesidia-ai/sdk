import type { ActionDenyReason, TriggeredGuardrail } from './types.js';

/**
 * Thrown when content is blocked by one or more guardrails. An input block is
 * raised before `PraesidiaGuard.run()` calls the wrapped function. In strict
 * mode an output block is raised after the function runs and its failed audit
 * task is persisted, but the blocked output is never returned to the caller.
 * `failOpen` affects connectivity failures only, not content-block decisions.
 */
export class GuardrailBlockedError extends Error {
  readonly triggered: TriggeredGuardrail[];

  constructor(triggered: TriggeredGuardrail[]) {
    const summary =
      triggered.length === 1
        ? `${triggered[0].guardrailName} (${triggered[0].severity})`
        : `${triggered.length} guardrails`;
    super(`Content blocked by ${summary}`);
    this.name = 'GuardrailBlockedError';
    this.triggered = triggered;
    // Maintain proper prototype chain in ES5 transpile targets
    Object.setPrototypeOf(this, GuardrailBlockedError.prototype);
  }
}

/**
 * be's structured JSON error envelope
 * (`be/src/common/filters/http-exception.filter.ts`). Every field except
 * `statusCode`/`message` is optional — older/other exceptions may omit
 * `details`/`retryAfter`/`code`, and a non-JSON or unparseable error body
 * means this type is never constructed at all (see `PraesidiaApiError.body`).
 * Deliberately an index signature, not a closed interface: SCAN2-007's
 * forward-compatibility requirement is that a field be adds later survives
 * untouched on `.body` even though this SDK version has no named property
 * for it yet.
 */
export interface PraesidiaErrorEnvelope {
  statusCode?: number;
  timestamp?: string;
  path?: string;
  method?: string;
  requestId?: string;
  message?: string;
  details?: unknown;
  retryAfter?: number;
  code?: string;
  [key: string]: unknown;
}

/**
 * Thrown when the Praesidia API returns an unexpected HTTP error and
 * strict mode is enabled (or the call is not fail-open).
 *
 * SCAN2-007 — `message` keeps its original, pre-existing format (the whole
 * response body appended to a synthesized prefix) for backwards
 * compatibility: any caller that already reads `.message` keeps working
 * unchanged. `code`/`requestId`/`details`/`retryAfter`/`retryable` are new,
 * purely additive, typed properties read from be's structured error envelope
 * when the body parses as JSON; each is `undefined` when the body doesn't
 * carry that field (or isn't JSON at all — a caller must not assume they are
 * present). `body` is the full raw parsed envelope (or `undefined` if the
 * response wasn't valid JSON), so a field be adds later is never silently
 * dropped even by an SDK version that predates it.
 */
export class PraesidiaApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly details: unknown;
  readonly retryAfter: number | undefined;
  readonly retryable: boolean;
  readonly body: PraesidiaErrorEnvelope | undefined;

  constructor(
    status: number,
    path: string,
    message: string,
    envelope?: PraesidiaErrorEnvelope,
    retryable = false,
  ) {
    super(`Praesidia API error [${status}] ${path}: ${message}`);
    this.name = 'PraesidiaApiError';
    this.status = status;
    this.path = path;
    this.code = envelope?.code;
    this.requestId = envelope?.requestId;
    this.details = envelope?.details;
    this.retryAfter = envelope?.retryAfter;
    this.retryable = retryable;
    this.body = envelope;
    Object.setPrototypeOf(this, PraesidiaApiError.prototype);
  }
}

/**
 * Thrown when the SDK is used without a valid configuration (missing
 * API key or org ID) and the requested operation requires a connected
 * Praesidia account.
 */
export class PraesidiaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PraesidiaConfigError';
    Object.setPrototypeOf(this, PraesidiaConfigError.prototype);
  }
}

/**
 * PA01 DX-001 — thrown by `guard.protectAction()` when the managed MCP Proof
 * Edge (or an upstream policy/RBAC gate on the same route) denies the
 * dispatch: no/expired/invalid/replayed Permit, a commitment mismatch, or a
 * confirmed replay (`DUPLICATE_SUPPRESSED`, which denies even in
 * observe-mode — see D8/D9). Distinct from a tool-level failure (the tool
 * dispatched and reported its OWN error — that does not throw, it comes back
 * as `ProtectActionResult.isError`).
 *
 * PA-0026 — `guard.protectAction` throws this if and only if `be`'s response
 * carries `actionDenyReason` (see {@link ActionDenyReason}); a downstream
 * tool/transport error (`errorCode: 'BAD_REQUEST' | 'INTERNAL_ERROR'`, no
 * `actionDenyReason`) never reaches this constructor. `actionId`/`closure`
 * are populated whenever `be`'s response carries them — `undefined` when the
 * denial happened before the Proof Edge block ran (`actionDenyReason ===
 * 'POLICY_DENIED'`).
 */
export class ProtectedActionDeniedError extends Error {
  readonly errorCode: string | undefined;
  readonly actionId: string | undefined;
  readonly closure: string | undefined;
  /** PA-0026 — the reliable discriminator this error was thrown on. Always defined when this error is thrown by `protectAction`. */
  readonly actionDenyReason: ActionDenyReason | undefined;

  constructor(
    message: string,
    errorCode?: string,
    actionId?: string,
    closure?: string,
    actionDenyReason?: ActionDenyReason,
  ) {
    super(message);
    this.name = 'ProtectedActionDeniedError';
    this.errorCode = errorCode;
    this.actionId = actionId;
    this.closure = closure;
    this.actionDenyReason = actionDenyReason;
    Object.setPrototypeOf(this, ProtectedActionDeniedError.prototype);
  }
}

/**
 * PA01 DX-001 — thrown by `guard.protectAction()` when the target's
 * `protocol` is not the managed MCP path. Fails LOUDLY rather than silently
 * downgrading to `trackToolCall`-style best-effort (grade D) telemetry — the
 * customer-controlled Proof Edge that would make an arbitrary destination
 * honestly protectable (EDGE-003) is explicitly out of PA01 scope (D11).
 */
export class UnsupportedProtectedActionTargetError extends Error {
  readonly protocol: string;

  constructor(protocol: string) {
    super(
      `protectAction: target protocol "${protocol}" is unsupported until the ` +
        'customer-controlled Proof Edge ships (EDGE-003 — out of scope for the ' +
        'current release). Only the managed MCP path ("mcp") is supported by ' +
        'this SDK version.',
    );
    this.name = 'UnsupportedProtectedActionTargetError';
    this.protocol = protocol;
    Object.setPrototypeOf(this, UnsupportedProtectedActionTargetError.prototype);
  }
}
