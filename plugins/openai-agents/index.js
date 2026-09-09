import { tool } from '@openai/agents';
import { PraesidiaRuntimeTool } from '@praesidia/sdk';

/** Host context and actual SDK tool-call IDs bind the durable request. */
export function createPraesidiaTool({ resource, name, targetId, description, parameters, attemptStore }) {
  const managed = new PraesidiaRuntimeTool(resource, { runtime: 'openai-agents', name, targetId, description }, attemptStore);
  function call(context, callId) {
    const threadId = context?.context?.praesidiaThreadId;
    if (typeof threadId !== 'string' || !threadId || typeof callId !== 'string' || !callId) {
      throw new Error('Praesidia requires a host-bound praesidiaThreadId and actual SDK tool call ID');
    }
    return { threadId, callId, ...(context.context.praesidiaTaskId ? { taskId: context.context.praesidiaTaskId } : {}) };
  }
  return tool({
    name, description, parameters, strict: false,
    // Infrastructure/authority errors propagate and cannot become successful tool output.
    errorFunction: null,
    async needsApproval(context, args, callId) {
      const state = await managed.prepare(args, call(context, callId));
      // This context is host-owned SDK state, never the model's function arguments.
      context.context.praesidiaApproval = state;
      if (state.kind === 'denied') throw new Error('Praesidia denied this protected action');
      return !['ready', 'completed'].includes(state.kind);
    },
    async execute(args, context, details) {
      details?.signal?.throwIfAborted();
      const outcome = await managed.invoke(args, call(context, details?.toolCall?.callId));
      if (outcome.kind === 'denied') throw new Error('Praesidia denied this protected action');
      return outcome;
    },
  });
}
