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
