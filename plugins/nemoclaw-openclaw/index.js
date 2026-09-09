import { definePluginEntry, buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';
import { createRuntime } from 'mcporter';
import { TOOL, beforeToolCall, invokeManaged, validateConfig } from './bridge.js';
import manifest from './openclaw.plugin.json' with { type: 'json' };

export default definePluginEntry({
  id: 'praesidia-nemoclaw', name: 'Praesidia managed NemoClaw tools',
  description: 'Native dispatch gate around the registered managed MCP companion',
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api) {
    const config = validateConfig(api.pluginConfig);
    api.on('before_tool_call', beforeToolCall, { priority: -10_000 });
    api.registerTool(ctx => ({
      name: TOOL, label: 'Praesidia managed action',
      description: 'Inspect connection, prepare a fixed-target action, inspect its checkpoint, or explicitly resume an independently approved action. Failure or unknown outcome must be inspected, never blindly retried.',
      parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
        operation: { type: 'string', enum: ['connection', 'prepare', 'checkpoint', 'resume', 'list_actions'] },
        operationKey: { type: 'string', minLength: 1 }, body: { type: 'object', additionalProperties: true },
        approvalId: { type: 'string' }, requestCommitment: { type: 'string' }, confirm: { type: 'string' },
      } },
      execute(toolCallId, params, signal) { return invokeManaged(config, ctx, toolCallId, params, signal, createRuntime); },
    }), { names: [TOOL] });
  },
});
