import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const TOOL = 'praesidia_managed_action';
export const BLOCK_REASON = 'This NemoClaw runtime permits only the registered Praesidia managed action. Native shell, file, browser and other tools are blocked.';

export function validateConfig(config) {
  if (!config || Object.keys(config).some(key => !['mcpUrl', 'installationId', 'configPath', 'allowLocalCli'].includes(key))) throw new Error('Invalid Praesidia NemoClaw configuration');
  const url = new URL(config.mcpUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || config.mcpUrl !== url.href) throw new Error('Pin one canonical HTTPS managed companion URL');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.installationId ?? '')) throw new Error('A runtime installation UUID is required');
  const configPath = config.configPath ?? '/sandbox/.openclaw/workspace/config/mcporter.json';
  if (!isAbsolute(configPath) || /[\0\r\n]/.test(configPath)) throw new Error('An absolute native mcporter config path is required');
  if (config.allowLocalCli !== undefined && typeof config.allowLocalCli !== 'boolean') throw new Error('Invalid local CLI authority option');
  return Object.freeze({ mcpUrl: url.href, installationId: config.installationId, configPath, allowLocalCli: config.allowLocalCli === true });
}

/** No network or callback errors may turn an unrelated tool into an allowed call. */
export function beforeToolCall(event) {
  try { if (event?.toolName === TOOL) return undefined; } catch { /* explicit denial below */ }
  return { block: true, blockReason: BLOCK_REASON };
}

/** Consume only the native, fixed-server OpenShell placeholder config. No local
 * command, OAuth helper, imported server or real credential can be substituted. */
export function nativeServer(raw, config) {
  const server = raw?.mcpServers?.praesidia;
  if (!server || server.baseUrl !== config.mcpUrl || server.command !== undefined || server.env !== undefined ||
      server.auth !== undefined || server.oauthCommand !== undefined || server.bearerToken !== undefined || server.bearerTokenEnv !== undefined) throw new Error('Managed MCP registration changed or is not an OpenShell HTTP provider');
  const headers = server.headers;
  if (!headers || Object.keys(headers).length !== 1 || typeof headers.Authorization !== 'string' ||
      !/^Bearer openshell:resolve:env:[A-Za-z0-9_]*PRAESIDIA_MCP_TOKEN$/.test(headers.Authorization)) throw new Error('Managed MCP requires native OpenShell credential replacement');
  return { name: 'praesidia', command: { kind: 'http', url: new URL(config.mcpUrl), headers: { Authorization: headers.Authorization } } };
}

export function connectionBinding(result, installationId) {
  if (result?.isError || !Array.isArray(result?.content) || result.content.length !== 1 || result.content[0]?.type !== 'text') throw new Error('Managed companion connection is unavailable');
  const value = JSON.parse(result.content[0].text);
  if (value?.installationId !== installationId || value.ecosystemId !== 'nemoclaw' || value.profileId !== 'managed-mcp' ||
      value.status !== 'CONNECTED' || value.liveAuthorityChecked !== true || !Number.isFinite(Date.parse(value.verifiedAt))) throw new Error('Managed companion installation is not currently connected');
  return value;
}

export async function invokeManaged(config, ctx, toolCallId, params, signal, createRuntime) {
  signal?.throwIfAborted();
  if (!(ctx?.senderIsOwner === true || (config.allowLocalCli && ctx?.oneShotCliRun === true && !ctx.messageChannel))) throw new Error('A runtime-verified owner is required');
  if (typeof ctx.sessionId !== 'string' || !ctx.sessionId || typeof toolCallId !== 'string' || !toolCallId) throw new Error('Native session and tool-call identity are required');
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['operation', 'operationKey', 'body', 'approvalId', 'requestCommitment', 'confirm'].includes(key))) throw new Error('Invalid managed action arguments');
  const args = structuredClone(params);
  if (!['connection', 'prepare', 'checkpoint', 'resume', 'list_actions'].includes(args.operation)) throw new Error('Unknown managed operation');
  // Re-read on every call: native provider rotation must never use a stale header.
  const raw = JSON.parse(await readFile(config.configPath, 'utf8'));
  const definition = nativeServer(raw, config);
  signal?.throwIfAborted();
  const runtime = await createRuntime({ servers: [definition], logger: { info() {}, warn() {}, error() {}, debug() {} } });
  try {
    // Public mcporter runtime has one call, unlike CLI typo autocorrection. The
    // remote companion owns durable approval/attempt state; transport failure
    // never triggers another call here. Neither host IDs nor authority is taken
    // from tool args. Session metadata remains local observation, not a token.
    let result;
    if (args.operation === 'checkpoint') {
      // Disabling execution must preserve authenticated inspection of an owned
      // checkpoint. The companion checks creator/org/thread/installation state.
      result = await runtime.callTool('praesidia', TOOL, { args, timeoutMs: 30_000 });
      if (!result?.isError) {
        if (!Array.isArray(result?.content) || result.content.length !== 1 || result.content[0]?.type !== 'text') throw new Error('Managed checkpoint readback is unavailable');
        const value = JSON.parse(result.content[0].text);
        if (value?.installationId !== config.installationId || typeof args.approvalId !== 'string' || !args.approvalId || value.approvalId !== args.approvalId) throw new Error('Managed checkpoint belongs to another installation or approval');
      }
    } else {
      const connection = await runtime.callTool('praesidia', TOOL, { args: { operation: 'connection' }, timeoutMs: 30_000 });
      connectionBinding(connection, config.installationId);
      signal?.throwIfAborted();
      result = args.operation === 'connection' ? connection : await runtime.callTool('praesidia', TOOL, { args, timeoutMs: 30_000 });
    }
    return { ...result, details: { runtime: 'nemoclaw-openclaw', installationId: config.installationId,
      sessionId: ctx.sessionId, toolCallId, executionAuthority: 'managed-companion' } };
  } finally { await runtime.close().catch(() => {}); }
}
