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
