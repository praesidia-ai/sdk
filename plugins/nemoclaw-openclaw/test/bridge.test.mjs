import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeToolCall, validateConfig, nativeServer, connectionBinding, invokeManaged, TOOL } from '../bridge.js';
const id = '11111111-1111-4111-8111-111111111111';
const config = validateConfig({ mcpUrl: 'https://companion.example/mcp', installationId: id });
const raw = () => ({ mcpServers: { praesidia: { baseUrl: config.mcpUrl, headers: { Authorization: 'Bearer openshell:resolve:env:PRAESIDIA_MCP_TOKEN' } } } });
const connected = overrides => ({ content: [{ type: 'text', text: JSON.stringify({ installationId: id, ecosystemId: 'nemoclaw', profileId: 'managed-mcp', status: 'CONNECTED', verifiedAt: '2026-09-07T00:00:00Z', liveAuthorityChecked: true, ...overrides }) }] });
test('explicitly blocks builtins, other MCP tools and malformed getters without throwing', () => {
  for (const event of [null, {}, { toolName: 'shell' }, { toolName: 'file_write' }, { toolName: 'browser' }, { toolName: 'mcp_other_write' }, { get toolName() { throw Error('bad event'); } }]) assert.equal(beforeToolCall(event).block, true);
  assert.equal(beforeToolCall({ toolName: TOOL }), undefined);
});
test('pins native OpenShell HTTP and never accepts a direct credential or arbitrary process', () => {
  assert.equal(nativeServer(raw(), config).command.url.href, config.mcpUrl);
  for (const mutate of [r => r.mcpServers.praesidia.baseUrl = 'https://evil.example/mcp', r => r.mcpServers.praesidia.command = '/bin/sh', r => r.mcpServers.praesidia.env = {}, r => r.mcpServers.praesidia.auth = 'oauth', r => r.mcpServers.praesidia.headers.Authorization = 'Bearer pk_real', r => r.mcpServers.praesidia.headers.Other = 'foreign']) {
    const value = raw(); mutate(value); assert.throws(() => nativeServer(value, config));
  }
});
for (const bad of [{ mcpUrl: 'http://companion.example/mcp' }, { mcpUrl: 'https://user:password@companion.example/mcp' }, { installationId: '' }, { configPath: './config' }, { allowLocalCli: 'true' }, { enforceManagedOnly: false }]) test(`rejects unsafe configuration ${Object.keys(bad)[0]}`, () => assert.throws(() => validateConfig({ mcpUrl: config.mcpUrl, installationId: id, ...bad })));
test('connection must live-bind exact installed profile; cached/malformed/foreign/disabled fail closed', () => {
  assert.equal(connectionBinding(connected(), id).installationId, id);
  for (const override of [{ installationId: '22222222-2222-4222-8222-222222222222' }, { ecosystemId: 'zeroclaw' }, { profileId: 'native-mcp-registration' }, { status: 'DISABLED' }, { liveAuthorityChecked: false }, { verifiedAt: null }]) assert.throws(() => connectionBinding(connected(override), id));
  for (const response of [{}, { isError: true, ...connected() }, { content: [{ type: 'text', text: '{}' }] }]) assert.throws(() => connectionBinding(response, id));
});
test('fixed target, fresh provider header, exact args snapshot, live binding and one resume only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nemo-gate-'));
  try {
    const local = { ...config, configPath: join(dir, 'mcporter.json') }; await writeFile(local.configPath, JSON.stringify(raw()));
    const calls = []; let closes = 0;
    const factory = async options => { assert.equal(options.servers.length, 1); assert.equal(options.servers[0].name, 'praesidia'); return { callTool: async (server, name, options) => { calls.push({ server, name, ...options }); return options.args.operation === 'connection' ? connected() : { content: [{ type: 'text', text: 'approved result' }] }; }, close: async () => { closes++; } }; };
    const params = { operation: 'resume', approvalId: 'host-approved', requestCommitment: 'exact-commitment', confirm: 'exact-confirmation' };
    const pending = invokeManaged(local, { sessionId: 'real-native-session', senderIsOwner: true }, 'native-call', params, undefined, factory);
    params.approvalId = 'mutated-after-invoke';
    const result = await pending;
    assert.equal(calls.length, 2); assert.equal(calls[0].args.operation, 'connection'); assert.equal(calls[1].args.approvalId, 'host-approved'); assert.equal(closes, 1);
    assert.equal(result.details.sessionId, 'real-native-session'); assert.equal(result.details.installationId, id);
    assert.ok(calls.every(call => call.server === 'praesidia' && call.name === TOOL));
    const changed = raw(); changed.mcpServers.praesidia.headers.Authorization = 'Bearer openshell:resolve:env:REVISION2_PRAESIDIA_MCP_TOKEN'; await writeFile(local.configPath, JSON.stringify(changed));
    await invokeManaged(local, { sessionId: 'session', senderIsOwner: true }, 'call', { operation: 'connection' }, undefined, async options => {
      assert.ok(options.servers[0].command.headers.Authorization.includes('REVISION2_')); return { callTool: async () => connected(), close: async () => {} };
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('unproven requester, wrong live installation and transport loss never dispatch/retry effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nemo-gate-'));
  try {
    const local = { ...config, configPath: join(dir, 'mcporter.json') }; await writeFile(local.configPath, JSON.stringify(raw()));
    let effects = 0, connections = 0, closes = 0;
    const factory = async () => ({ callTool: async (_s, _n, options) => { if (options.args.operation === 'connection') { connections++; return connected(); } effects++; throw new Error('lost response after possible effect'); }, close: async () => { closes++; } });
    await assert.rejects(invokeManaged(local, { sessionId: 'session', senderIsOwner: false }, 'call', { operation: 'resume' }, undefined, factory)); assert.equal(connections, 0);
    await assert.rejects(invokeManaged(local, { sessionId: 'session', senderIsOwner: true }, 'call', { operation: 'resume' }, undefined, factory)); assert.equal(effects, 1); assert.equal(closes, 1);
    await assert.rejects(invokeManaged(local, { sessionId: 'session', senderIsOwner: true }, 'call', { operation: 'resume' }, undefined, async () => ({ callTool: async () => connected({ status: 'DISABLED' }), close: async () => {} }))); assert.equal(effects, 1);
    const aborted = new AbortController(); aborted.abort(); await assert.rejects(invokeManaged(local, { sessionId: 'session', senderIsOwner: true }, 'call', { operation: 'resume' }, aborted.signal, factory)); assert.equal(effects, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
