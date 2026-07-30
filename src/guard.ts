import { encodePathSegment, PraesidiaClient } from './client.js';
import {
  GuardrailBlockedError,
  PraesidiaConfigError,
} from './errors.js';
import { runLocalRules } from './local-rules.js';
import type {
  AgentIdentity,
  AgentTaskType,
  BeginTaskOptions,
  CheckOptions,
  CheckResult,
  CompleteTaskOptions,
  GuardConfig,
  GuardedResult,
  PolledTaskRow,
  RunOptions,
  TaskHandle,
  TaskRecord,
  ToolCallContext,
  ToolCallRecord,
} from './types.js';

/** Q4-02 — request headers the SDK forwards on a task-scoped MCP tool call. */
const TASK_ID_HEADER = 'X-Praesidia-Task-Id';
const AGENT_ID_HEADER = 'X-Praesidia-Agent-Id';
const CHAIN_ID_HEADER = 'X-Praesidia-Chain-Id';
const CAPABILITY_TOKEN_HEADER = 'X-Praesidia-Capability-Token';

/**
 * Q3-02 / Q4-02 — extract the chain + capability context off a polled task row
 * so it can be threaded straight into `trackToolCall`. The capability token is
 * copied opaquely (never inspected, never logged).
 */
export function toolCallContextFromTask(
  task: Pick<
    PolledTaskRow,
    'id' | 'chainId' | 'capabilityToken' | 'serverAgentId'
  >,
): ToolCallContext {
  return {
    taskId: task.id,
    agentId: task.serverAgentId,
    chainId: task.chainId,
    capabilityToken: task.capabilityToken,
  };
}

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/** AUDIT-SDK-02 — RFC-4122 UUID matcher. `CreateAgentTaskDto.chainId` is
 *  `@IsUUID`, so only a real UUID may be forwarded as `chainId`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * AUDIT-SDK-02 — build the DTO-required non-empty `input` OBJECT for
 * `CreateAgentTaskDto` from a `TaskRecord`-shaped record. A string prompt is
 * wrapped as `{ message }`; an object input is spread as-is. The SDK's
 * telemetry (output/usage/context) is preserved as NESTED keys — they are not
 * top-level DTO fields, so nesting keeps the body valid under the backend's
 * `whitelist` + `forbidNonWhitelisted` ValidationPipe (main.ts:344-346).
 */
function buildTaskInput(task: {
  input?: string | Record<string, unknown>;
  output?: string;
  usage?: unknown;
  context?: Record<string, unknown>;
  taskType?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
}): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (typeof task.input === 'string') {
    input.message = task.input;
  } else if (task.input && typeof task.input === 'object') {
    Object.assign(input, task.input);
  }
  if (task.output !== undefined) input.output = task.output;
  if (task.usage !== undefined) input.usage = task.usage;
  if (task.context !== undefined) input.context = task.context;
  if (task.taskType !== undefined) input.taskType = task.taskType;
  if (task.status !== undefined) input.status = task.status;
  if (task.startedAt !== undefined) input.startedAt = task.startedAt;
  if (task.completedAt !== undefined) input.completedAt = task.completedAt;
  // @IsObject + @IsNotEmpty require a present object; guarantee ≥1 key.
  if (Object.keys(input).length === 0) input.message = '';
  return input;
}

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
  private readonly orgPathSegment: string | undefined;
  private readonly agentId: string | undefined;
  private readonly connectionId: string | undefined;
  private readonly baseUrl: string;
  private readonly strict: boolean;
  private readonly failOpen: boolean;
  private readonly client: PraesidiaClient | undefined;

  constructor(config: GuardConfig = {}) {
    this.apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    this.orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    this.orgPathSegment = this.orgId
      ? encodePathSegment(this.orgId, 'orgId')
      : undefined;
    this.agentId = config.agentId ?? process.env['PRAESIDIA_AGENT_ID'];
    // AUDIT-SDK-02 — default connection tasks are routed through.
    this.connectionId =
      config.connectionId ?? process.env['PRAESIDIA_CONNECTION_ID'];
    this.baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;
    this.strict = config.strict ?? false;
    this.failOpen = config.failOpen ?? false;

    if (this.apiKey && this.orgId) {
      this.client = new PraesidiaClient(
        this.baseUrl,
        this.apiKey,
        config.requestTimeoutMs,
        config.retry,
      );
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * H1-02a — the agent identity this guard operates as (org + agent + base URL).
   *
   * Synchronous, side-effect-free accessor so a framework adapter (H1-02c) or an
   * agent can introspect who it is running as before instrumenting a call.
   * `orgId` / `agentId` are undefined in local/offline mode; `connected` is true
   * only when an authenticated client is configured.
   */
  identity(): AgentIdentity {
    return {
      orgId: this.orgId,
      agentId: this.agentId,
      baseUrl: this.baseUrl,
      connected: this.client !== undefined,
    };
  }

  /**
   * H1-02a — the guardrail PRE hook: check input and FAIL-CLOSED on a block.
   *
   * A drop-in for framework adapters (LangGraph/CrewAI/etc.) that need a single
   * call which throws `GuardrailBlockedError` when the input is blocked (the
   * wrapped model call must not run) and otherwise returns the `CheckResult`.
   * This is exactly the step `run()` performs internally, exposed standalone so
   * an adapter can wire it as a "before" middleware.
   */
  async guardInput(
    input: string,
    opts: CheckOptions = {},
  ): Promise<CheckResult> {
    const result = await this.checkInput(input, opts);
    if (!result.passed) {
      throw new GuardrailBlockedError(result.triggered);
    }
    return result;
  }

  /**
   * H1-02a — the guardrail POST hook: check output after the model has answered.
   *
   * By convention the output check is fail-OPEN (the agent already produced the
   * output) — it returns the `CheckResult` for the caller to inspect/record and
   * only THROWS `GuardrailBlockedError` when `throwOnBlock` is set (or the guard
   * was constructed with `strict: true`), so a strict adapter can hard-block a
   * violating response.
   */
  async guardOutput(
    output: string,
    opts: CheckOptions & { throwOnBlock?: boolean } = {},
  ): Promise<CheckResult> {
    const result = await this.checkOutput(output, opts);
    if (!result.passed && (opts.throwOnBlock ?? this.strict)) {
      throw new GuardrailBlockedError(result.triggered);
    }
    return result;
  }

  /**
   * H1-02a — open an explicit task-lifecycle handle.
   *
   * Captures the start time (and input/agent/chain/context) locally and records
   * EXACTLY ONE audit task row when you call `handle.complete(output)` or
   * `handle.fail(error)` — never two — so a lifecycle maps 1:1 to a single task.
   * Use it when you want begin/end semantics around your own agent code instead
   * of the all-in-one `run()`:
   *
   *   const task = guard.beginTask({ input, taskType: 'chat' });
   *   try {
   *     const out = await callMyLLM(input);
   *     await task.complete(out, { usage });
   *   } catch (e) {
   *     await task.fail(e);
   *     throw e;
   *   }
   *
   * Best-effort like `logTask`: recording never throws on a network error
   * (unless `strict`), so the lifecycle can't disrupt the agent.
   */
  beginTask(opts: BeginTaskOptions = {}): TaskHandle {
    const startedAt = new Date().toISOString();
    const base = {
      agentId: opts.agentId ?? this.agentId,
      input: opts.input,
      taskType: opts.taskType ?? 'run',
      context: opts.context,
      // AUDIT-SDK-02 — carry the connection + DTO task type through to logTask.
      connectionId: opts.connectionId,
      type: opts.type,
      chainId: opts.chainId,
      startedAt,
    };
    const record = (
      status: 'completed' | 'failed',
      output: string | undefined,
      finalize: CompleteTaskOptions | undefined,
    ): Promise<string | undefined> =>
      this.logTask({
        ...base,
        output,
        usage: finalize?.usage,
        context: finalize?.context
          ? { ...(base.context ?? {}), ...finalize.context }
          : base.context,
        completedAt: new Date().toISOString(),
        status,
      });

    return {
      complete: (output, finalize) => record('completed', output, finalize),
      fail: (error, finalize) =>
        record('failed', this.errorToString(error), finalize),
    };
  }

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
      chainId: opts.chainId,
    });
    if (!inputCheck.passed) {
      throw new GuardrailBlockedError(inputCheck.triggered);
    }

    // Step 2 — execute the wrapped function
    const startedAt = new Date().toISOString();
    let output: T;
    try {
      output = await fn();
    } catch (error) {
      try {
        await this.logTask({
          agentId,
          input: opts.input,
          output: this.errorToString(error),
          taskType: opts.taskType ?? 'run',
          context: opts.context,
          connectionId: opts.connectionId,
          type: opts.type,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'failed',
          chainId: opts.chainId,
        });
      } catch {
        // Preserve the agent's original failure; audit recording is best-effort.
      }
      throw error;
    }
    const completedAt = new Date().toISOString();

    // Step 3 — output check (fail-OPEN on block by convention — the agent
    // has already produced the output; blocking here is recorded but does
    // not re-throw unless strict is set, matching Sentry-SDK behaviour of
    // "observe and report, don't crash the caller")
    const outputStr = this.stringify(output);
    const outputCheck = await this.checkOutput(outputStr, {
      agentId,
      context: opts.context,
      chainId: opts.chainId,
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
        // AUDIT-SDK-02 — required to build a valid CreateAgentTaskDto.
        connectionId: opts.connectionId,
        type: opts.type,
        startedAt,
        completedAt,
        status: 'completed',
        chainId: opts.chainId,
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

    // AUDIT-SDK-02 — `POST /organizations/:orgId/tasks` binds
    // `CreateAgentTaskDto`, which REQUIRES `connectionId` (UUID), `type`
    // (AgentTaskType) and a non-empty `input` OBJECT. Resolve the connection;
    // without one no valid DTO can be built, so surface it clearly (strict →
    // throw, otherwise warn + skip) instead of silently 400ing as the old
    // `{ agentId, input:<string>, output, … }` body did.
    const connectionId = task.connectionId ?? this.connectionId;
    if (!connectionId) {
      if (this.strict) {
        throw new PraesidiaConfigError(
          'logTask requires a connectionId — pass task.connectionId or set ' +
            'connectionId in the Praesidia config (env PRAESIDIA_CONNECTION_ID)',
        );
      }
      this.consoleLog('task:skipped(no connectionId)', task);
      return undefined;
    }

    // Q3-02 — a task can carry an inbound chain id explicitly, otherwise the
    // client forwards whatever chain is currently being propagated.
    const chainId = task.chainId ?? this.client.getChainId();
    try {
      const res = await this.client.post<{ id: string }>(
        `/organizations/${this.orgPathSegment}/tasks`,
        this.buildTaskBody(
          connectionId,
          task.type ?? 'MESSAGE',
          buildTaskInput(task),
          chainId,
        ),
        chainId ? { [CHAIN_ID_HEADER]: chainId } : undefined,
      );
      return res.id;
    } catch (err) {
      return this.handleNetworkError(err, 'logTask');
    }
  }

  /**
   * AUDIT-SDK-02 — assemble a `CreateAgentTaskDto`-valid request body. Only DTO
   * fields are emitted (the backend's whitelist ValidationPipe rejects unknown
   * keys). `chainId` is forwarded ONLY when it is a real UUID — the DTO's
   * `@IsUUID` would 400 otherwise, and the SDK only ever echoes a server-minted
   * (UUID) chain id.
   */
  private buildTaskBody(
    connectionId: string,
    type: AgentTaskType,
    input: Record<string, unknown>,
    chainId?: string | null,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { connectionId, type, input };
    if (chainId && isUuid(chainId)) body.chainId = chainId;
    return body;
  }

  /**
   * Q3-02 — adopt an inbound chain-trace id and forward it (unchanged) on every
   * subsequent outbound call as `X-Praesidia-Chain-Id`. Call this with the id
   * echoed from an inbound `X-Praesidia-Chain-Id` header so a chain stays
   * correlated across SDK-driven hops. Pass `null` to stop propagating.
   *
   * The SDK NEVER mints a chainId — it only propagates one it received. No-op
   * in local/offline mode (no connected client).
   */
  forwardChain(chainId: string | null | undefined): void {
    this.client?.setChainId(chainId);
  }

  /**
   * Track a tool call associated with a task.
   * Best-effort — never throws on network failure.
   *
   * Q4-02 — when the tool call is scoped to a claimed task, thread the four
   * task-binding fields (`capabilityToken`, `taskId`, `agentId`, `chainId`)
   * straight off the polled task (see {@link toolCallContextFromTask}). They
   * are forwarded to the backend as `X-Praesidia-*` request headers so the
   * capability-token gate can bind the call to the live task. The capability
   * token is treated as opaque and is NEVER logged.
   */
  async trackToolCall(call: ToolCallRecord): Promise<void> {
    if (!this.client || !this.orgId) {
      // Never emit the opaque capability token to logs.
      this.consoleLog('tool_call', this.redactToolCall(call));
      return;
    }

    const agentId = call.agentId ?? this.agentId;
    const chainId = call.chainId ?? this.client.getChainId();

    // AUDIT-SDK-02 — a tracked tool call is submitted as a TOOL_CALL task and
    // therefore needs a connection id like any other task. Best-effort: skip
    // (log locally) rather than 400 when none is resolvable.
    const connectionId = call.connectionId ?? this.connectionId;
    if (!connectionId) {
      this.consoleLog('tool_call', this.redactToolCall(call));
      return;
    }

    // Q4-02 — forward the task-binding fields as X-Praesidia-* headers. The
    // capability token rides only in the header, never in the JSON body or logs.
    const headers: Record<string, string> = {};
    if (call.capabilityToken)
      headers[CAPABILITY_TOKEN_HEADER] = call.capabilityToken;
    if (call.taskId) headers[TASK_ID_HEADER] = call.taskId;
    if (agentId) headers[AGENT_ID_HEADER] = agentId;
    if (chainId) headers[CHAIN_ID_HEADER] = chainId;

    // AUDIT-SDK-02 — DTO `input` must be a non-empty OBJECT; carry the tool
    // name + args (and the owning task id) inside it.
    const input: Record<string, unknown> = { tool: call.name };
    if (call.args !== undefined) input.args = call.args;
    if (call.taskId) input.parentTaskId = call.taskId;

    try {
      await this.client.post(
        `/organizations/${this.orgPathSegment}/tasks`,
        this.buildTaskBody(connectionId, 'TOOL_CALL', input, chainId),
        Object.keys(headers).length ? headers : undefined,
      );
    } catch {
      // tool-call tracking is always best-effort
    }
  }

  /**
   * Adopt a rotated credential in-process, at runtime (zero-downtime swap).
   *
   * The guard authenticates with a static key by default; call this to swap in
   * a freshly provisioned agent client secret without recreating the guard or
   * restarting the process, so long-running guarded calls keep working across a
   * credential swap.
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
    scope: 'INPUT' | 'OUTPUT',
  ): Promise<CheckResult> {
    // Local mode — no API key configured
    if (!this.client || !this.orgId) {
      return runLocalRules(content);
    }

    const agentId = opts.agentId ?? this.agentId;

    try {
      // POST /organizations/:orgId/guardrails/validate
      // ValidateContentDto: { content, agentId?, scope?, context? }
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
      }>(
        `/organizations/${this.orgPathSegment}/guardrails/validate`,
        { content, agentId, scope, context: opts.context },
        opts.chainId ? { [CHAIN_ID_HEADER]: opts.chainId } : undefined,
      );

      return {
        passed: result.passed,
        triggered: result.triggered ?? [],
        processingTimeMs: result.processingTimeMs,
        requestId: result.requestId,
        local: false,
      };
    } catch (err) {
      this.handleNetworkError<void>(err, 'guardrails/validate');
      return runLocalRules(content);
    }
  }

  /**
   * Handle a network/API error according to the fail-open / strict config.
   * Returns undefined when the error should be swallowed.
   * Throws when strict=true unless failOpen explicitly overrides it.
   */
  private handleNetworkError<T>(err: unknown, operation: string): T {
    if (this.failOpen) {
      return undefined as T;
    }
    if (this.strict) {
      throw err;
    }
    console.warn(
      `[praesidia/sdk] ${operation} failed (degrading gracefully):`,
      err,
    );
    return undefined as T;
  }

  /**
   * Q4-02 — strip the opaque capability token before a tool-call record is
   * ever written to a log line. The token is a bearer secret; it must never
   * appear in stdout even in local/offline mode.
   */
  private redactToolCall(
    call: ToolCallRecord,
  ): Omit<ToolCallRecord, 'capabilityToken'> {
    const { capabilityToken: _redacted, ...rest } = call;
    return rest;
  }

  /** Emit a structured log line for local/offline mode. */
  private consoleLog(type: string, data: unknown): void {
    const ts = new Date().toISOString();
    console.log(JSON.stringify({ timestamp: ts, praesidia: true, type, data }));
  }

  /** Convert a thrown value into a concise message for a failed task record. */
  private errorToString(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return this.stringify(error);
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
