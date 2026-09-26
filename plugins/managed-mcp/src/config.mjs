import { readFile } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import { z } from 'zod';

export function endpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new Error('Use HTTPS, or loopback HTTP for local acceptance; no embedded credentials/query');
  }
  return url;
}
const schema = z.object({
  apiUrl: z.string().url(), organizationId: z.string().uuid(), createdByUserId: z.string().uuid(),
  ecosystemId: z.enum(['opencode', 'claude-code', 'n8n', 'dify', 'langflow', 'zeroclaw', 'nemoclaw']),
  runtimeVersion: z.string().min(1).max(100), profileId: z.literal('managed-mcp'),
  checkpointRuntime: z.enum(['custom', 'zeroclaw', 'openclaw']).default('custom'),
  stateDirectory: z.string().min(1), enablePrepare: z.boolean().default(false), enableResume: z.boolean().default(false),
  target: z.object({ targetId: z.string().min(1).max(128), destination: z.string().url(), keyId: z.string().min(1), publicKeyPem: z.string().min(1) }).strict().optional(),
  mcpUrl: z.string().url().optional(),
  http: z.object({ host: z.enum(['127.0.0.1', '::1', '0.0.0.0']).default('127.0.0.1'), port: z.number().int().min(0).max(65535), allowedHosts: z.array(z.string().min(1)).min(1) }).strict().optional(),
}).strict();

export async function loadConfig(env = process.env) {
  if (!env.PRAESIDIA_MANAGED_CONFIG) throw new Error('PRAESIDIA_MANAGED_CONFIG required');
  const config = schema.parse(JSON.parse(await readFile(env.PRAESIDIA_MANAGED_CONFIG, 'utf8')));
  for (const value of [config.apiUrl, ...(config.target ? [config.target.destination] : []), ...(config.mcpUrl ? [config.mcpUrl] : [])]) endpoint(value);
  if (new URL(config.apiUrl).pathname !== '/') throw new Error('API URL must be the canonical origin');
  if (config.checkpointRuntime !== ({ zeroclaw: 'zeroclaw', nemoclaw: 'openclaw' }[config.ecosystemId] ?? 'custom')) throw new Error('Wrong runtime for ecosystem');
  if ((config.enablePrepare || config.enableResume) && !config.target) throw new Error('Independent target configuration required before enabling execution');
  if (config.target && createPublicKey(config.target.publicKeyPem).asymmetricKeyType !== 'ed25519') throw new Error('Independent Ed25519 target pin required');
  const installationId = z.string().uuid().parse(env.PRAESIDIA_RUNTIME_INSTALLATION_ID);
  const threadId = z.string().min(1).max(256).parse(env.PRAESIDIA_RUNTIME_THREAD_ID);
  const apiKey = z.string().min(16).parse(env.PRAESIDIA_API_KEY);
  if (!/^(?:pk_(?:live|test)_|pfa_)/.test(apiKey)) throw new Error('Personal or user-backed delegated credential required');
  if (config.enableResume && !config.enablePrepare) throw new Error('Resume requires preparation enabled');
  return { ...config, installationId, threadId, apiKey, mcpToken: env.PRAESIDIA_MCP_TOKEN,
    httpToken: env.PRAESIDIA_MANAGED_MCP_TOKEN, challenge: env.PRAESIDIA_RUNTIME_INSTALLATION_CHALLENGE };
}
