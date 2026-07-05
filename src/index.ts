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

export { PraesidiaGuard } from './guard.js';
export { PraesidiaCompliance } from './compliance.js';
export { PraesidiaAgents } from './agents.js';
export { PraesidiaClient } from './client.js';
export { MAX_CLIENT_SECRET_GRACE_SECONDS } from './types.js';
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
  TriggeredGuardrail,
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
  // Agent client-secret rotation (Q4-01)
  RotateClientSecretOptions,
  RotateClientSecretResult,
} from './types.js';
