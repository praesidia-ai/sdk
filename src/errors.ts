import type { TriggeredGuardrail } from './types.js';

/**
 * Thrown by PraesidiaGuard.run() and checkInput() when the input content
 * is blocked by one or more guardrails.
 *
 * The wrapped function is NOT called when this is thrown — the guard fails
 * closed on content violations (this behaviour is not affected by failOpen).
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
 * Thrown when the Praesidia API returns an unexpected HTTP error and
 * strict mode is enabled (or the call is not fail-open).
 */
export class PraesidiaApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(`Praesidia API error [${status}] ${path}: ${message}`);
    this.name = 'PraesidiaApiError';
    this.status = status;
    this.path = path;
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
 * `actionId`/`closure` are populated once `be`'s response carries them (see
 * `.claude/tickets/PA01-CONTRACT-sdk-action-response.md`) — `undefined`
 * until that contract lands.
 */
export class ProtectedActionDeniedError extends Error {
  readonly errorCode: string | undefined;
  readonly actionId: string | undefined;
  readonly closure: string | undefined;

  constructor(
    message: string,
    errorCode?: string,
    actionId?: string,
    closure?: string,
  ) {
    super(message);
    this.name = 'ProtectedActionDeniedError';
    this.errorCode = errorCode;
    this.actionId = actionId;
    this.closure = closure;
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
