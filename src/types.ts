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

// ── Agent client-secret rotation (Q4-01) ──────────────────────────────────────
// Rotate an agent's A2A client secret with an optional grace/overlap window so a
// long-lived consumer can adopt the new secret with zero downtime.
// Endpoint: POST /organizations/:orgId/agents/:agentId/client-secret/rotate

/** Server-side hard cap on the rotation grace window — 7 days, in seconds. */
export const MAX_CLIENT_SECRET_GRACE_SECONDS = 7 * 24 * 60 * 60;

/** Options for PraesidiaAgents.rotateClientSecret(). */
export interface RotateClientSecretOptions {
  /**
   * Overlap window, in seconds, during which the OUTGOING client secret stays
   * valid alongside the freshly minted one (zero-downtime rotation). Omit or
   * pass 0 for an instant, fail-closed rotation (the old secret is revoked the
   * moment the new one is minted). Range 0..604800; clamped server-side.
   */
  gracePeriodSeconds?: number;
}

/**
 * Result of a client-secret rotation.
 *
 * SECURITY: `clientSecret` is the NEW plaintext secret and is returned EXACTLY
 * ONCE — Praesidia stores only its hash. Persist it immediately; it is never
 * recoverable afterwards. Never log it.
 */
export interface RotateClientSecretResult {
  /** The agent A2A client id (unchanged by rotation). */
  clientId: string;
  /** The freshly minted plaintext client secret. Shown ONCE — store it now. */
  clientSecret: string;
  /**
   * UTC ISO-8601 timestamp until which the PREVIOUS secret also remains valid,
   * or null for an instant (no-grace) rotation.
   */
  graceEndsAt: string | null;
  /**
   * The effective grace window in seconds actually applied (after server-side
   * clamping). 0 means the old secret was revoked instantly.
   */
  gracePeriodSeconds: number;
}
