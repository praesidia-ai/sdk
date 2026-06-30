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
export { PraesidiaClient } from './client.js';
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
} from './types.js';
