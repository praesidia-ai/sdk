import { definePluginEntry, buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';
import { FileRuntimeAttemptStore, PraesidiaProtectedHttp, PraesidiaRuntimeTool } from '@praesidia/sdk';
import { join } from 'node:path';
import manifest from './openclaw.plugin.json' with { type: 'json' };

const TOOL = 'praesidia_protected_action';
const authorized = (ctx, config) => ctx.senderIsOwner === true ||
  (config.allowLocalCli === true && ctx.oneShotCliRun === true && !ctx.messageChannel);

export default definePluginEntry({
  id: 'praesidia',
  name: 'Praesidia',
  description: 'Review, execute and inspect an exact registered tool request.',
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api) {
    const config = api.pluginConfig ?? {};
    const credentialEnv = config.credentialEnv ?? 'PRAESIDIA_API_KEY';
    if (typeof credentialEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(credentialEnv)) {
      throw new Error('Praesidia credentialEnv must name an environment variable');
    }
    if (typeof config.orgId !== 'string' || !config.orgId || typeof config.targetId !== 'string' || !config.targetId) {
      throw new Error('Praesidia requires an organization and a registered protected target');
    }
    if (typeof api.runtime?.state?.resolveStateDir !== 'function') {
      throw new Error('Praesidia requires the public OpenClaw runtime state directory API');
    }
    const attemptStore = new FileRuntimeAttemptStore(join(
      api.runtime.state.resolveStateDir(), 'plugins', 'praesidia', 'attempts'));
    api.on('before_tool_call', (event) => {
      if (config.enforceManagedOnly !== false && event?.toolName !== TOOL) {
        return { block: true, blockReason: 'This agent is restricted to Praesidia protected tools. Register and review a target before executing it.' };
      }
      return undefined;
    });

    api.registerTool((ctx) => ({
      name: TOOL,
      label: 'Praesidia protected action',
      description: 'Request a registered protected action. A pending result has no effect. After independent approval, repeat the same body with resumeCallId from the previous result. Approval is checked by Praesidia, never by tool arguments.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['body'],
        properties: {
          body: { type: 'object', additionalProperties: true },
          resumeCallId: { type: 'string', minLength: 1, maxLength: 190, description: 'Original host tool call ID to recover the same approved action.' },
        },
      },
      async execute(toolCallId, params, signal) {
        signal?.throwIfAborted();
        // Shared channel credentials cannot be borrowed by an unproven requester.
        if (!authorized(ctx, config)) throw new Error('Praesidia requires the runtime-verified owner or an explicitly enabled local CLI run');
        if (typeof ctx.sessionId !== 'string' || !ctx.sessionId) throw new Error('Praesidia requires an actual conversation session ID');
        const apiKey = process.env[credentialEnv];
        if (!apiKey) throw new Error('Praesidia credential is unavailable');
        if (!params || typeof params !== 'object' || Array.isArray(params) ||
          Object.keys(params).some(key => !['body', 'resumeCallId'].includes(key))) throw new Error('Invalid Praesidia tool input');
        const resource = new PraesidiaProtectedHttp({ apiKey, orgId: config.orgId,
          runtimeInstallationId: config.installationId,
          baseUrl: config.baseUrl, requestTimeoutMs: 10000, retry: false });
        const managed = new PraesidiaRuntimeTool(resource, { runtime: 'openclaw', name: TOOL,
          targetId: config.targetId, description: 'Review OpenClaw protected action' }, attemptStore);
        const callId = params.resumeCallId ?? toolCallId;
        const outcome = await managed.invoke(params.body, { threadId: ctx.sessionId, callId });
        const details = { ...outcome, resumeCallId: callId };
        // Keep the bounded result and its actual identifiers; credentials never enter output.
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details,
          isError: ['denied', 'failed_no_effect', 'partial', 'outcome_unknown'].includes(outcome.kind) };
      },
    }), { names: [TOOL] });
  },
});
