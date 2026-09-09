import type { FunctionTool } from '@openai/agents';
import type { RuntimeAttemptStore, RuntimeToolOutcome, RuntimeToolResource } from '@praesidia/sdk';
export interface PraesidiaAgentContext {
  praesidiaThreadId: string;
  praesidiaTaskId?: string;
  praesidiaApproval?: RuntimeToolOutcome;
}
export function createPraesidiaTool(config: {
  resource: RuntimeToolResource;
  attemptStore: RuntimeAttemptStore;
  name: string;
  targetId: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}): FunctionTool<PraesidiaAgentContext, any, RuntimeToolOutcome>;
