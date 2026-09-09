/** Runs against installed exact native packages. No NVIDIA sandbox is implied. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createRuntime } from 'mcporter';
import plugin from '../index.js';
import { TOOL } from '../bridge.js';
const require = createRequire(import.meta.url);
const openclawRoot = dirname(dirname(require.resolve('openclaw/plugin-sdk/plugin-entry')));
const packageRoot = dirname(openclawRoot);
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(metadata.version, '2026.7.1');
const hooks = await import(pathToFileURL(join(openclawRoot, 'hook-runner-global-Cucx8m-W.js')).href);

test('actual pinned native modifying-hook runner blocks before a tool can execute', async () => {
  const registry = { hooks: [], typedHooks: [], plugins: [{ id: plugin.id, status: 'loaded' }] };
  const tools = [];
  plugin.register({ pluginConfig: { mcpUrl: 'https://companion.example/mcp', installationId: '11111111-1111-4111-8111-111111111111' },
    on: (hookName, handler, options) => registry.typedHooks.push({ pluginId: plugin.id, hookName, handler, ...options }),
    registerTool: factory => tools.push(factory),
  });
  assert.equal(tools.length, 1); assert.equal(tools[0]({}).name, TOOL);
  hooks.i(registry);
  let attemptedEffects = 0;
  for (const toolName of ['exec', 'write', 'browser', 'sessions_spawn', 'other_mcp_write']) {
    const verdict = await hooks.t().runBeforeToolCall({ toolName, params: {} }, {});
    if (!verdict?.block) attemptedEffects++;
    assert.equal(verdict.block, true);
  }
  assert.equal(attemptedEffects, 0);
  assert.equal(await hooks.t().runBeforeToolCall({ toolName: TOOL, params: { operation: 'connection' } }, {}), undefined);
  // A later plugin cannot clear the sticky native block verdict.
  registry.plugins.push({ id: 'later-plugin', status: 'loaded' });
  registry.typedHooks.push({ pluginId: 'later-plugin', hookName: 'before_tool_call', priority: -20_000, handler: () => ({ block: false }) });
  assert.equal((await hooks.t().runBeforeToolCall({ toolName: 'exec', params: {} }, {})).block, true);
  hooks.a();
});

test('actual pinned static policy keeps core tools unavailable when the managed plugin is absent', async () => {
  const { t: applyPolicy } = await import(pathToFileURL(join(openclawRoot, 'tool-policy-pipeline-B20mmoYq.js')).href);
  const tools = ['exec', 'write', 'browser', 'sessions_spawn'].map(name => ({ name }));
  const policy = { allow: [TOOL] };
  const filtered = applyPolicy({ tools, toolMeta: () => undefined, steps: [{ label: 'managed profile', policy, stripPluginOnlyAllowlist: true }], warn() {}, auditLogLevel: 'debug' });
  assert.deepEqual(filtered, []);
  assert.deepEqual(policy, { allow: [TOOL] });
});

test('actual pinned mcporter public runtime sends one exact call and never auto-corrects/retries a failed effect', async () => {
  const fixture = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let input = ''; for await (const part of req) input += part;
    const request = JSON.parse(input); res.setHeader('content-type', 'application/json');
    if (request.method === 'initialize') { res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'inert-exact-tool', version: '1' } } })); return; }
    if (request.method === 'tools/call') { calls.push(request.params); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Tool not found: praesidia_managed_action. Similar tool: unreviewed_write' } })); return; }
    res.writeHead(202).end();
  });
  const calls = [];
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  const runtime = await createRuntime({ servers: [{ name: 'praesidia', command: { kind: 'http', url: new URL(`http://127.0.0.1:${fixture.address().port}/mcp`) } }], logger: { info() {}, warn() {}, error() {}, debug() {} } });
  try {
    await assert.rejects(runtime.callTool('praesidia', TOOL, { args: { operation: 'resume', approvalId: 'exact' }, timeoutMs: 3000 }));
    assert.deepEqual(calls, [{ name: TOOL, arguments: { operation: 'resume', approvalId: 'exact' } }]);
  } finally { await runtime.close(); await new Promise(resolve => fixture.close(resolve)); }
});
