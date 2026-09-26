import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { endpoint } from './config.mjs';

export async function callRemote(url, token, organizationId, name, args) {
  if (!['list_protected_actions', 'praesidia_managed_action'].includes(name)) throw new Error('Tool is outside the managed allowlist');
  const target = endpoint(url);
  if (typeof token !== 'string' || token.length < 16 || /[\r\n]/.test(token)) throw new Error('Secret credential required');
  const transport = new StreamableHTTPClientTransport(target, { requestInit: {
    headers: { Authorization: `Bearer ${token}`, 'X-Org-Id': organizationId }, redirect: 'error',
  }, fetch: async (input, init) => {
    const requested = new URL(input instanceof Request ? input.url : input);
    if (requested.origin !== target.origin || requested.pathname !== target.pathname) throw new Error('MCP endpoint changed');
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30000)]) });
  } });
  const client = new Client({ name: 'praesidia-managed-client', version: '0.1.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    if (result.isError || !Array.isArray(result.content) || result.content.length !== 1 || result.content[0].type !== 'text' ||
      result.content[0].text.length > 1048576) throw new Error('Invalid MCP tool response');
    const value = JSON.parse(result.content[0].text);
    if (!value || value.organizationId !== organizationId) throw new Error('MCP tenant binding failed');
    return value;
  } catch { throw new Error('Authenticated MCP operation failed; inspect its owned checkpoint before any further execution'); }
  finally { await client.close().catch(() => {}); }
}
