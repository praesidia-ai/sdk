/**
 * Configuration for PraesidiaGuard.
 *
 * All fields fall back to environment variables when omitted:
 *   PRAESIDIA_API_KEY    — org-scoped API key (Authorization: Bearer)
 *   PRAESIDIA_ORG_ID     — organization UUID
 *   PRAESIDIA_AGENT_ID   — agent UUID (optional; scopes guardrail evaluation)
 *   PRAESIDIA_BASE_URL   — defaults to https://api.praesidia.ai
 */
/**
 * AUDIT-SDK-02 — task type accepted by `POST /organizations/:orgId/tasks`.
 * Mirrors the backend `AgentTaskType` enum
 * (src/agent-tasks/entities/agent-task.entity.ts).
 */
export type AgentTaskType = 'MESSAGE' | 'TOOL_CALL' | 'DELEGATION';

export interface GuardConfig {
  apiKey?: string;
  orgId?: string;
  agentId?: string;
  /** Bind managed HTTP checkpoints to an organization runtime installation. */
  runtimeInstallationId?: string;
  baseUrl?: string;
  /**
   * SDK-0339 — permit a plaintext `http:` baseUrl to a non-loopback host
   * (the API key then travels in cleartext). Loopback (`localhost`,
   * `127.0.0.0/8`, `[::1]`) never needs it. Defaults to
   * `PRAESIDIA_ALLOW_INSECURE_HTTP=1`, else false.
   */
  allowInsecureHttp?: boolean;
  /** Per-request HTTP deadline in milliseconds (default 30000, max 300000). */
  requestTimeoutMs?: number;
  /**
   * FINDING-4 — bounded retry policy for GET/DELETE (and idempotency-keyed
   * POST/PATCH) requests. Omit to use the default policy (3 attempts,
   * jittered exponential backoff, 15s total budget, honours `Retry-After`).
   * Pass `false` to disable retries entirely.
   */
  retry?: import('./retry.js').RetryConfig | false;
  /**
   * AUDIT-SDK-02 — Default connection id (UUID) that `run`/`logTask`/
   * `beginTask`/`trackToolCall` route submitted tasks through. The backend
   * `CreateAgentTaskDto.connectionId` is a REQUIRED UUID, so a task cannot be
   * submitted without one. Override per call via the matching `connectionId`
   * option. Read from `PRAESIDIA_CONNECTION_ID` when unset.
   */
  connectionId?: string;
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
  /**
   * SDK-0335 — what a guardrail check does when the control plane cannot be
   * reached (any error from `guardrails/validate`; also governs `logTask`):
   *   - `fail_closed` — rethrow the error.
   *   - `local_rules` — serve the bundled local rules, `console.warn`.
   *   - `fail_open`   — serve the bundled local rules silently.
   * Locally-served results carry `local: true, degraded: true`. When unset,
   * mapped from the legacy flags: `failOpen` → `fail_open`, else `strict` →
   * `fail_closed`, else `local_rules` (today's default).
   */
  failureMode?: GuardFailureMode;
  /**
   * SDK-0335 — bound on a degraded episode. Once the control plane has been
   * unreachable for longer than this many ms, `local_rules` / `fail_open`
   * escalate to `fail_closed` until one call succeeds. Unset = unbounded.
   */
  maxDegradedMs?: number;
  /**
   * SDK-0335 — called once at the start of each degraded episode (the first
   * failure after a success, or since construction). Wire it to alerting.
   * Exceptions it throws are swallowed.
   */
  onDegraded?: (info: DegradedInfo) => void;
}

/** SDK-0335 — behaviour when the Praesidia control plane is unreachable. */
export type GuardFailureMode = 'fail_closed' | 'local_rules' | 'fail_open';

/** SDK-0335 — payload for `GuardConfig.onDegraded`. */
export interface DegradedInfo {
  /** Operation whose failure opened the episode, e.g. `guardrails/validate`. */
  operation: string;
  /** Episode start, epoch milliseconds. */
  since: number;
  /** The configured (resolved) failure mode. */
  mode: GuardFailureMode;
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
  /**
   * AUDIT-SDK-02 — Connection id (UUID) to route the submitted task through.
   * Falls back to `config.connectionId`. Required (backend-side) to persist
   * the task — without a resolvable connectionId the audit submit is skipped
   * (or throws in strict mode) instead of silently 400ing.
   */
  connectionId?: string;
  /** AUDIT-SDK-02 — task type for the submit DTO. Defaults to `MESSAGE`. */
  type?: AgentTaskType;
  /**
   * Q3-02 — Chain-trace id to continue. When set (an id echoed from an inbound
   * `X-Praesidia-Chain-Id` header) the run is joined to this existing chain and
   * the id is forwarded on every subsequent outbound call. The SDK never mints
   * a chainId; it only propagates one it received.
   */
  chainId?: string;
}

/**
 * Options for standalone checkInput / checkOutput calls.
 */
export interface CheckOptions {
  agentId?: string;
  context?: Record<string, unknown>;
  /** Per-call chain id; avoids shared mutable trace state in concurrent runs. */
  chainId?: string;
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
  /** SDK-0335 — true when the control plane was unreachable and this result
   *  was served by local rules instead (always paired with `local: true`). */
  degraded?: boolean;
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
  /**
   * AUDIT-SDK-02 — Connection id (UUID) to route the submitted task through.
   * Falls back to `config.connectionId`. Required (backend-side) to persist.
   */
  connectionId?: string;
  /** AUDIT-SDK-02 — submit DTO task type. Defaults to `MESSAGE`. */
  type?: AgentTaskType;
  /** ISO-8601 timestamp. Defaults to now. */
  startedAt?: string;
  /** ISO-8601 timestamp. Defaults to now. */
  completedAt?: string;
  /** Task status. Defaults to "completed". */
  status?: 'pending' | 'running' | 'completed' | 'failed';
  /**
   * Q3-02 — Chain-trace id this task belongs to. Echo the id received on an
   * inbound `X-Praesidia-Chain-Id` header so the logged task stays joined to
   * the same multi-agent chain. Absent for a chain-root task (the server
   * mints a fresh chainId).
   */
  chainId?: string;
  /** SDK-0332 — parent task UUID: makes this a delegated sub-task (`CreateAgentTaskDto.parentTaskId`). */
  parentTaskId?: string;
  /**
   * SDK-0332 — delegation envelope, sent verbatim. Root task: stored as-is;
   * delegated task: intersected with the parent's, and any widening is denied (403).
   */
  delegationConstraints?: DelegationConstraints;
}

/** be BE-1596 `DelegationConstraints`: every axis optional; an absent axis does not narrow. */
export interface DelegationConstraints {
  /** ISO-8601, inclusive. */
  notAfter?: string;
  actions?: string[];
  resources?: { type: string; id: string }[];
  /** Tool-policy globs (`.` segments, `*`, `**`). */
  tools?: string[];
  models?: string[];
  environments?: AiSystemEnvironment[];
  maxDataClass?: 'pii' | 'phi' | 'financial' | 'secret' | 'public' | 'unclassified';
  /** Inclusive ceiling in minor units on the tool-call arg at `argPath` (e.g. `payment.amount`). */
  maxAmount?: { argPath: string; currency: string; maxMinor: number };
  maxDepth?: number;
  onExceed?: 'deny' | 'require_approval';
}

// ── A2A chain trace + JIT capability tokens (Q3-02 / Q4-02) ──────────────────

/**
 * Q4-02 — the four fields the SDK must carry to the backend when it executes
 * an MCP tool call on behalf of a claimed task. `capabilityToken` is an opaque
 * bearer JWT (never log it, never parse it); `taskId`/`agentId`/`chainId` bind
 * the call to the live task so the AGV-025 use-time gate can fail-closed verify
 * scope + expiry. Thread these straight from a polled task (see `PolledTaskRow`
 * / `toolCallContextFromTask`) into `trackToolCall`.
 */
export interface ToolCallContext {
  /** The task on whose behalf the tool is firing. */
  taskId?: string;
  /** The agent id executing the tool call. */
  agentId?: string;
  /**
   * Q3-02 — chain-trace id the tool call belongs to (echoed from the task's
   * `chainId`). Forwarded as `X-Praesidia-Chain-Id`.
   */
  chainId?: string | null;
  /**
   * Q4-02 — the short-lived JIT capability token minted for the task, scoped
   * to (org, agent, task, chain) and the task's declared toolset. Opaque
   * bearer secret — forwarded as `X-Praesidia-Capability-Token` and NEVER
   * logged. Absent when governance is off / no token was minted.
   */
  capabilityToken?: string;
}

/**
 * A tool-call record for tracking via guard.trackToolCall().
 *
 * The Q4-02 fields (`agentId`, `chainId`, `capabilityToken`) are forwarded to
 * the backend as `X-Praesidia-*` request headers so the capability-token gate
 * can bind the call to the live task. The capability token is opaque and is
 * never logged.
 */
export interface ToolCallRecord extends ToolCallContext {
  /** Name of the tool that was invoked. */
  name: string;
  /** Arguments passed to the tool. */
  args?: unknown;
  /**
   * AUDIT-SDK-02 — Connection id (UUID) to route the TOOL_CALL task through.
   * Falls back to `config.connectionId`. When unresolved the tool-call submit
   * is skipped (best-effort), never 400s.
   */
  connectionId?: string;
}

/**
 * Q3-02 / Q4-02 — a task row as returned on the A2A poll response. A polling
 * agent reads `chainId` + `hopIndex` (chain identity) and `capabilityToken`
 * (JIT token) off the claimed task, then forwards them on downstream A2A/MCP
 * hops. `capabilityToken` may be absent (governance off / token service
 * unavailable). Field names mirror the backend `AgentTaskPollerRow` wire shape.
 */
export interface PolledTaskRow {
  id: string;
  type?: string;
  input?: Record<string, unknown>;
  clientAgentId?: string;
  serverAgentId?: string;
  connectionId?: string;
  organizationId?: string;
  status?: string;
  createdAt?: string;
  /** Q3-02 — chain identity to echo on downstream hops. */
  chainId: string | null;
  /** Q3-02 — monotonic hop position within the chain. */
  hopIndex: number | null;
  /**
   * Q4-02 — opaque JIT capability token bound to this task. May be absent.
   * NEVER log this value.
   */
  capabilityToken?: string;
}

// ── Compliance report export (Q1-04) ─────────────────────────────────────────
// Programmatic export of the EU AI Act auditor/DPO compliance report.
// Endpoint base: /organizations/:orgId/compliance/eu-ai-act/reports

/** Lifecycle state of an async auditor-report generation job. */
export type AuditorReportGenerationStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

/** Result of enqueuing a report — POST .../reports. */
export interface ReportRequestResult {
  /** Report id — the poll + download key. */
  reportId: string;
  /** BullMQ job id once enqueued (diagnostics), null if not queued. */
  jobId: string | null;
  /** Initial generation state. */
  status: AuditorReportGenerationStatus;
}

/** Polling status of a report generation — GET .../reports/:reportId. */
export interface AuditorReportStatus {
  reportId: string;
  status: AuditorReportGenerationStatus;
  /** True once the PDF + JSON artifacts are downloadable. */
  ready: boolean;
  /** Rendered PDF size in bytes (null until completed). */
  pdfByteLength: number | null;
  /** Failure reason when status is `failed`. */
  error: string | null;
  /** ISO-8601 timestamp of the request. */
  requestedAt: string;
  /** ISO-8601 timestamp of completion (null while pending/processing). */
  completedAt: string | null;
}

/** Q2-05 extension slot — jurisdiction metadata. */
export interface JurisdictionMetadata {
  code: string;
  label: string;
  notes?: string | null;
}

/** Q5-04 extension slot — testing metadata. */
export interface TestedMetadata {
  tested: boolean;
  methodology?: string | null;
  lastTestedAt?: string | null;
}

export interface AuditorReportMetadata {
  title: string;
  standard: string;
  standardReference: string;
  generatedByUserId: string;
  jurisdiction: JurisdictionMetadata | null;
  tested: TestedMetadata | null;
}

export interface AuditorReportSummary {
  totalDiscovered: number;
  totalClassified: number;
  byRiskLevel: Record<string, number>;
  byComplianceStatus: Record<string, number>;
  articleStatusCounts: Record<string, number>;
  openGaps: number;
}

export interface DiscoveredInventoryItem {
  id: string;
  entityType: string;
  state: string;
  clientId: string | null;
  endpoint: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  sightingCount: number;
  observedSurfaces: string[];
}

export interface ClassifiedEntitySummary {
  id: string;
  entityType: string;
  entityId: string;
  entityName: string;
  riskLevel: string;
  riskCategory: string;
  complianceStatus: string;
  classificationSource: string;
  assessedAt: string;
}

/** One (entity × article) row in the per-entity EU AI Act compliance matrix. */
export interface ArticleMapping {
  article: string;
  status: string;
  evidenceType: string;
  evidenceRefs: string[];
  rationale: string;
  resolvedAt: string;
}

export interface EntityArticleMatrix {
  organizationId: string;
  entityType: string;
  entityId: string;
  entityName: string;
  riskLevel: string | null;
  articles: ArticleMapping[];
}

export interface MerkleAnchoring {
  available: boolean;
  rootCount: number;
  latestRootHash: string | null;
  latestRootPeriodEnd: string | null;
}

export interface TamperEvidence {
  merkleAnchoring: MerkleAnchoring;
  statement: string;
}

/** The full structured report — body of the JSON download (schemaVersion 'q1-04-v1'). */
export interface AuditorReportDocument {
  schemaVersion: string;
  reportId: string;
  organizationId: string;
  generatedAt: string;
  metadata: AuditorReportMetadata;
  summary: AuditorReportSummary;
  discoveredInventory: DiscoveredInventoryItem[];
  classifiedEntities: ClassifiedEntitySummary[];
  articleMatrix: EntityArticleMatrix[];
  tamperEvidence: TamperEvidence;
}

/** Options for waitForReport / generateAndWait polling. */
export interface ReportPollOptions {
  /** Give up after this many milliseconds. Defaults to 120000 (2 min). */
  timeoutMs?: number;
  /** Delay between status polls in milliseconds. Defaults to 2000. */
  pollIntervalMs?: number;
}

// ── Agent identity + task lifecycle (H1-02a) ─────────────────────────────────

/**
 * H1-02a — the identity an SDK instance operates as. `agentId` is the agent the
 * guard represents; `orgId` is the tenant. Both may be undefined in
 * local/offline mode (no connected client).
 */
export interface AgentIdentity {
  orgId?: string;
  agentId?: string;
  baseUrl: string;
  /** True when a connected, authenticated client is configured. */
  connected: boolean;
}

/** H1-02a — options to open a task-lifecycle handle via `guard.beginTask`. */
export interface BeginTaskOptions {
  /** Input prompt / message for this task. */
  input?: string;
  /** Override the agent id (falls back to config.agentId). */
  agentId?: string;
  /** Task type label surfaced in the audit log. */
  taskType?: string;
  /**
   * AUDIT-SDK-02 — Connection id (UUID) to route the submitted task through.
   * Falls back to `config.connectionId`. Required (backend-side) to persist.
   */
  connectionId?: string;
  /** AUDIT-SDK-02 — submit DTO task type. Defaults to `MESSAGE`. */
  type?: AgentTaskType;
  /** Arbitrary key/value context attached to the audit record. */
  context?: Record<string, unknown>;
  /** Q3-02 — chain-trace id this task belongs to (echoed from an inbound hop). */
  chainId?: string;
}

/** H1-02a — how a task-lifecycle handle is finalised. */
export interface CompleteTaskOptions {
  /** Token usage for cost tracking. */
  usage?: TaskRecord['usage'];
  /** Extra context to merge onto the record at completion. */
  context?: Record<string, unknown>;
}

/**
 * H1-02a — a live task-lifecycle handle returned by `guard.beginTask`. Captures
 * the start time locally and records EXACTLY ONE audit task row on `complete`
 * or `fail` (never two), so the lifecycle maps 1:1 to a single task.
 */
export interface TaskHandle {
  /**
   * Mark the task complete and record it. The first complete/fail call wins;
   * later calls return the same memoized promise without another write.
   */
  complete(
    output?: string,
    opts?: CompleteTaskOptions,
  ): Promise<string | undefined>;
  /** Mark the task failed; subject to the same first-finalization rule. */
  fail(error: unknown, opts?: CompleteTaskOptions): Promise<string | undefined>;
}

// ── Agent memory (H2-06e) ────────────────────────────────────────────────────
// Endpoint base: /organizations/:orgId/memories

/** Exact backend `MemorySourceType` enum values. */
export const MEMORY_SOURCE_TYPES = ['AGENT', 'USER', 'SYSTEM', 'IMPORT'] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

/** Exact backend `MemoryRetentionRegime` enum values. */
export const MEMORY_RETENTION_REGIMES = [
  'NONE',
  'GDPR',
  'HIPAA',
  'SOC2',
  'CUSTOM',
] as const;
export type MemoryRetentionRegime = (typeof MEMORY_RETENTION_REGIMES)[number];

/** H2-06e — write a memory (CreateMemoryDto). */
export interface CreateMemoryInput {
  /** Required for imported content; binds current source ACL and document version. */
  accessSourceId?: string;
  /** Content to store (scanned for PII + poisoning, encrypted per-org). */
  content: string;
  /** Opaque data-subject id — enables per-subject GDPR Art-17 crypto-shred. */
  subjectId?: string;
  /** Optional logical grouping key (namespace / conversation id). */
  memoryKey?: string;
  /** Free-form tags for retrieval filtering. */
  tags?: string[];
  /** Provenance: what kind of principal is writing this memory. */
  sourceType?: MemorySourceType;
  /** Provenance: the agent that produced this memory. */
  sourceAgentId?: string;
  /** Provenance: free-form origin reference (task id, url, tool call). */
  sourceReference?: string;
  /** Compliance retention regime governing this memory. */
  retentionRegime?: MemoryRetentionRegime;
  /** Custom retention window in days (only valid when regime=`CUSTOM`). */
  retentionDays?: number;
}

/** H2-06e — relevance search over memories (SearchMemoryDto). */
export interface SearchMemoryInput {
  /** Query text to match stored memories against. */
  query: string;
  /** Restrict search to a logical grouping key. */
  memoryKey?: string;
  /** Max number of results to return (1..50, default 10). */
  topK?: number;
}

/** H2-06e — org-scoped list query. */
export interface ListMemoriesQuery {
  page?: number;
  limit?: number;
  memoryKey?: string;
  sourceType?: MemorySourceType;
  tag?: string;
}

/**
 * H2-06d / BE-1565 — request a two-person GDPR Art-17 erasure of a data
 * subject's memories. Nothing is destroyed at request time.
 */
export interface EraseMemoryInput {
  /** The data-subject identifier the memories were written under. */
  subjectId: string;
  /** Reason for erasure (recorded on the erasure certificate). */
  reason: string;
  /**
   * Optional server-issued subject HMAC (lowercase 64-char hex, e.g. the
   * `subjectExternalIdHash` from a prior erasure receipt). Omit it and the
   * server derives it from `subjectId`; if supplied and it does not match,
   * the API answers 400 `subject_hash_mismatch`.
   */
  expectedSubjectHash?: string;
  /** Acknowledge that the subject may hold memberships in other organizations. */
  acknowledgeCrossOrg?: boolean;
}

/** H2-06c — provenance lineage attached to a retrieved memory. */
export interface MemoryProvenance {
  accessSourceId?: string | null;
  sourceContentVersion?: string | null;
  sourceType: MemorySourceType;
  sourceAgentId: string | null;
  authorUserId: string | null;
  sourceReference: string | null;
  writtenAt: string;
}

/** H2-06b — write-path guardrail outcome surfaced on read. */
export interface MemoryGuardrail {
  poisoningScore: number;
  piiRedacted: boolean;
}

/** H2-06 — retention state of a memory. */
export interface MemoryRetention {
  regime: MemoryRetentionRegime;
  expiresAt: string | null;
}

/** H2-06 — a single memory as returned by the API. */
export interface MemoryRecord {
  id: string;
  organizationId: string;
  /** Decrypted (PII-redacted) content, or "[erased]" after a crypto-shred. */
  content: string;
  memoryKey: string | null;
  tags: string[] | null;
  provenance: MemoryProvenance;
  guardrail: MemoryGuardrail;
  retention: MemoryRetention;
  erasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * BE-1565 — the 202 `ApprovalRequest` returned by `POST .../memories/erase`.
 * A PENDING `DATA_SUBJECT_ERASE` ticket: the crypto-shred and the erasure
 * certificate happen only when a different system admin confirms it.
 */
export interface EraseMemoryResult {
  id: string;
  organizationId: string;
  requesterId: string;
  approverId?: string;
  operationType: 'DATA_SUBJECT_ERASE';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  description: string;
  operationDetails?: Record<string, unknown>;
  decidedAt?: string;
  consumedAt?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

// ── OTLP/HTTP GenAI telemetry emit (H1-02 / H1-02e) ──────────────────────────
// POST /telemetry/otlp/v1/traces — org-key auth. Body is an OTLP/HTTP
// ExportTraceServiceRequest: { resourceSpans: [...] }.

/** Server-side cap on resourceSpans[] per request (mirrors OTLP_LIMITS). */
export const OTLP_MAX_RESOURCE_SPANS = 100;

/** Server-side raw body cap in bytes (global 2 MB limit). */
export const OTLP_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** An OTLP AnyValue (only the variants the GenAI convention uses). */
export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: number | string;
  boolValue?: boolean;
  doubleValue?: number;
}

/** An OTLP KeyValue attribute. */
export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** An OTLP Span (OTLP/HTTP JSON shape). */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  flags?: number;
  name: string;
  /** SPAN_KIND_* — 3 (CLIENT) for a GenAI inference call. */
  kind?: number;
  /** Unix nanoseconds as a decimal string. */
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpKeyValue[];
  status?: { code?: number; message?: string };
}

/** OTLP InstrumentationScope + its spans. */
export interface OtlpScopeSpans {
  schemaUrl?: string;
  scope?: { name?: string; version?: string };
  spans: OtlpSpan[];
}

/** OTLP Resource (its attributes carry service.name etc.). */
export interface OtlpResource {
  attributes?: OtlpKeyValue[];
}

/** One OTLP ResourceSpans entry. */
export interface OtlpResourceSpans {
  resource?: OtlpResource;
  scopeSpans: OtlpScopeSpans[];
}

/** The OTLP/HTTP ExportTraceServiceRequest body. */
export interface OtlpExportTraceServiceRequest {
  resourceSpans: OtlpResourceSpans[];
}

/** Ack returned by the ingest endpoint (HTTP 202). */
export interface OtlpIngestAck {
  accepted: boolean;
  /** Number of resourceSpans buffered for async processing. */
  buffered: number;
}

/**
 * H1-02 — the minimal inputs to synthesize ONE GenAI-convention span via
 * {@link genAiSpan}. Field names map to OpenTelemetry `gen_ai.*` attributes so
 * the backend's `otlp-genai.util.ts` parser materialises an OBSERVED agent.
 */
export interface GenAiSpanInput {
  /** gen_ai.agent.name — the observed agent's display name. */
  agentName: string;
  /** gen_ai.agent.id — stable agent id (optional). */
  agentId?: string;
  /** Legacy provider alias; emits both gen_ai.provider.name and gen_ai.system (e.g. 'openai', 'anthropic'). */
  system?: string;
  /** gen_ai.request.model — requested model. */
  requestModel?: string;
  /** gen_ai.response.model — actual model that answered. */
  responseModel?: string;
  /** gen_ai.operation.name — e.g. 'chat', 'text_completion'. */
  operationName?: string;
  /** gen_ai.usage.input_tokens. */
  inputTokens?: number;
  /** gen_ai.usage.output_tokens. */
  outputTokens?: number;
  /** Span name (defaults to `${operationName} ${requestModel}`). */
  name?: string;
  /** Duration in milliseconds (defaults to 0 → start == end). */
  durationMs?: number;
  /** W3C traceparent. Invalid headers are ignored and start a new trace. */
  traceparent?: string;
  /** Correlation only; these identifiers do not grant authority. */
  taskId?: string;
  actionId?: string;
  /** Content attributes are dropped unless explicitly enabled with a redactor. */
  captureContent?: boolean;
  /** Called on every sensitive content string before export; errors fail closed. */
  redactContent?: (value: string) => string;
  /** Extra OTLP attributes. Reserved identity keys cannot be overridden. */
  extraAttributes?: OtlpKeyValue[];
}

// ── Trust passport verify client (H3-02f) ────────────────────────────────────
// Public routes: GET /trust/passport/:agentId[/verify]

/** H3-02b — coarse posture status inside a passport credential subject. */
export interface TrustPassportPosture {
  status: string;
  expiresAt: string | null;
}

/** H3-02b — red-team summary inside a passport credential subject. */
export interface TrustPassportRedTeam {
  completedRuns: number;
  lastTestedAt: string | null;
}

/** H3-02b — attestation summary inside a passport credential subject. */
export interface TrustPassportAttestations {
  activeCount: number;
  identityVerified: boolean;
  guardrailsActive: boolean;
  auditTrailEnabled: boolean;
  spendCapConfigured: boolean;
}

/** H3-02b — the signed credential subject of a trust passport. */
export interface TrustPassportCredentialSubject {
  id: string;
  agentName: string;
  trustLevel: string;
  trustScore: number;
  posture: TrustPassportPosture;
  redTeam: TrustPassportRedTeam;
  attestations: TrustPassportAttestations;
  compliance: string[];
}

/**
 * H3-02b — the detached tenant-key proof. `proofValue` is STANDARD base64 of
 * either a 64-byte Ed25519 signature or a canonical DER ECDSA-P256 signature
 * over the canonical JSON of the passport WITHOUT its `proof` member.
 */
export interface TrustPassportProof {
  type: string;
  created: string;
  proofPurpose: string;
  verificationMethod: string;
  keyVersion: number;
  proofValue: string;
  /**
   * SDK-0363 / ADR-0004. Absent or 1 = legacy: the signature is over the
   * canonical JSON. 2 = the signature is over
   * `"praesidia:trust-passport:v2\n" || canonical JSON`. Any other value
   * (including `null` or `"2"`) is `malformed-passport`.
   */
  signatureFormat?: 1 | 2;
}

/** H3-02b — the signed, verifiable trust passport (W3C VC shape). */
export interface TrustPassport {
  '@context': string[];
  type: string[];
  id: string;
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: TrustPassportCredentialSubject;
  proof: TrustPassportProof;
}

/** H3-02f — the verification bundle returned by the `/verify` endpoint. */
export interface TrustPassportVerifyBundle {
  passport: TrustPassport;
  /** Public key JWK (OKP/Ed25519 or EC/P-256) for offline verification. */
  publicKeyJwk: Record<string, unknown>;
  /** URL to the agent DID document for key resolution. */
  didDocumentUrl: string;
  verificationHint?: string;
  embed?: Record<string, unknown>;
}

// ── AI System trust passport (BE-0540) ───────────────────────────────────────
// Public routes: GET /trust/passport/ai-systems/:aiSystemId[/verify|/badge.svg]
// Typed from be's `dto/ai-system-trust-passport.dto.ts`.

/**
 * BE-0540 — one aggregate section of an AI System passport. A section with no
 * real data source yet is `{ available: false, reason }` (never a fabricated
 * count); `counts` is omitted when `available` is false.
 */
export interface AiSystemTrustPassportSection {
  available: boolean;
  /** Present only when `available` is false (names the gap, e.g. `AISYS-0031`). */
  reason?: string;
  counts?: Record<string, number>;
  /** ISO-8601 timestamp of the most recent contributing row. */
  updatedAt?: string | null;
}

/** BE-0540 — the AIBOM section also carries the latest snapshot's digest. */
export interface AiSystemTrustPassportAibomSection
  extends AiSystemTrustPassportSection {
  /** SHA-256 digest of the latest AIBOM snapshot document. */
  digest?: string;
  version?: number;
}

/** BE-0540 — the signed credential subject of an AI System passport. */
export interface AiSystemTrustPassportCredentialSubject {
  /** AI System DID (did:web). */
  id: string;
  aiSystemName: string;
  posture: AiSystemTrustPassportSection;
  redTeam: AiSystemTrustPassportSection;
  attestations: TrustPassportAttestations;
  /** Compliance frameworks applicable to the org (org-wide). */
  frameworks: string[];
  regulatoryClassification: AiSystemTrustPassportSection;
  aibom: AiSystemTrustPassportAibomSection;
  dataCategories: AiSystemTrustPassportSection;
  incidents: AiSystemTrustPassportSection;
  models: AiSystemTrustPassportSection;
  permissions: AiSystemTrustPassportSection;
  evidenceRoot: AiSystemTrustPassportSection;
}

/**
 * BE-0540 — the signed AI System trust passport (W3C VC shape,
 * `type: ['VerifiableCredential', 'AiSystemTrustPassport']`), aggregated over
 * the system's member assets. Same proof envelope as the agent passport.
 */
export interface AiSystemTrustPassport {
  '@context': string[];
  type: string[];
  id: string;
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: AiSystemTrustPassportCredentialSubject;
  proof: TrustPassportProof;
}

/** BE-0540 — ready-to-paste badge embed snippets. */
export interface AiSystemTrustPassportEmbed {
  badgeUrl: string;
  verifyUrl: string;
  html: string;
  markdown: string;
}

/** BE-0540 — the bundle returned by `/trust/passport/ai-systems/:id/verify`. */
export interface AiSystemTrustPassportVerifyBundle {
  passport: AiSystemTrustPassport;
  /** Public key JWK (OKP/Ed25519 or EC/P-256) served by the SAME public route. */
  publicKeyJwk: Record<string, unknown>;
  verificationHint: string;
  embed: AiSystemTrustPassportEmbed;
}

/**
 * H3-02f — reasons a local passport verification can fail.
 *
 * The three snake_case members are TRUST-ANCHOR outcomes introduced by
 * SEC-2026-09-12 MCPSDK-04; they describe the provenance of the verification
 * key, not the cryptography. The kebab-case members are the pre-existing
 * envelope/signature/expiry outcomes.
 */
export type TrustVerificationReason =
  | 'ok'
  | 'missing-proof'
  | 'malformed-public-key'
  | 'signature-mismatch'
  | 'malformed-passport'
  | 'invalid-expiration'
  | 'expired'
  /** No trust anchor was supplied, so the key came from the same response. */
  | 'unpinned_key'
  /** An anchor was supplied and the passport verifies under none of its keys. */
  | 'untrusted_key'
  /** `expectedFingerprint` does not match the JWK the server returned. */
  | 'fingerprint_mismatch'
  /** Validly signed, but `credentialSubject.id` is not the requested subject. */
  | 'subject_mismatch';

/**
 * A public key JWK usable as a trust anchor (OKP/Ed25519 or EC/P-256).
 * Deliberately a `Record` rather than the DOM/Node `JsonWebKey` interface so it
 * stays assignable to the `Record<string, unknown>` JWK parameter the rest of
 * this surface uses.
 */
export type TrustAnchorJwk = Record<string, unknown>;

/**
 * SEC-2026-09-12 MCPSDK-04 — caller-supplied trust anchor for
 * `PraesidiaTrust.fetchAndVerify`. Without one, the passport and the key that
 * "verifies" it both come from the same unauthenticated GET, so the result is
 * self-referential and `verified` is forced to `false`.
 */
export interface TrustFetchAndVerifyOptions {
  /**
   * Out-of-band public key JWK(s) to verify against — an array, or a map
   * (keyed however the caller likes, e.g. by `kid` or issuer DID) whose values
   * are the anchors. The passport must verify under one of them. Mirrors the
   * caller-supplied target key of `verifyProtectedHttpResult`.
   */
  trustedKeys?: TrustAnchorJwk[] | Record<string, TrustAnchorJwk>;
  /**
   * RFC 7638 JWK thumbprint (SHA-256) the server-returned key must match,
   * base64url (canonical) or hex, with an optional `sha256:` prefix. Use this
   * when you can obtain the fingerprint over a second channel but not the key.
   */
  expectedFingerprint?: string;
}

/** H3-02f — the outcome of `PraesidiaTrust.verifyPassport`. */
export interface TrustVerificationResult {
  /**
   * True iff the signature verified under a TRUSTED key AND the passport is
   * fresh. From `fetchAndVerify` this can only be true when the caller supplied
   * a trust anchor (MCPSDK-04).
   */
  verified: boolean;
  /** True iff the signature is valid under the key actually used (ignores expiry). */
  signatureValid: boolean;
  /** True iff `expirationDate` is in the past. */
  expired: boolean;
  /** Machine-readable reason. */
  reason: TrustVerificationReason;
}

/** H3-02f — result of `PraesidiaTrust.fetchAndVerify`. */
export interface TrustFetchAndVerifyResult extends TrustVerificationResult {
  passport: TrustPassport;
  publicKeyJwk: Record<string, unknown>;
  didDocumentUrl: string;
}

/** SDK-0309 — result of `PraesidiaTrust.fetchAndVerifyAiSystem`. */
export interface AiSystemTrustFetchAndVerifyResult
  extends TrustVerificationResult {
  passport: AiSystemTrustPassport;
  publicKeyJwk: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// FINDING-2 — parity types for the four resource groups the Python SDK had
// and the TS SDK was missing: agent CRUD, workflows, connections, audit.
// Response bodies are intentionally loosely typed (`Record<string, unknown>`
// passthrough for payloads, minimal shape for list/pagination) because the
// backend DTOs for these resources are broad and still evolving; the SDK's
// job here is transport + validation of caller-controlled inputs, not a full
// mirrored response schema (matching the Python SDK's plain-dict approach).
// ---------------------------------------------------------------------------

/** Query params accepted by `PraesidiaAgents.list`. */
export interface ListAgentsQuery {
  page?: number;
  limit?: number;
  name?: string;
  search?: string;
  role?: 'CLIENT' | 'SERVER';
  status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'QUARANTINED' | 'REVOKED';
  type?: string;
  visibility?: 'PRIVATE' | 'TEAM' | 'ORGANIZATION' | 'PUBLIC';
  tier?: 'MANAGED' | 'OBSERVED';
  scope?: 'own' | 'organization';
  capability?: string;
  capabilityExact?: string;
  skillTag?: string;
  inputMode?: string;
  outputMode?: string;
}

/** An agent record as returned by the API (passthrough shape). */
export type AgentRecord = Record<string, unknown>;

/**
 * Response of `PraesidiaAgents.create` — be's `AgentCreateResponseDto`
 * (SDK-2797). The created agent is nested under `agent`; the three sibling
 * fields are returned on create only.
 */
export interface AgentCreateResult {
  /** The created agent (be `AgentListItemDto`). */
  agent: AgentRecord & { id: string; clientId: string };
  /** Always `null` now: be issues no static client secret (credentials are JIT). */
  clientSecret: string | null;
  /** Always `'jit'` now; `'static'` stays in be's response schema for legacy agents. */
  credentialMode: 'jit' | 'static';
  /** Per-agent webhook signing secret, returned ONCE. Persist it; never log it. */
  webhookSigningSecret: string;
}

/** Query params accepted by `PraesidiaWorkflows.list`. */
export interface ListWorkflowsQuery {
  page?: number;
  limit?: number;
  /** Optional backend-supported workflow status filter. */
  status?: WorkflowStatus;
}

export const WORKFLOW_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** Query params accepted by `PraesidiaWorkflows.listRuns`. */
export interface ListWorkflowRunsQuery {
  page?: number;
  limit?: number;
}

export type WorkflowRecord = Record<string, unknown>;
export type WorkflowRunRecord = Record<string, unknown>;

/** Options accepted by `PraesidiaWorkflows.trigger`. */
export interface TriggerWorkflowOptions {
  /** Optional run-level input payload. */
  input?: Record<string, unknown>;
  /** Optional non-negative auto-pause threshold in USD. */
  budgetLimitUsd?: number;
}

/** Query params accepted by `PraesidiaConnections.list`. */
export interface ListConnectionsQuery {
  page?: number;
  limit?: number;
  clientAgentId?: string;
  serverAgentId?: string;
  mcpServerId?: string;
  status?: ConnectionStatus;
  search?: string;
}

export type ConnectionRecord = Record<string, unknown>;

/**
 * Connection status values accepted by `PraesidiaConnections.updateStatus`
 * (mirrors the Python SDK's `ConnectionsResource.STATUSES`).
 */
export const CONNECTION_STATUSES = [
  'ACTIVE',
  'IDLE',
  'ERROR',
  'PENDING',
  'DISCONNECTED',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Query params accepted by `PraesidiaAudit.list` / `.stream`. */
export interface ListAuditLogsQuery {
  /** Free-text search accepted by the backend audit query. */
  search?: string;
  /** ISO 8601 start date/time. */
  fromDate?: string;
  /** ISO 8601 end date/time. */
  toDate?: string;
  /** 1-based page number (default 1). */
  page?: number;
  /** Max results per page (default 50; list requests are validated at 100). */
  limit?: number;
  /**
   * Filter by action type (e.g. `"agent.created"`). BUGHUNT-SDK-03 (Python
   * parity) — there is deliberately NO `resourceType` filter: the backend
   * `FilterAuditDto` whitelists `search`/`action`/`startDate`/`endDate`
   * under `forbidNonWhitelisted`, so a `resourceType` param 400s the whole
   * request. `resourceType` is derived from the `action` prefix at read
   * time, not a stored column — filter by `action` instead.
   */
  action?: string;
}

export type AuditLogEntry = Record<string, unknown>;

/** Section of a Decision Receipt that may be unavailable on older rows. */
interface ReceiptAvailability {
  available: boolean;
  reason?: string;
}

/**
 * be `DecisionReceiptResponseDto` — the Decision Record for one
 * `POLICY_DECISION`/`POLICY_VIOLATION` audit row (SDK-0326).
 */
export interface DecisionReceipt {
  rowId: string;
  decisionId: string;
  action: string;
  agent: { id?: string | null; actorType: 'agent' | 'user' | 'system' };
  identity: { userId?: string | null; teamId?: string | null };
  delegatedAuthority?: { connectionId?: string | null } | null;
  arguments: Record<string, unknown> | null;
  authorizationResult: {
    decision: 'ALLOW' | 'DENY' | 'STEP_UP' | 'OBSERVED';
    reasonCode: string;
    enforcementMode: 'off' | 'observe' | 'enforce';
    policyId?: string | null;
    ruleId?: string | null;
  };
  policyVersion?: string | null;
  policyFingerprint?: string | null;
  humanApproval: ReceiptAvailability & {
    approvalId?: string | null;
    status?: string | null;
    approverId?: string | null;
  };
  guardrailResults: ReceiptAvailability & {
    results?: Array<{
      guardrailId: string;
      guardrailName: string;
      category: string;
      severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      action: string;
      reason: string;
    }>;
  };
  model: ReceiptAvailability & { model?: string | null };
  tool?: { name?: string | null; interactionType?: string | null } | null;
  timestamp: string;
  evidenceHash?: string | null;
  signature: {
    algorithm?: string | null;
    keyVersion?: number | null;
    signedAt?: string | null;
    valid: boolean;
    reason: string;
    chainOk: boolean;
  };
  externalAnchor: {
    status: 'verified_rekor' | 'verified_s3' | 'unverified' | 'failed';
    anchoredAt?: string;
    reason?: string;
  };
  aiSystemId?: string | null;
  assetId?: string | null;
}

/** be `CreateAuditPackageDto`. Omitted `to` = now; omitted `from` = 90 days before `to`. */
export interface RequestAuditPackageOptions {
  from?: string;
  to?: string;
  aiSystemId?: string;
}

export type AuditPackageStatus = 'queued' | 'running' | 'done' | 'failed';

/** be `AuditPackageJobDto` — body of `POST audit/packages` (202) and `GET audit/packages/:id`. */
export interface AuditPackageJob {
  id: string;
  status: AuditPackageStatus;
  /** Set exactly when `status` is `failed`. */
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** `X-Praesidia-Window-Clamp` on the audit bundle response. */
export type AuditBundleWindowClamp =
  | 'none'
  | 'clamped_to_last_rooted_hour'
  | 'clamped_to_unrooted_gap'
  | 'no_rooted_hour'
  | 'include_unrooted';

export interface AuditBundleQuery {
  from: string;
  to: string;
  /** Keep rows after the last Merkle-rooted hour; such a bundle fails offline verification until rooted. */
  includeUnrooted?: boolean;
}

/** Signed audit bundle bytes plus the window headers (null when the server omits them). */
export interface AuditBundleDownload {
  bytes: Uint8Array;
  /** `X-Praesidia-Requested-To`. */
  requestedTo: string | null;
  /** `X-Praesidia-Effective-To` — where the bundle is actually cut. */
  effectiveTo: string | null;
  /** `X-Praesidia-Window-Clamp`. */
  windowClamp: AuditBundleWindowClamp | null;
}

/** Query params accepted by `PraesidiaAnalytics.usage` / advanced endpoints. */
export interface AnalyticsWindowQuery {
  /** Rolling window in days (1..365, default 30). */
  days?: number;
  fromDate?: string;
  toDate?: string;
}

export type AnalyticsResult = Record<string, unknown>;

// ── AUD-0063 — analytics coverage parity types ────────────────────────────────
// be/src/analytics/analytics.controller.ts. The 5 routes above (usage/costTrends/
// agentPerformance/topAgents/export) predate this ticket and keep the existing
// `AnalyticsResult` escape hatch untouched; every route added for AUD-0063 gets a
// real response type instead.

/** GET .../analytics/capture-state response. */
export interface AnalyticsCaptureState {
  enabled: boolean;
  piiCapture: boolean;
  sampleRate: number;
  retentionDays: number;
}

/** GET .../analytics/agents/:agentId response. */
export interface AgentAnalyticsResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  errorRate: number;
  responseTimePercentiles: { p50: number; p95: number; p99: number };
  throughput: number;
  requestsByDay: { date: string; count: number }[];
  requestsByEndpoint: { endpoint: string; count: number }[];
  recentErrors: { errorCode: string; message: string; count: number }[];
}

/** `AnalyticsEvent.eventType` — mirrors be's `AnalyticsEventType` enum. */
export type AnalyticsEventType =
  | 'REQUEST'
  | 'RESPONSE'
  | 'ERROR'
  | 'TOKEN_ISSUED'
  | 'GUARDRAIL_TRIGGERED';

/** A row as returned by GET .../analytics/events, .../activity-log, and POST .../analytics/events. */
export interface AnalyticsEvent {
  id: string;
  organizationId: string | null;
  agentId?: string;
  eventType: AnalyticsEventType;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  responseTimeMs?: number;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
  errorCode?: string;
  errorMessage?: string;
  sourceIp?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** Query params accepted by `PraesidiaAnalytics.events` / `.activityLog`. */
export interface AnalyticsEventsQuery {
  agentId?: string;
  eventType?: AnalyticsEventType;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

/** Body accepted by `PraesidiaAnalytics.recordEvent` — POST .../analytics/events. */
export interface RecordAnalyticsEventInput {
  eventType: AnalyticsEventType;
  agentId?: string;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  responseTimeMs?: number;
  errorCode?: string;
  errorMessage?: string;
  /** Bounded server-side to 4096 bytes serialized / 5 levels deep (AUDIT-021). */
  metadata?: Record<string, unknown>;
}

/** GET .../analytics/advanced/anomalies response entry. */
export interface AnalyticsAnomaly {
  type: string;
  entityId: string;
  entityName: string;
  metric: string;
  value: number;
  threshold: number;
  detectedAt: string;
}

/** GET .../analytics/advanced/cost-by-team response entry. */
export interface CostByTeamEntry {
  teamId: string | null;
  teamName: string;
  totalCostUsd: number;
  taskCount: number;
}

/** GET .../analytics/advanced/model-comparison response entry. */
export interface ModelComparisonEntry {
  model: string;
  taskCount: number;
  successRate: number;
  avgCostUsd: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  totalCostUsd: number;
}

/** Shared `timeRange` echo on the richer advanced-analytics responses below. */
export interface AnalyticsTimeRange {
  startDate: string;
  endDate: string;
  days: number;
}

/** GET .../analytics/advanced/security response. */
export interface SecurityMetricsResult {
  failedAuthAttempts: number;
  failedAuthByDay: { date: string; count: number }[];
  suspiciousActivities: {
    type: string;
    description: string;
    count: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
    lastOccurred: string;
  }[];
  rateLimitedRequests: number;
  tokenRevocations: number;
  permissionDenials: number;
  securityEvents: {
    type:
      | 'failed_auth'
      | 'suspicious_activity'
      | 'rate_limited'
      | 'permission_denied'
      | 'token_revoked';
    count: number;
    trend: 'up' | 'down' | 'stable';
    trendPercentage: number;
  }[];
  topBlockedIps: { ip: string; count: number; reason: string }[];
  riskScore: number;
  timeRange: AnalyticsTimeRange;
}

/** GET .../analytics/advanced/usage-heatmap response. */
export interface UsageHeatmapResult {
  heatmap: { hour: number; dayOfWeek: number; value: number; normalized: number }[];
  peakHour: number;
  peakDay: number;
  quietHour: number;
  quietDay: number;
  totalActivity: number;
  averageHourlyActivity: number;
  timeRange: AnalyticsTimeRange;
}

/** GET .../analytics/advanced/compliance response. */
export interface ComplianceMetricsResult {
  overallScore: number;
  policyViolations: {
    policyId: string;
    policyName: string;
    violationType: string;
    count: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
    lastOccurred: string;
    affectedAgents: string[];
  }[];
  totalViolations: number;
  violationsByDay: { date: string; count: number }[];
  guardrailTriggers: {
    guardrailId: string;
    guardrailName: string;
    triggerCount: number;
    blockCount: number;
    allowedCount: number;
  }[];
  accessReviews: {
    total: number;
    pending: number;
    approved: number;
    revoked: number;
    overdue: number;
  };
  dataRetention: {
    retentionDays: number;
    oldestRecord: string;
    recordsToExpire: number;
  };
  auditLogStats: {
    totalEvents: number;
    eventsByType: { type: string; count: number }[];
    recentCriticalEvents: { type: string; description: string; timestamp: string }[];
  };
  timeRange: AnalyticsTimeRange;
}

// ── PA01 DX-001 — protectAction (managed MCP Proof Edge) ─────────────────────
// Endpoint: POST /organizations/:orgId/mcp-servers/:mcpServerId/tools/:toolName/call

/**
 * PA01 scope correction (`.claude/backlog/PA-0013.md`) — the ONLY supported
 * `protectAction` destination in this SDK version: the managed MCP path
 * (`be`'s Proof Edge, `mcp-client.service.ts`). D8: grade C at best
 * (Praesidia-managed observation, never independent target proof). A
 * customer-controlled Proof Edge for arbitrary destinations is EDGE-003 —
 * explicitly out of PA01 scope (D11) — future protocols land here as a
 * discriminated union member, never as a silent fallback.
 */
export interface McpProtectedActionTarget {
  protocol: 'mcp';
  /** The managed MCP server connection id (`:id` in the route above). */
  mcpServerId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

/**
 * Closed union of supported `protectAction` destinations. Only `'mcp'` exists
 * today — passing any other `protocol` throws
 * `UnsupportedProtectedActionTargetError` rather than silently degrading to
 * `trackToolCall`-style best-effort telemetry. That silent-downgrade failure
 * mode is the precise thing PA-0013 exists to prevent.
 */
export type ProtectActionTarget = McpProtectedActionTarget;

export interface ProtectActionOptions {
  target: ProtectActionTarget;
  /** Per-call timeout in milliseconds (1000–300000; `be` enforces the range). */
  timeoutMs?: number;
  /** Override the agent id (falls back to `config.agentId`). Forwarded as `X-Praesidia-Agent-Id`. */
  agentId?: string;
  /** Owning task id. Forwarded as `X-Praesidia-Task-Id` (Q4-02 pattern). */
  taskId?: string;
  /** Chain-trace id. Forwarded as `X-Praesidia-Chain-Id`; falls back to the client's propagated chain id. */
  chainId?: string;
  /** Opaque JIT capability token (Q4-02). Forwarded as `X-Praesidia-Capability-Token` — a DIFFERENT header/verify path from the Permit below (D3). */
  capabilityToken?: string;
  /**
   * D3 — a previously-issued Permit token, forwarded as `X-Praesidia-Permit`
   * (never `X-Praesidia-Capability-Token`). PA01 has no HTTP permit-issuance
   * endpoint yet — `PermitService.mint` is in-process only in `be`
   * (`.claude/tickets/PA01-CONTRACT-sdk-action-response.md`) — so this field
   * is forward-compatible plumbing for when one ships. Omit it today.
   */
  permit?: string;
}

/** Passthrough content item — mirrors `be`'s `McpContent` union loosely (`type: 'text' | 'image' | 'resource'`, plus type-specific fields). */
export type ProtectedActionContent = Record<string, unknown>;

/**
 * PA-0026 — machine-readable pre-dispatch denial reason, mirroring `be`'s
 * `ActionDenyReason` (`tool-result.dto.ts`) 1:1. Present ONLY on
 * `ToolResultDto.actionDenyReason` when the call was denied BEFORE dispatch —
 * this is the field `protectAction` keys its throw decision on (see
 * {@link ProtectActionResult}, `guard.ts`'s `protectAction`). A coarse,
 * frozen grouping over the Proof Edge's ~15 internal `PermitVerifyReason`
 * values: `expired` and `commitment_mismatch` keep their own named buckets,
 * everything else (token missing/malformed, wrong audience/issuer/org/
 * actor/task/chain/target/action-class, signature invalid, key unavailable)
 * collapses to `PERMIT_INVALID` — none of those finer reasons is
 * individually actionable by a caller differently than "get a fresh Permit
 * and retry." `POLICY_DENIED` covers the pre-existing AGV-020/AGV-025
 * policy gates that run before the Proof Edge block ever executes.
 */
export type ActionDenyReason =
  | 'PERMIT_MISSING'
  | 'PERMIT_INVALID'
  | 'PERMIT_EXPIRED'
  | 'PERMIT_MISMATCH'
  | 'PERMIT_REPLAYED'
  | 'POLICY_DENIED';

export interface ProtectActionResult {
  success: boolean;
  content: ProtectedActionContent[];
  isError?: boolean;
  latencyMs: number;
  /**
   * The protected-action id (UUIDv7), present whenever the Proof Edge ran
   * for this call (`Feature.PROOF_ACTIONS` on for the org). Absent when the
   * feature is off for the org (today's platform default) or the call was
   * denied before the Proof Edge block ran (AGV-020/AGV-025 policy gates) —
   * absence is not itself a failure signal.
   */
  actionId?: string;
  /**
   * D7 closure classification, or the D6 open-phase name
   * (`'AWAITING_OUTCOME'`) when the action has not reached a terminal
   * closure yet — a successful dispatch never carries a terminal closure
   * here; `GET /organizations/:orgId/protected-actions/:actionId` is the
   * durable source of truth once reconciliation resolves it.
   */
  closure?: string;
  /**
   * D8 evidence grade hint ('A'|'B'|'C'|'D') — unsigned, synchronous,
   * non-authoritative. The managed MCP Proof Edge is grade C at best (never
   * A/B); the durable grade is always verifier-derived from the signed
   * manifest, never this field. `undefined` when the Proof Edge block did
   * not run for this call.
   */
  evidenceGrade?: 'A' | 'B' | 'C' | 'D';
}

/** Current, connector-owned authorization state for one imported document. */
export interface MemorySourceAuthorizationInput {
  sourceReference: string;
  contentVersion: string;
  allowedUserIds: string[];
  authorityUrl: string;
  authorityPublicKey: string;
  validUntil: string;
  state: 'active' | 'revoked' | 'deleted';
  expectedRevision: number;
}
export interface MemorySourceAuthorization extends Omit<MemorySourceAuthorizationInput, 'expectedRevision' | 'authorityUrl' | 'authorityPublicKey'> {
  id: string;
  organizationId: string;
  ownerUserId: string;
  revision: number;
  authorityUrl: string | null;
  authorityPublicKey: string | null;
}

// ── AI Systems / Assets / Relationships (SDK-0001 — parity with be's
// AISYS-0002; see ui/swagger.json + CONTRACT.md, entity-derived enums) ──────

/** `entities/ai-system.entity.ts`'s `AI_SYSTEM_OWNER_TYPES`. */
export const AI_SYSTEM_OWNER_TYPES = ['user', 'team'] as const;
export type AiSystemOwnerType = (typeof AI_SYSTEM_OWNER_TYPES)[number];

/** `entities/ai-system.entity.ts`'s `AI_SYSTEM_CRITICALITIES`. */
export const AI_SYSTEM_CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AiSystemCriticality = (typeof AI_SYSTEM_CRITICALITIES)[number];

/** `entities/ai-system.entity.ts`'s `AI_SYSTEM_ENVIRONMENTS`. */
export const AI_SYSTEM_ENVIRONMENTS = ['development', 'staging', 'production', 'sandbox'] as const;
export type AiSystemEnvironment = (typeof AI_SYSTEM_ENVIRONMENTS)[number];

/** `entities/ai-system.entity.ts`'s `AI_SYSTEM_LIFECYCLE_STATUSES`. */
export const AI_SYSTEM_LIFECYCLE_STATUSES = [
  'proposed', 'assessment', 'approved', 'development', 'production', 'suspended', 'retired',
] as const;
export type AiSystemLifecycleStatus = (typeof AI_SYSTEM_LIFECYCLE_STATUSES)[number];

/** Query params accepted by `PraesidiaAiSystems.list` (`ListAiSystemsQueryDto`). */
export interface ListAiSystemsQuery {
  lifecycleStatus?: AiSystemLifecycleStatus;
  environment?: AiSystemEnvironment;
  criticality?: AiSystemCriticality;
  businessUnit?: string;
  ownerId?: string;
  includeArchived?: boolean;
  q?: string;
  page?: number;
  limit?: number;
}

/** An AI System record as returned by the API (`AiSystemResponseDto`, passthrough shape). */
export type AiSystemRecord = Record<string, unknown>;

/**
 * Body accepted by `PraesidiaAiSystems.updateOwners` (`UpdateAiSystemOwnersDto`,
 * SDK-0003). All four owner pairs are optional and independently settable;
 * `null` clears a pair. `be` validates each `*Type`/`*Id` pair together
 * (membership + non-member owner checks) in the service, not this DTO.
 */
export interface UpdateAiSystemOwnersInput {
  ownerType?: AiSystemOwnerType | null;
  ownerId?: string | null;
  technicalOwnerType?: AiSystemOwnerType | null;
  technicalOwnerId?: string | null;
  securityOwnerType?: AiSystemOwnerType | null;
  securityOwnerId?: string | null;
  complianceOwnerType?: AiSystemOwnerType | null;
  complianceOwnerId?: string | null;
}

/**
 * AISYS-0018 — lifecycle targets `PATCH .../lifecycle` refuses; each needs an approved
 * transition request (be `ai-system-lifecycle.util.ts` `APPROVAL_GATED_LIFECYCLE_TARGETS`).
 */
export const APPROVAL_GATED_LIFECYCLE_TARGETS = ['production', 'retired'] as const;

/** `entities/ai-system-lifecycle-transition-request.entity.ts`'s request statuses. */
export const AI_SYSTEM_LIFECYCLE_REQUEST_STATUSES = [
  'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED',
] as const;
export type AiSystemLifecycleRequestStatus = (typeof AI_SYSTEM_LIFECYCLE_REQUEST_STATUSES)[number];

/** Body of `requestLifecycleTransition` (`RequestAiSystemLifecycleTransitionDto`). */
export interface RequestAiSystemLifecycleTransitionInput {
  toStatus: AiSystemLifecycleStatus;
  /** Max 2000 chars. */
  reason?: string;
}

/** Body of `approve`/`rejectLifecycleTransition` (`DecideAiSystemLifecycleTransitionDto`). */
export interface DecideAiSystemLifecycleTransitionInput {
  /** Max 2000 chars. */
  reason?: string;
}

/** Query of `listLifecycleRequests` (`ListAiSystemLifecycleRequestsQueryDto`; be defaults `status` to `PENDING`). */
export interface ListAiSystemLifecycleRequestsQuery {
  status?: AiSystemLifecycleRequestStatus;
  aiSystemId?: string;
  page?: number;
  limit?: number;
}

/** `AiSystemLifecycleTransitionRequestResponseDto`. Dates are ISO strings. */
export interface AiSystemLifecycleTransitionRequest {
  id: string;
  organizationId: string;
  aiSystemId: string;
  fromStatus: AiSystemLifecycleStatus;
  toStatus: AiSystemLifecycleStatus;
  requiredRole: string;
  requestedBy: string;
  requestReason?: string | null;
  status: AiSystemLifecycleRequestStatus;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decisionReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body of `retire` (`RetireAiSystemDto`). */
export interface RetireAiSystemInput {
  /** 10–4000 chars: what is kept, for how long, then what happens. */
  retentionPolicy: string;
  /** ISO 8601 date. */
  retentionUntil?: string;
  /** 10–4000 chars. */
  reason: string;
}

/** `AiSystemRetirementPreviewDto` — the blast radius the approver acts on. */
export interface AiSystemRetirementPreview {
  aiSystemId: string;
  lifecycleStatus: string;
  dependentCount: number;
  dependents: Array<{ aiSystemId: string; name: string; retiringAssetId: string; dependentAssetId: string }>;
  agentCount: number;
  agents: Array<{ assetId: string; agentId: string; name: string }>;
  agentIds: string[];
  retentionPolicy?: string | null;
  retentionUntil?: string | null;
  retiredAt?: string | null;
  archivedAt?: string | null;
}

/** 202 body of `retire` (`RetireAiSystemResponseDto`). */
export interface RetireAiSystemResult {
  /** The pending `retired` lifecycle request; approve it to retire the system. */
  requestId: string;
  preview: AiSystemRetirementPreview;
}

/** Body of `reapprove` (`ReapproveAiSystemDto`). */
export interface ReapproveAiSystemInput {
  /** UUID of the material change the flag names now (`reapprovalMaterialChangeId`), else 409. */
  materialChangeId: string;
  /** Max 2000 chars. */
  reason?: string;
}

/** `entities/ai-asset.entity.ts`'s `AI_ASSET_TYPES` (24 values, SDK-0007 synced with DB-0300's
 * widened enum, SDK-0314 adds BE-0338's `GUARDRAIL`; kept in sync via `ai-systems.spec.ts`'s
 * openapi contract test). */
export const AI_ASSET_TYPES = [
  'APPLICATION', 'AGENT', 'MODEL', 'MODEL_ENDPOINT', 'MCP_SERVER', 'MCP_TOOL', 'A2A_ENDPOINT',
  'API', 'DATA_SOURCE', 'DATASET', 'VECTOR_STORE', 'RAG_INDEX', 'PROMPT', 'SKILL', 'VENDOR',
  'IDENTITY', 'CREDENTIAL', 'REPOSITORY', 'CLOUD_RESOURCE', 'WORKFLOW', 'TOOL', 'API_ENDPOINT',
  'DATA_SCOPE', 'GUARDRAIL',
] as const;
export type AiAssetType = (typeof AI_ASSET_TYPES)[number];

/** `entities/ai-asset.entity.ts`'s `AI_ASSET_SOURCES` — every source a stored asset can carry, so
 * the `listAssets` filter accepts all of them (SDK-0317 adds `entitlement_projection`, DB-0300). */
export const AI_ASSET_SOURCES = [
  'manual', 'runtime_observation', 'discovery_connector', 'api', 'import', 'entitlement_projection',
] as const;
export type AiAssetSource = (typeof AI_ASSET_SOURCES)[number];

/** `dto/create-ai-asset.dto.ts`'s `CLIENT_SOURCES` (be BE-1529, SDK-0317): the only sources
 * `createAsset`/`putAssetByExternalId` may send. The other {@link AI_ASSET_SOURCES} are written only
 * by be's own pipelines, and be answers 400 to a client that sends one. */
export const AI_ASSET_CLIENT_SOURCES = ['manual', 'api', 'import'] as const satisfies readonly AiAssetSource[];
export type AiAssetClientSource = (typeof AI_ASSET_CLIENT_SOURCES)[number];

/** `entities/ai-asset.entity.ts`'s `AI_ASSET_DISCOVERY_STATUSES`. */
export const AI_ASSET_DISCOVERY_STATUSES = ['discovered', 'adopted', 'ignored'] as const;
export type AiAssetDiscoveryStatus = (typeof AI_ASSET_DISCOVERY_STATUSES)[number];

/** `dto/adopt-ai-asset.dto.ts`'s `AI_ASSET_ENTITY_TYPES` (adopt's `entityType`). */
export const AI_ASSET_ENTITY_TYPES = ['agent', 'application', 'mcp-server', 'llm-config', 'workflow', 'eval-dataset'] as const;
export type AiAssetEntityType = (typeof AI_ASSET_ENTITY_TYPES)[number];

/** Query params accepted by `PraesidiaAiSystems.listAssets` (`ListAiAssetsQueryDto`). */
export interface ListAiAssetsQuery {
  assetType?: AiAssetType;
  source?: AiAssetSource;
  discoveryStatus?: AiAssetDiscoveryStatus;
  environment?: AiSystemEnvironment;
  includeArchived?: boolean;
  q?: string;
  page?: number;
  limit?: number;
}

/** Body accepted by `PraesidiaAiSystems.adoptAsset` (`AdoptAiAssetDto`). Idempotent: a repeat
 * call for the same `entityType`/`entityId` returns the same asset id, no duplicate. */
export interface AdoptAiAssetInput {
  entityType: AiAssetEntityType;
  entityId: string;
  aiSystemId?: string;
  role?: AiSystemAssetRole;
}

/** An AI Asset record as returned by the API (`AiAssetResponseDto`, passthrough shape). */
export type AiAssetRecord = Record<string, unknown>;

/**
 * Body accepted by `PraesidiaAiSystems.createAsset` (`CreateAiAssetDto`,
 * SDK-0003). For an asset backed by a real agent/application/MCP server/
 * model/workflow/eval-dataset row, use {@link AdoptAiAssetInput} via
 * `adoptAsset` instead — this creates metadata-only assets (e.g. `VENDOR`,
 * `CREDENTIAL`) with no backing runtime entity.
 */
export interface CreateAiAssetInput {
  name: string;
  assetType: AiAssetType;
  /** Defaults to `manual` server-side. */
  source?: AiAssetClientSource;
  discoveryStatus?: AiAssetDiscoveryStatus;
  environment?: AiSystemEnvironment;
  ownerType?: AiSystemOwnerType;
  ownerId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Body accepted by `PraesidiaAiSystems.updateAsset` (`UpdateAiAssetDto`,
 * SDK-0003) — `assetType`/`source`/`discoveryStatus` are immutable/
 * behaviour-owned and omitted here, matching `be`'s DTO.
 */
export type UpdateAiAssetInput = Partial<
  Omit<CreateAiAssetInput, 'assetType' | 'source' | 'discoveryStatus'>
>;

/** `entities/ai-system-asset.entity.ts`'s `AiSystemAssetRole` (hand-copied per CONTRACT.md —
 * not entity-array-derived like the other AI Systems enums). */
export const AI_SYSTEM_ASSET_ROLES = ['primary', 'supporting', 'dependency', 'external'] as const;
export type AiSystemAssetRole = (typeof AI_SYSTEM_ASSET_ROLES)[number];

/** Body accepted by `PraesidiaAiSystems.attachAsset` (`AttachAiSystemAssetDto`). */
export interface AttachAiSystemAssetInput {
  assetId: string;
  role?: AiSystemAssetRole;
}

/** An AI System ↔ Asset membership record (`AiSystemAssetResponseDto`, passthrough shape). */
export type AiSystemAssetRecord = Record<string, unknown>;

/** Body accepted by `PraesidiaAiSystems.changeAssetRole` (`ChangeAiSystemAssetRoleDto`, SDK-0003). */
export interface ChangeAiSystemAssetRoleInput {
  role: AiSystemAssetRole;
}

/** `entities/asset-relationship.entity.ts`'s `ASSET_RELATIONSHIP_TYPES` (13 values, SDK-0007/
 * SDK-0304 synced -- see `AI_ASSET_TYPES`'s note above). */
export const ASSET_RELATIONSHIP_TYPES = [
  'USES', 'CALLS', 'ACCESSES', 'CONTAINS', 'DELEGATES_TO', 'HOSTED_BY', 'READS', 'WRITES',
  'HAS_PERMISSION', 'GOVERNED_BY', 'CAN_INVOKE', 'GRANTS_SCOPE', 'CAN_ASSUME',
] as const;
export type AssetRelationshipType = (typeof ASSET_RELATIONSHIP_TYPES)[number];

/** Body accepted by `PraesidiaAiSystems.createRelationship` (`CreateAssetRelationshipDto`). */
export interface CreateAssetRelationshipInput {
  sourceAssetId: string;
  targetAssetId: string;
  relationshipType: AssetRelationshipType;
  source?: string;
  /** Number from 0 to 1, as accepted by the create/update DTOs. */
  confidence?: number;
  metadata?: Record<string, unknown>;
  sourceGeography?: string;
  processingGeography?: string;
  destinationGeography?: string;
  vendorAiAssetId?: string;
  crossBorderStatus?: CrossBorderStatus;
}

export const CROSS_BORDER_STATUSES = ['unknown', 'compliant', 'review_required', 'violation'] as const;
export type CrossBorderStatus = (typeof CROSS_BORDER_STATUSES)[number];

/** Query params accepted by `PraesidiaAiSystems.listRelationships` (`ListAssetRelationshipsQueryDto`). */
export interface ListAssetRelationshipsQuery {
  sourceAssetId?: string;
  targetAssetId?: string;
  /** Either endpoint (source or target). */
  assetId?: string;
  relationshipType?: AssetRelationshipType;
  crossBorderStatus?: CrossBorderStatus;
  includeArchived?: boolean;
  page?: number;
  limit?: number;
}

/** An asset relationship (graph edge) record (`AssetRelationshipResponseDto`, passthrough shape). */
export type AssetRelationshipRecord = Record<string, unknown>;

/**
 * Body accepted by `PraesidiaAiSystems.updateRelationship`
 * (`UpdateAssetRelationshipDto`, SDK-0003) — endpoints (`sourceAssetId`/
 * `targetAssetId`) are immutable after creation; moving one is archiving
 * this edge and creating a new one, matching `be`'s DTO.
 */
export type UpdateAssetRelationshipInput = Partial<
  Omit<CreateAssetRelationshipInput, 'sourceAssetId' | 'targetAssetId' | 'sourceGeography' | 'processingGeography' | 'destinationGeography' | 'vendorAiAssetId'>
> & {
  sourceGeography?: string | null;
  processingGeography?: string | null;
  destinationGeography?: string | null;
  vendorAiAssetId?: string | null;
};

/** `TraverseAssetGraphQueryDto`'s `direction` (be's AISYS-0003). */
export const ASSET_GRAPH_DIRECTIONS = ['downstream', 'upstream', 'both'] as const;
export type AssetGraphDirection = (typeof ASSET_GRAPH_DIRECTIONS)[number];

/**
 * Query params accepted by `PraesidiaAiSystems.traverse`
 * (`TraverseAssetGraphQueryDto`, be's AISYS-0003, SDK-0005). `assetTypes`/
 * `relationshipTypes` are applied INSIDE the recursive traversal leg, so a
 * filtered-out node prunes everything beyond it too.
 */
export interface TraverseAssetGraphQuery {
  /** Anchor node to traverse from. */
  assetId: string;
  direction?: AssetGraphDirection;
  /** Hop cap; server-clamped by `AI_SYSTEM_GRAPH_MAX_DEPTH` (default 6) — a
   * value above the cap is lowered, not rejected (see `stats.depthClamped`). */
  maxDepth?: number;
  assetTypes?: AiAssetType[];
  relationshipTypes?: AssetRelationshipType[];
  includeArchived?: boolean;
}

/** A node in a traversal result (`AssetNodeDto`, passthrough shape). */
export interface AssetGraphNode {
  id: string;
  assetType: AiAssetType;
  name: string;
  entityType?: AiAssetEntityType | null;
  entityId?: string | null;
  environment?: AiSystemEnvironment | null;
}

/** An edge in a traversal result (`RelationshipEdgeDto`). */
export interface AssetGraphEdge {
  id: string;
  sourceAssetId: string;
  targetAssetId: string;
  relationshipType: AssetRelationshipType;
  source: string;
  confidence: string;
}

/** `AssetGraphStatsDto` — `depth` is the `maxDepth` actually applied (post-clamp). `truncated`
 * is always `false` today: an oversized result 413s instead (`AI_SYSTEM_GRAPH_MAX_NODES`). */
export interface AssetGraphStats {
  depth: number;
  nodeCount: number;
  edgeCount: number;
  depthClamped: boolean;
  truncated: boolean;
}

/**
 * Response of `PraesidiaAiSystems.traverse` (`AssetGraphTraversalResponseDto`).
 * The anchor's shortest-hop reachability TREE (one inbound edge per
 * non-anchor node), not the full induced subgraph of every edge between
 * reached nodes.
 */
export interface AssetGraphTraversalResponse {
  nodes: AssetGraphNode[];
  edges: AssetGraphEdge[];
  stats: AssetGraphStats;
}

/**
 * One section of `PraesidiaAiSystems.getSummary`'s response
 * (`AiSystemSummarySectionDto`, be's AISYS-0004). `available: false` means
 * the backing service cannot filter by this AI System's asset entity ids at
 * all (see `reason`) — distinct from a genuine all-zero `counts`.
 */
export interface AiSystemSummarySection {
  available: boolean;
  reason?: string;
  counts?: Record<string, number>;
  updatedAt?: string;
}

/**
 * Response of `PraesidiaAiSystems.getSummary`
 * (`AiSystemSummaryResponseDto`, be's AISYS-0004, SDK-0005) — thin
 * cross-domain aggregations for one AI System's linked assets.
 * `cost` is always `available: false` today (AISYS-0025 tracks the gap).
 */
export interface AiSystemSummaryResponse {
  compliance: AiSystemSummarySection;
  risk: AiSystemSummarySection;
  evaluations: AiSystemSummarySection;
  cost: AiSystemSummarySection;
  evidence: AiSystemSummarySection;
  /** Assets attached to this AI System whose `entityType` is null. */
  unlinkedAssets: number;
}

/**
 * Response of every `by-external-id` desired-state method (be's BE-0579,
 * `DesiredStateOutcomeDto`, SDK-0302/PRAE-228/229). `changed` is the
 * plan-stability signal for IaC-shaped callers (Terraform provider, k8s
 * operator): sending the same body twice returns `changed: false` the
 * second time with a byte-identical `updatedAt` — nothing was written.
 * `created` distinguishes a fresh insert from an update of an existing row;
 * DELETE always archives (never a hard delete) and returns the same shape.
 */
export interface DesiredStateOutcome<T> {
  id: string;
  externalId: string;
  created: boolean;
  changed: boolean;
  updatedAt: string;
  resource: T;
}

/** Result of `PraesidiaAiSystems.putSystemByExternalId`/`deleteSystemByExternalId`. */
export type AiSystemDesiredStateResult = DesiredStateOutcome<AiSystemRecord>;

/** Result of `PraesidiaAiSystems.putAssetByExternalId`/`deleteAssetByExternalId`. */
export type AiAssetDesiredStateResult = DesiredStateOutcome<AiAssetRecord>;

/** Result of `PraesidiaAiSystems.putRelationshipByExternalId`/`deleteRelationshipByExternalId`. */
export type AssetRelationshipDesiredStateResult = DesiredStateOutcome<AssetRelationshipRecord>;

/**
 * SDK-0348 — server cap on `guardrails/validate` content, in Unicode code points
 * (`@MaxLength(100000)` on ValidateContentDto). Longer content is rejected
 * locally with `GuardContentTooLargeError` instead of sending a request that 400s.
 */
export const MAX_GUARD_CONTENT_LENGTH = 100_000;
