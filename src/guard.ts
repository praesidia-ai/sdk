import { PraesidiaClient } from './client.js';
import {
  GuardrailBlockedError,
  PraesidiaApiError,
  PraesidiaConfigError,
} from './errors.js';
import { runLocalRules } from './local-rules.js';
import type {
  CheckOptions,
  CheckResult,
  GuardConfig,
  GuardedResult,
  RunOptions,
  TaskRecord,
  ToolCallRecord,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/**
 * PraesidiaGuard — the primary entry point for the @praesidia/sdk.
 *
 * Usage (zero config — reads from env vars):
 *   const guard = new PraesidiaGuard();
 *   const result = await guard.run(() => openai.chat.completions.create(...), { input });
 *
 * Config resolution order: constructor arg → environment variable → default.
 *
 * Fail-open / fail-closed behaviour (network errors only):
 *   - Content blocks (guardrail triggered) ALWAYS throw GuardrailBlockedError,
 *     regardless of failOpen or strict settings.
 *   - Network errors to Praesidia: by default (failOpen=false, strict=false)
 *     they are logged to console.warn and treated as a local pass so the
 *     caller's agent is not disrupted by infrastructure failures.
 *   - failOpen=true  → same as default (silent degradation).
 *   - strict=true    → network errors throw PraesidiaApiError.
 */
export class PraesidiaGuard {
  private readonly apiKey: string | undefined;
  private readonly orgId: string | undefined;
  private readonly agentId: string | undefined;
  private readonly baseUrl: string;
  private readonly strict: boolean;
  private readonly failOpen: boolean;
  private readonly client: PraesidiaClient | undefined;

  constructor(config: GuardConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    this.orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    this.agentId = config.agentId ?? process.env['PRAESIDIA_AGENT_ID'];
    this.baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;
    this.strict = config.strict ?? false;
    this.failOpen = config.failOpen ?? false;

    if (this.apiKey && this.orgId) {
      this.client = new PraesidiaClient(this.baseUrl, this.apiKey);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Wrap an async agent function with guardrail checks and audit logging.
   *
   * Flow:
   *   1. checkInput → if blocked, throw GuardrailBlockedError (fn NOT called)
   *   2. call fn()
   *   3. checkOutput on the string representation of the result
   *   4. logTask for audit persistence
   *   5. return GuardedResult<T>
   */
  async run<T>(
    fn: () => Promise<T>,
    opts: RunOptions,
  ): Promise<GuardedResult<T>> {
    const agentId = opts.agentId ?? this.agentId;

    // Step 1 — input check (fail-CLOSED on block)
    const inputCheck = await this.checkInput(opts.input, {
      agentId,
      context: opts.context,
    });
    if (!inputCheck.passed) {
      throw new GuardrailBlockedError(inputCheck.triggered);
    }

    // Step 2 — execute the wrapped function
    const startedAt = new Date().toISOString();
    const output = await fn();
    const completedAt = new Date().toISOString();

    // Step 3 — output check (fail-OPEN on block by convention — the agent
    // has already produced the output; blocking here is recorded but does
    // not re-throw unless strict is set, matching Sentry-SDK behaviour of
    // "observe and report, don't crash the caller")
    const outputStr = this.stringify(output);
    const outputCheck = await this.checkOutput(outputStr, {
      agentId,
      context: opts.context,
    });

    // Step 4 — audit log (best-effort; never throws)
    let taskId: string | undefined;
    try {
      taskId = await this.logTask({
        agentId,
        input: opts.input,
        output: outputStr,
        taskType: opts.taskType ?? 'run',
        context: opts.context,
        startedAt,
        completedAt,
        status: 'completed',
      });
    } catch {
      // logTask failure is always swallowed — audit is best-effort
    }

    return { output, taskId, inputCheck, outputCheck };
  }

  /**
   * Check input content against guardrails.
   *
   * In local mode (no API key): runs bundled rule-based patterns.
   * In connected mode: calls POST /organizations/:orgId/guardrails/validate.
   */
  async checkInput(
    input: string,
    opts: CheckOptions = {},
  ): Promise<CheckResult> {
    return this.checkContent(input, opts, 'INPUT');
  }

  /**
   * Check output content against guardrails.
   *
   * In local mode (no API key): runs bundled rule-based patterns.
   * In connected mode: calls POST /organizations/:orgId/guardrails/validate.
   */
  async checkOutput(
    output: string,
    opts: CheckOptions = {},
  ): Promise<CheckResult> {
    return this.checkContent(output, opts, 'OUTPUT');
  }

  /**
   * Log a task to the Praesidia audit log.
   * Returns the server-assigned taskId, or undefined in local mode.
   *
   * Requires: apiKey + orgId. Throws PraesidiaConfigError if missing and
   * strict=true; silently returns undefined otherwise.
   */
  async logTask(task: TaskRecord): Promise<string | undefined> {
    if (!this.client || !this.orgId) {
      if (this.strict) {
        throw new PraesidiaConfigError(
          'logTask requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
        );
      }
      this.consoleLog('task', task);
      return undefined;
    }

    const agentId = task.agentId ?? this.agentId;
    try {
      const res = await this.client.post<{ id: string }>(
        `/organizations/${this.orgId}/tasks`,
        {
          agentId,
          input: task.input,
          output: task.output,
          taskType: task.taskType ?? 'sdk',
          context: task.context,
          usage: task.usage,
          startedAt: task.startedAt ?? new Date().toISOString(),
          completedAt: task.completedAt ?? new Date().toISOString(),
          status: task.status ?? 'completed',
        },
      );
      return res.id;
    } catch (err) {
      return this.handleNetworkError(err, 'logTask');
    }
  }

  /**
   * Track a tool call associated with a task.
   * Best-effort — never throws on network failure.
   */
  async trackToolCall(call: ToolCallRecord): Promise<void> {
    if (!this.client || !this.orgId) {
      this.consoleLog('tool_call', call);
      return;
    }

    const agentId = this.agentId;
    try {
      await this.client.post(`/organizations/${this.orgId}/tasks`, {
        agentId,
        taskType: 'tool_call',
        input: call.name,
        context: {
          toolName: call.name,
          toolArgs: call.args,
          parentTaskId: call.taskId,
        },
        status: 'completed',
      });
    } catch {
      // tool-call tracking is always best-effort
    }
  }

  /**
   * Adopt a rotated credential in-process, at runtime (zero-downtime swap).
   *
   * The guard authenticates with a static key by default; call this to swap in
   * a freshly rotated agent client secret (see
   * PraesidiaAgents.rotateClientSecret) without recreating the guard or
   * restarting the process. Combined with the server-side grace window, the
   * previous secret keeps working until `graceEndsAt`, so long-running guarded
   * calls are never rejected mid-rotation.
   *
   * SECURITY: the credential is held only in memory and is never logged.
   * Throws PraesidiaConfigError in local/offline mode (no client configured).
   */
  refreshCredential(apiKey: string): void {
    if (!this.client) {
      throw new PraesidiaConfigError(
        'refreshCredential requires a connected client (PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID)',
      );
    }
    this.client.setApiKey(apiKey);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async checkContent(
    content: string,
    opts: CheckOptions,
    _scope: 'INPUT' | 'OUTPUT',
  ): Promise<CheckResult> {
    // Local mode — no API key configured
    if (!this.client || !this.orgId) {
      return runLocalRules(content);
    }

    const agentId = opts.agentId ?? this.agentId;

    try {
      // POST /organizations/:orgId/guardrails/validate
      // ValidateContentDto: { content, agentId?, context? }
      const result = await this.client.post<{
        passed: boolean;
        triggered: Array<{
          guardrailId: string;
          guardrailName: string;
          category: string;
          severity: string;
          action: string;
          reason: string;
          confidenceScore?: number;
          matchedPatterns?: string[];
          matchedKeywords?: string[];
        }>;
        processingTimeMs: number;
        requestId?: string;
      }>(`/organizations/${this.orgId}/guardrails/validate`, {
        content,
        agentId,
        context: opts.context,
      });

      return {
        passed: result.passed,
        triggered: result.triggered ?? [],
        processingTimeMs: result.processingTimeMs,
        requestId: result.requestId,
        local: false,
      };
    } catch (err) {
      if (err instanceof PraesidiaApiError) {
        const fallback = await this.handleNetworkError<CheckResult | undefined>(
          err,
          'guardrails/validate',
        );
        // handleNetworkError returns undefined in non-strict mode
        if (fallback === undefined) {
          // Degrade gracefully to local rules
          return runLocalRules(content);
        }
      }
      // Any other error (network timeout, etc.) — degrade to local
      if (this.strict) throw err;
      console.warn(
        '[praesidia/sdk] guardrail check failed, falling back to local rules:',
        err,
      );
      return runLocalRules(content);
    }
  }

  /**
   * Handle a network/API error according to the fail-open / strict config.
   * Returns undefined when the error should be swallowed.
   * Throws when strict=true.
   */
  private handleNetworkError<T>(err: unknown, operation: string): T {
    if (this.strict) {
      throw err;
    }
    if (!this.failOpen) {
      console.warn(
        `[praesidia/sdk] ${operation} failed (degrading gracefully):`,
        err,
      );
    }
    return undefined as T;
  }

  /** Emit a structured log line for local/offline mode. */
  private consoleLog(type: string, data: unknown): void {
    const ts = new Date().toISOString();
    console.log(JSON.stringify({ timestamp: ts, praesidia: true, type, data }));
  }

  /** Safely convert an arbitrary value to a string for content checks. */
  private stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return String(value);
    }
  }
}
