/**
 * Configuration for PraesidiaGuard.
 *
 * All fields fall back to environment variables when omitted:
 *   PRAESIDIA_API_KEY    — org-scoped API key (Authorization: Bearer)
 *   PRAESIDIA_ORG_ID     — organization UUID
 *   PRAESIDIA_AGENT_ID   — agent UUID (optional; scopes guardrail evaluation)
 *   PRAESIDIA_BASE_URL   — defaults to https://api.praesidia.ai
 */
export interface GuardConfig {
  apiKey?: string;
  orgId?: string;
  agentId?: string;
  baseUrl?: string;
  /**
   * When true, a network error reaching Praesidia throws instead of being
   * swallowed. Input guardrail blocks always throw regardless of this flag
   * (fail-CLOSED by default on content violations). Defaults to false.
   */
  strict?: boolean;
  /**
   * When true, network errors reaching Praesidia are ignored and execution
   * continues. This only affects connectivity failures — a content block
   * (guardrail triggered) always throws GuardrailBlockedError.
   * Overrides `strict` for network errors. Defaults to false.
   */
  failOpen?: boolean;
}

/**
 * Options passed to guard.run().
 */
export interface RunOptions {
  /** The user input / prompt that will be sent to the LLM. */
  input: string;
  /** Arbitrary key/value context attached to the audit record. */
  context?: Record<string, unknown>;
  /** Override the agent ID for this call (falls back to config.agentId). */
  agentId?: string;
  /** Task type label surfaced in the audit log. */
  taskType?: string;
}

/**
 * Options for standalone checkInput / checkOutput calls.
 */
export interface CheckOptions {
  agentId?: string;
  context?: Record<string, unknown>;
}

/**
 * Result of a guardrail content check.
 */
export interface CheckResult {
  /** True if the content passed all guardrails. */
  passed: boolean;
  /** Guardrails that were triggered (non-empty when passed is false). */
  triggered: TriggeredGuardrail[];
  /** Server-side processing time in milliseconds. */
  processingTimeMs?: number;
  /** Correlation ID echoed from the request. */
  requestId?: string;
  /** Set to true when the result was produced by local rule-based checks
   *  (no API key / no connectivity). */
  local?: boolean;
}

/**
 * A single triggered guardrail entry inside CheckResult.
 */
export interface TriggeredGuardrail {
  guardrailId: string;
  guardrailName: string;
  category: string;
  severity: string;
  action: string;
  reason: string;
  confidenceScore?: number;
  matchedPatterns?: string[];
  matchedKeywords?: string[];
}

/**
 * The wrapped result returned by guard.run().
 */
export interface GuardedResult<T> {
  /** The value returned by the wrapped function. */
  output: T;
  /** Praesidia task ID created for this run. Undefined in local/offline mode. */
  taskId?: string;
  /** Result of the input guardrail check. */
  inputCheck: CheckResult;
  /** Result of the output guardrail check. */
  outputCheck: CheckResult;
}

/**
 * A task record for manual logging via guard.logTask().
 */
export interface TaskRecord {
  /** The agent ID that executed this task. Falls back to config.agentId. */
  agentId?: string;
  /** Input prompt / message. */
  input?: string;
  /** Output / response from the agent. */
  output?: string;
  /** Task type label (e.g. "chat", "code", "summary"). */
  taskType?: string;
  /** Token usage for cost tracking. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
  };
  /** Arbitrary context attached to the audit record. */
  context?: Record<string, unknown>;
  /** ISO-8601 timestamp. Defaults to now. */
  startedAt?: string;
  /** ISO-8601 timestamp. Defaults to now. */
  completedAt?: string;
  /** Task status. Defaults to "completed". */
  status?: 'pending' | 'running' | 'completed' | 'failed';
}

/**
 * A tool-call record for tracking via guard.trackToolCall().
 */
export interface ToolCallRecord {
  /** Name of the tool that was invoked. */
  name: string;
  /** Arguments passed to the tool. */
  args?: unknown;
  /** Associate this tool call with an existing Praesidia task ID. */
  taskId?: string;
}
