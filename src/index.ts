/**
 * @praesidia/sdk — Open-source agent governance SDK
 *
 * Apache 2.0 licensed. https://github.com/praesidia-ai/sdk
 *
 * Quick start:
 *   import { PraesidiaGuard } from '@praesidia/sdk';
 *
 *   const guard = new PraesidiaGuard();
 *   const result = await guard.run(
 *     () => openai.chat.completions.create({ ... }),
 *     { input: userMessage },
 *   );
 */

export { PraesidiaGuard, toolCallContextFromTask } from './guard.js';
export { PraesidiaCompliance } from './compliance.js';
export { PraesidiaAgents } from './agents.js';
export { PraesidiaMemory } from './memory.js';
export { PraesidiaTelemetry, genAiSpan } from './telemetry.js';
export { PraesidiaTrust, jwkThumbprint, jwkThumbprintHex } from './trust.js';
// FINDING-2 — parity with the Python SDK's workflows/connections/audit
// resources; FINDING-1 — analytics implementation matching the README claim.
export { PraesidiaWorkflows } from './workflows.js';
export { PraesidiaConnections } from './connections.js';
export { PraesidiaAudit } from './audit.js';
// SCAN2-011 — shared pagination envelope/helpers for the list families above.
export type { PaginationMeta, PaginatedEnvelope } from './pagination.js';
export { PraesidiaProof } from './proof.js';
export { PROTECTED_ACTION_CLOSURES } from './proof-types.js';
export type {
  ProtectedActionClosure, EvidenceGrade, ListProtectedActionsQuery,
  ProtectedActionSummary, ProtectedActionDetail, ProtectedActionList,
  ProtectedActionEvent, CaptureScopeEntry, ProtectedActionCoverage,
} from './proof-types.js';
export { PraesidiaAnalytics } from './analytics.js';
export { PraesidiaClient, CHAIN_ID_HEADER } from './client.js';
// FINDING-4 — retry policy config type.
export type { RetryConfig } from './retry.js';
export {
  verifyEd25519,
  verifyEs256,
  canonicalJson,
  ed25519PublicKeyFromJwk,
  p256PublicKeyFromJwk,
} from './crypto.js';
export {
  MEMORY_RETENTION_REGIMES,
  MEMORY_SOURCE_TYPES,
  OTLP_MAX_RESOURCE_SPANS,
  OTLP_MAX_BODY_BYTES,
} from './types.js';
export {
  GuardrailBlockedError,
  PraesidiaApiError,
  PraesidiaConfigError,
  // PA01 DX-001 — protectAction error taxonomy
  ProtectedActionDeniedError,
  UnsupportedProtectedActionTargetError,
} from './errors.js';
// PA01 D2/D18 — RFC 8785 JCS canonicalization (byte-compared against the
// shared golden fixtures in jcs-canonical.spec.ts).
export {
  jcsCanonicalize,
  jcsCommitment,
  JcsCanonicalizationError,
} from './jcs-canonical.js';
export {
  // FINDING-2 — connection status enum + guard used by PraesidiaConnections.
  CONNECTION_STATUSES,
  WORKFLOW_STATUSES,
} from './types.js';
export type {
  GuardConfig,
  RunOptions,
  // AUDIT-SDK-02 — task type accepted by POST /organizations/:orgId/tasks
  AgentTaskType,
  CheckOptions,
  CheckResult,
  GuardedResult,
  TaskRecord,
  ToolCallRecord,
  ToolCallContext,
  PolledTaskRow,
  TriggeredGuardrail,
  // FINDING-2 — agents CRUD / workflows / connections / audit parity types
  ListAgentsQuery,
  AgentRecord,
  ListWorkflowsQuery,
  ListWorkflowRunsQuery,
  WorkflowRecord,
  WorkflowStatus,
  WorkflowRunRecord,
  TriggerWorkflowOptions,
  ListConnectionsQuery,
  ConnectionRecord,
  ConnectionStatus,
  ListAuditLogsQuery,
  AuditLogEntry,
  // FINDING-1 — analytics parity types
  AnalyticsWindowQuery,
  AnalyticsResult,
  // AUD-0063 — analytics coverage parity types
  AnalyticsCaptureState,
  AgentAnalyticsResult,
  AnalyticsEventType,
  AnalyticsEvent,
  AnalyticsEventsQuery,
  RecordAnalyticsEventInput,
  AnalyticsAnomaly,
  CostByTeamEntry,
  ModelComparisonEntry,
  AnalyticsTimeRange,
  SecurityMetricsResult,
  UsageHeatmapResult,
  ComplianceMetricsResult,
  // Agent identity + task lifecycle (H1-02a)
  AgentIdentity,
  BeginTaskOptions,
  CompleteTaskOptions,
  TaskHandle,
  // Compliance report export (Q1-04)
  AuditorReportGenerationStatus,
  ReportRequestResult,
  AuditorReportStatus,
  AuditorReportDocument,
  AuditorReportMetadata,
  AuditorReportSummary,
  DiscoveredInventoryItem,
  ClassifiedEntitySummary,
  ArticleMapping,
  EntityArticleMatrix,
  MerkleAnchoring,
  TamperEvidence,
  JurisdictionMetadata,
  TestedMetadata,
  ReportPollOptions,
  // Agent memory (H2-06e)
  CreateMemoryInput,
  SearchMemoryInput,
  ListMemoriesQuery,
  EraseMemoryInput,
  MemoryRecord,
  MemorySourceAuthorization,
  MemorySourceAuthorizationInput,
  MemoryProvenance,
  MemoryGuardrail,
  MemoryRetention,
  MemorySourceType,
  MemoryRetentionRegime,
  EraseMemoryResult,
  // OTLP GenAI telemetry emit (H1-02)
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpSpan,
  OtlpScopeSpans,
  OtlpResource,
  OtlpResourceSpans,
  OtlpExportTraceServiceRequest,
  OtlpIngestAck,
  GenAiSpanInput,
  // Trust passport verify (H3-02f)
  TrustPassport,
  TrustPassportProof,
  TrustPassportCredentialSubject,
  TrustPassportPosture,
  TrustPassportRedTeam,
  TrustPassportAttestations,
  TrustPassportVerifyBundle,
  TrustVerificationResult,
  TrustVerificationReason,
  TrustFetchAndVerifyResult,
  // SEC-2026-09-12 MCPSDK-04 — caller-supplied trust anchor for fetchAndVerify.
  TrustFetchAndVerifyOptions,
  TrustAnchorJwk,
  // PA01 DX-001 — protectAction (managed MCP Proof Edge)
  ProtectActionTarget,
  McpProtectedActionTarget,
  ProtectActionOptions,
  ProtectActionResult,
  ProtectedActionContent,
  // PA-0026 — machine-readable pre-dispatch deny reason
  ActionDenyReason,
} from './types.js';
// PA01 D2/D18 — JCS canonicalization value type
export type { JsonValue } from './jcs-canonical.js';

export { PraesidiaProtectedHttp, verifyProtectedHttpResult, PROTECTED_HTTP_RUNTIMES } from './protected-http.js';
export type { ProtectedHttpRequest, ProtectedHttpCheckpoint, ProtectedHttpResult, RuntimeCheckpoint, TrustedHttpTarget, ProtectedHttpRuntime } from './protected-http.js';
export { PraesidiaRuntimeTool } from './runtime-tool.js';
export { FileRuntimeAttemptStore } from './runtime-attempt-store.js';
export type { RuntimeAttemptStore, RuntimeAttempt } from './runtime-attempt-store.js';
export type { RuntimeCall, RuntimeToolConfig, RuntimeToolResource, RuntimeToolOutcome } from './runtime-tool.js';
export { verifyHttpReceipt, httpRequestCommitment, httpTargetKeyFingerprint, HTTP_RECEIPT_VERSION } from './http-receipt.js';
export type { SignedHttpReceipt, HttpReceiptStatement, HttpRequestEnvelope } from './http-receipt.js';

export { PraesidiaIdentity } from './identity.js';
export type { FederatedCredential, FederatedAuthority, ExternalAssertionExchange } from './identity.js';
