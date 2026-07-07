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
export { PraesidiaTrust } from './trust.js';
export { PraesidiaClient, CHAIN_ID_HEADER } from './client.js';
export {
  verifyEd25519,
  canonicalJson,
  ed25519PublicKeyFromJwk,
} from './crypto.js';
export { OTLP_MAX_RESOURCE_SPANS, OTLP_MAX_BODY_BYTES } from './types.js';
export {
  GuardrailBlockedError,
  PraesidiaApiError,
  PraesidiaConfigError,
} from './errors.js';
export type {
  GuardConfig,
  RunOptions,
  CheckOptions,
  CheckResult,
  GuardedResult,
  TaskRecord,
  ToolCallRecord,
  ToolCallContext,
  PolledTaskRow,
  TriggeredGuardrail,
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
} from './types.js';
