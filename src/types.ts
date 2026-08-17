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
  baseUrl?: string;
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
  /** Mark the task complete and record it. Resolves with the server taskId. */
  complete(
    output?: string,
    opts?: CompleteTaskOptions,
  ): Promise<string | undefined>;
  /** Mark the task failed and record it. Resolves with the server taskId. */
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

/** H2-06d — GDPR Art-17 crypto-shred of a data subject's memories. */
export interface EraseMemoryInput {
  /** The data-subject identifier whose memories must be crypto-shredded. */
  subjectId: string;
  /** Reason for erasure (recorded on the erasure certificate). */
  reason: string;
}

/** H2-06c — provenance lineage attached to a retrieved memory. */
export interface MemoryProvenance {
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

/** H2-06d — result of a subject-scoped crypto-shred. */
export interface EraseMemoryResult {
  subjectExternalIdHash: string;
  memoriesErased: number;
  dekDestroyed: boolean;
  certificateId: string | null;
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
  /** gen_ai.system — provider (e.g. 'openai', 'anthropic'). */
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
  /** Extra raw OTLP attributes to append. */
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
 * H3-02b — the Ed25519 detached proof. `proofValue` is a STANDARD base64
 * Ed25519 signature over the canonical JSON of the passport WITHOUT its `proof`
 * member.
 */
export interface TrustPassportProof {
  type: string;
  created: string;
  proofPurpose: string;
  verificationMethod: string;
  keyVersion: number;
  proofValue: string;
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
  /** Public key JWK (OKP Ed25519) for offline signature verification. */
  publicKeyJwk: Record<string, unknown>;
  /** URL to the agent DID document for key resolution. */
  didDocumentUrl: string;
  verificationHint?: string;
  embed?: Record<string, unknown>;
}

/** H3-02f — reasons a local passport verification can fail. */
export type TrustVerificationReason =
  | 'ok'
  | 'missing-proof'
  | 'malformed-public-key'
  | 'signature-mismatch'
  | 'malformed-passport'
  | 'invalid-expiration'
  | 'expired';

/** H3-02f — the outcome of `PraesidiaTrust.verifyPassport`. */
export interface TrustVerificationResult {
  /** True iff the Ed25519 signature verified AND the passport is not expired. */
  verified: boolean;
  /** True iff the Ed25519 signature is cryptographically valid (ignores expiry). */
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
}

/** An agent record as returned by the API (passthrough shape). */
export type AgentRecord = Record<string, unknown>;

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

/** Query params accepted by `PraesidiaAnalytics.usage` / advanced endpoints. */
export interface AnalyticsWindowQuery {
  /** Rolling window in days (1..365, default 30). */
  days?: number;
  fromDate?: string;
  toDate?: string;
}

export type AnalyticsResult = Record<string, unknown>;

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
