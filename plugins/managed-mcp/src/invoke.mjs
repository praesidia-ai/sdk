#!/usr/bin/env node
/** Explicit local acceptance/operator invocation. Arguments are public; secrets stay in env. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from './config.mjs';
import { argumentSchema, TOOL_NAME } from './managed.mjs';

let client;
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--arguments-file') throw new Error('Explicit arguments file required');
  const bytes = await readFile(process.argv[3]);
  if (bytes.length > 262144) throw new Error('Arguments exceed limit');
  const args = argumentSchema.parse(JSON.parse(bytes));
  const config = await loadConfig();
  const names = ['PATH', 'NODE_EXTRA_CA_CERTS', 'PRAESIDIA_MANAGED_CONFIG', 'PRAESIDIA_API_KEY',
    'PRAESIDIA_RUNTIME_INSTALLATION_ID', 'PRAESIDIA_RUNTIME_THREAD_ID', 'PRAESIDIA_MCP_TOKEN'];
  const env = Object.fromEntries(names.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'serve', '--stdio'], env, stderr: 'pipe' });
  client = new Client({ name: 'praesidia-explicit-invocation', version: '0.1.0' });
  await client.connect(transport);
  const call = async arguments_ => {
    const result = await client.callTool({ name: TOOL_NAME, arguments: arguments_ }, undefined, { timeout: 30000 });
    if (result.isError || result.content.length !== 1 || result.content[0].type !== 'text') throw new Error('Managed operation failed');
    const value = JSON.parse(result.content[0].text);
    if (value.organizationId !== config.organizationId || value.installationId !== config.installationId) throw new Error('Response identity changed');
    return value;
  };
  const connection = args.operation === 'checkpoint' ? null : await call({ operation: 'connection' });
  if (connection && (connection.status !== 'CONNECTED' || !connection.liveAuthorityChecked)) throw new Error('Connection not current');
  process.stdout.write(JSON.stringify(args.operation === 'connection' ? connection : await call(args)) + '\n');
} catch {
  process.stderr.write('Explicit managed invocation failed closed; read the owned checkpoint before any further execution.\n');
  process.exitCode = 1;
} finally { await client?.close().catch(() => {}); }
