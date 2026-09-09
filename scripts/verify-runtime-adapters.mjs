#!/usr/bin/env node
/** Real pinned framework/plugin interfaces against a synthetic HTTP authority.
 * This proves client integration behavior, not a deployed backend or all host tool routes.
 * Install the candidate SDK/plugin tarballs, openclaw@2026.9.2 and @openai/agents@0.17.0
 * in an isolated directory, then pass --runtime-dir DIR --output result.json.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = Object.fromEntries(process.argv.slice(2).reduce((out, part, i, all) =>
  i % 2 === 0 ? [...out, [part, all[i + 1]]] : out, []));
assert.ok(argv['--runtime-dir'], '--runtime-dir is required');
const modules = resolve(argv['--runtime-dir'], 'node_modules');
const load = async path => import(pathToFileURL(resolve(modules, path)).href);
const pkg = async name => JSON.parse(await readFile(resolve(modules, name, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(argv['--runtime-dir'], 'package-lock.json'), 'utf8'));
for (const [name, integrity] of Object.entries({
  openclaw: 'sha512-M6C7UsnX815nv26qBJFYGe6aGzv+ftZLRzV6S9oRXUtXg2Yn67eVntpssT94kgkquKVSeUxerUg0j1ONp4WYQg==',
  '@openai/agents': 'sha512-yzJ3tfHLO/6um9wsZ5IzEAQDaY7VcDBMxOPq7IgBaJkEPHrGX0vIXWGL0aqyreikHW4OpVmWwCaBBIOxxILXlA==',
})) assert.equal(lock.packages[`node_modules/${name}`].integrity, integrity, `${name} tarball identity changed`);
assert.equal((await pkg('openclaw')).version, '2026.9.2');
assert.equal((await pkg('@openai/agents')).version, '0.17.0');
assert.equal((await pkg('@praesidia/sdk')).version, '0.3.1');
const { FileRuntimeAttemptStore, PraesidiaProtectedHttp, jcsCommitment } = await load('@praesidia/sdk/dist/index.js');
const { RunContext } = await load('@openai/agents/dist/index.mjs');
const { createPraesidiaTool } = await load('@praesidia/openai-agents/index.js');
const { default: plugin } = await load('@praesidia/openclaw/index.js');
// Test-only inspection of the pinned host runner. Production plugin uses public SDK imports.
const hookFile = (await readdir(resolve(modules, 'openclaw/dist'))).find(name => /^hook-runner-global-.*\.js$/.test(name));
assert.ok(hookFile);
const { s: createHookRunner } = await load(`openclaw/dist/${hookFile}`);
assert.equal(typeof createHookRunner, 'function');

const org = '10000000-0000-4000-8000-000000000001';
const human = '20000000-0000-4000-8000-000000000001';
const credential = 'fixture-only-credential';
const rows = new Map();
const byApproval = new Map();
let revoked = false, loseResponse = false, loseBeforeConsumption = false;
let resumeCalls = 0;
const stateRoot = await mkdtemp(resolve(tmpdir(), 'praesidia-native-attempts-'));
const effects = [];
const checkpoints = [];
const checks = [];
const body = async req => {
  let value = '';
  for await (const part of req) { value += part; assert.ok(value.length < 100_000); }
  return value ? JSON.parse(value) : {};
};
const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const target = createServer(async (req, res) => {
  const args = await body(req); effects.push(args); reply(res, 200, { applied: args });
});
const targetUrl = await listen(target);
const authority = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${credential}` || revoked) return reply(res, 403, { message: 'authority unavailable' });
    const path = req.url.replace(`/organizations/${org}/protected-actions/http`, '');
    if (path === '/prepare') {
      const request = await body(req);
      const key = JSON.stringify(request.checkpoint);
      let row = rows.get(key);
      const hash = jcsCommitment({ targetId: request.targetId, body: request.body, checkpoint: request.checkpoint });
      if (row && row.requestCommitment !== hash) return reply(res, 409, { message: 'request changed' });
      if (!row) {
        row = { approvalId: randomUUID(), actionId: randomUUID(), requestCommitment: hash, status: 'PENDING',
          expiresAt: new Date(Date.now() + 600_000).toISOString(), consumedAt: null, approverId: null };
        rows.set(key, row); byApproval.set(row.approvalId, row); checkpoints.push(request.checkpoint);
      }
      return reply(res, 200, row);
    }
    if (path.startsWith('/checkpoints/')) {
      const row = byApproval.get(path.split('/')[2]);
      return reply(res, row ? 200 : 404, row ?? { message: 'missing' });
    }
    if (path === '/resume') {
      resumeCalls += 1;
      const request = await body(req), row = byApproval.get(request.approvalId);
      if (!row || row.status !== 'APPROVED' || row.consumedAt) return reply(res, 409, { message: 'not executable' });
      if (row.requestCommitment !== jcsCommitment({ targetId: request.targetId, body: request.body, checkpoint: request.checkpoint })) return reply(res, 409, { message: 'request changed' });
      if (loseBeforeConsumption) { loseBeforeConsumption = false; res.destroy(); return; }
      row.consumedAt = new Date().toISOString();
      const response = await fetch(targetUrl, { method: 'POST', body: JSON.stringify(request.body) });
      const result = await response.json();
      Object.assign(row, { closure: 'SUCCEEDED', result, resultCommitment: jcsCommitment(result), evidenceGrade: 'C', receipt: null });
      if (loseResponse) { loseResponse = false; res.destroy(); return; }
      return reply(res, 200, Object.fromEntries(['approvalId', 'actionId', 'requestCommitment',
        'closure', 'result', 'resultCommitment', 'evidenceGrade', 'receipt'].map(key => [key, row[key]])));
    }
    reply(res, 404, { message: 'unsupported path' });
  } catch (error) { reply(res, 500, { message: error.message }); }
});
const apiUrl = await listen(authority);
const approve = id => Object.assign(byApproval.get(id), { status: 'APPROVED', approverId: human });
const reject = id => Object.assign(byApproval.get(id), { status: 'REJECTED' });
const record = name => checks.push(name);

const priorFixtureKey = process.env.PRAESIDIA_RUNTIME_TEST_KEY;
try {
  process.env.PRAESIDIA_RUNTIME_TEST_KEY = credential;
  const config = { orgId: org, targetId: 'fixture-target', baseUrl: apiUrl, credentialEnv: 'PRAESIDIA_RUNTIME_TEST_KEY' };
  assert.ok(plugin.configSchema);
  const registerOpenClaw = () => {
    const factories = [], typedHooks = [];
    plugin.register({ pluginConfig: config,
      // Public pinned host API shape, deliberately a synthetic owned fixture path.
      runtime: { state: { resolveStateDir: () => stateRoot } },
      on(hookName, handler) { typedHooks.push({ hookName, handler, pluginId: 'praesidia' }); },
      registerTool(factory) { factories.push(factory); },
    });
    assert.equal(factories.length, 1);
    return { factories, typedHooks };
  };
  assert.throws(() => plugin.register({ pluginConfig: config }), /state directory API/);
  assert.throws(() => plugin.register({ pluginConfig: config,
    runtime: { state: { resolveStateDir: () => 'relative-state' } } }), /absolute/);
  const { factories, typedHooks } = registerOpenClaw();
  record('openclaw_requires_public_absolute_runtime_state_directory');
  const runner = createHookRunner({ typedHooks });
  for (const toolName of ['exec', 'file_write', 'web_fetch', 'unmanaged_mcp']) {
    assert.equal((await runner.runBeforeToolCall({ toolName, params: {} }, {})).block, true);
  }
  assert.notEqual((await runner.runBeforeToolCall({ toolName: 'praesidia_protected_action', params: {} }, {}))?.block, true);
  record('openclaw_actual_hook_runner_blocks_unmanaged_tools');
  const ctx = { sessionId: 'actual-openclaw-session', senderIsOwner: true };
  const tool = factories[0](ctx);
  const initialEffects = effects.length;
  const pending = (await tool.execute('native-call-1', { body: { message: 'hello' } })).details;
  assert.equal(pending.kind, 'approval_required'); assert.equal(effects.length, initialEffects);
  record('openclaw_pending_has_zero_effects');
  approve(pending.approvalId);
  await assert.rejects(() => tool.execute('native-call-2', { body: { message: 'changed' }, resumeCallId: 'native-call-1' }));
  assert.equal(effects.length, initialEffects);
  record('openclaw_argument_drift_rejected');
  const completed = (await factories[0](ctx).execute('native-call-2', { body: { message: 'hello' }, resumeCallId: 'native-call-1' })).details;
  assert.equal(completed.kind, 'completed'); assert.equal(effects.length, initialEffects + 1);
  const replay = (await factories[0](ctx).execute('native-call-3', { body: { message: 'hello' }, resumeCallId: 'native-call-1' })).details;
  assert.equal(replay.actionId, pending.actionId); assert.equal(effects.length, initialEffects + 1);
  record('openclaw_new_tool_instance_recovers_without_duplicate_effect');
  await assert.rejects(() => factories[0]({ sessionId: ctx.sessionId, senderIsOwner: false }).execute('x', { body: {} }), /owner/);
  await assert.rejects(() => factories[0]({ senderIsOwner: true }).execute('x', { body: {} }), /session ID/);
  record('openclaw_unproven_owner_and_session_blocked');
  const changedSession = (await factories[0]({ ...ctx, sessionId: 'another-session' }).execute('x', { body: { message: 'hello' }, resumeCallId: 'native-call-1' })).details;
  assert.equal(changedSession.kind, 'approval_required'); assert.notEqual(changedSession.approvalId, pending.approvalId);
  record('openclaw_session_cannot_reuse_prior_approval');

  const unknownBody = { message: 'ambiguous-openclaw' };
  const unknownPending = (await tool.execute('native-unknown', { body: unknownBody })).details;
  approve(unknownPending.approvalId);
  const openclawResumeCount = resumeCalls;
  const openclawEffects = effects.length;
  loseBeforeConsumption = true;
  assert.equal((await tool.execute('unknown-wakeup', { body: unknownBody, resumeCallId: 'native-unknown' })).details.kind, 'outcome_unknown');
  assert.equal(byApproval.get(unknownPending.approvalId).consumedAt, null);
  assert.equal(resumeCalls, openclawResumeCount + 1);
  // A new registration creates a new store; the file cursor survives both.
  const freshPlugin = registerOpenClaw().factories[0](ctx);
  assert.equal((await freshPlugin.execute('fresh-wakeup', { body: unknownBody, resumeCallId: 'native-unknown' })).details.kind, 'outcome_unknown');
  assert.equal(resumeCalls, openclawResumeCount + 1);
  assert.equal(effects.length, openclawEffects);
  const marker = JSON.parse(await readFile(resolve(stateRoot, 'plugins/praesidia/attempts', `${unknownPending.approvalId}.json`), 'utf8'));
  assert.deepEqual(marker, { approvalId: unknownPending.approvalId, actionId: unknownPending.actionId,
    requestCommitment: unknownPending.requestCommitment });
  record('openclaw_ambiguous_unconsumed_attempt_survives_new_plugin_and_store_without_resume');

  const resource = new PraesidiaProtectedHttp({ apiKey: credential, orgId: org, baseUrl: apiUrl });
  const makeTool = () => createPraesidiaTool({ resource,
    attemptStore: new FileRuntimeAttemptStore(resolve(stateRoot, 'openai-attempts')),
    name: 'reviewed_write', targetId: 'fixture-target',
    description: 'Review the write', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } });
  const openaiTool = makeTool(), context = new RunContext({ praesidiaThreadId: 'actual-openai-session' });
  const details = callId => ({ toolCall: { type: 'function_call', name: 'reviewed_write', callId, arguments: '{"message":"hello"}' } });
  const args = { message: 'hello' }, before = effects.length;
  assert.equal(await openaiTool.needsApproval(context, args, 'sdk-call-1'), true);
  assert.equal(effects.length, before);
  const openaiApproval = context.context.praesidiaApproval.approvalId;
  const nativeOnly = await openaiTool.invoke(context, JSON.stringify(args), details('sdk-call-1'));
  assert.equal(nativeOnly.kind, 'approval_required'); assert.equal(effects.length, before);
  record('openai_native_approval_alone_cannot_dispatch');
  approve(openaiApproval);
  const restored = new RunContext(JSON.parse(JSON.stringify(context.toJSON())).context);
  assert.equal(await makeTool().needsApproval(restored, args, 'sdk-call-1'), false);
  loseResponse = true;
  const executed = await makeTool().invoke(restored, JSON.stringify(args), details('sdk-call-1'));
  assert.equal(executed.kind, 'completed'); assert.equal(effects.length, before + 1);
  await makeTool().invoke(restored, JSON.stringify(args), details('sdk-call-1'));
  assert.equal(effects.length, before + 1);
  record('openai_context_restore_and_lost_response_recover_once');
  await assert.rejects(() => makeTool().invoke(restored, '{"message":"changed"}', details('sdk-call-1')));
  await assert.rejects(() => makeTool().invoke(new RunContext({}), JSON.stringify(args), details('sdk-call-x')));
  await assert.rejects(() => makeTool().invoke(restored, JSON.stringify(args)));
  record('openai_argument_and_host_identity_mismatch_blocked');
  await openaiTool.needsApproval(context, args, 'sdk-denied');
  reject(context.context.praesidiaApproval.approvalId);
  await assert.rejects(() => openaiTool.invoke(context, JSON.stringify(args), details('sdk-denied')), /denied/);
  assert.equal(effects.length, before + 1);
  record('openai_denied_action_has_zero_effects');
  await makeTool().needsApproval(context, args, 'sdk-unknown');
  const unresolved = context.context.praesidiaApproval;
  approve(unresolved.approvalId);
  const openaiResumeCount = resumeCalls, openaiEffects = effects.length;
  loseBeforeConsumption = true;
  assert.equal((await makeTool().invoke(context, JSON.stringify(args), details('sdk-unknown'))).kind, 'outcome_unknown');
  assert.equal(byApproval.get(unresolved.approvalId).consumedAt, null);
  const anotherContext = new RunContext(JSON.parse(JSON.stringify(context.toJSON())).context);
  const anotherTool = makeTool(); // fresh factory and FileRuntimeAttemptStore
  // Native approval only reflects the still-approved backend checkpoint. Execution
  // separately consults the durable attempt claim and cannot repeat dispatch.
  assert.equal(await anotherTool.needsApproval(anotherContext, args, 'sdk-unknown'), false);
  assert.equal((await anotherTool.invoke(anotherContext, JSON.stringify(args), details('sdk-unknown'))).kind, 'outcome_unknown');
  assert.equal(resumeCalls, openaiResumeCount + 1);
  assert.equal(effects.length, openaiEffects);
  record('openai_ambiguous_unconsumed_attempt_survives_new_factory_store_and_context_without_resume');
  assert.throws(() => createPraesidiaTool({ resource, name: 'missing_store', targetId: 'fixture-target',
    description: 'Missing host store', parameters: { type: 'object', properties: {} } }), /RuntimeAttemptStore/);
  record('openai_requires_host_owned_attempt_store');
  revoked = true;
  await assert.rejects(() => tool.execute('revoked', { body: {} }));
  await assert.rejects(() => openaiTool.invoke(context, JSON.stringify(args), details('revoked')));
  assert.equal(effects.length, before + 1);
  record('both_actual_adapters_block_revoked_authority');
  assert.ok(checkpoints.some(c => c.runtime === 'openclaw'));
  assert.ok(checkpoints.some(c => c.runtime === 'openai-agents'));
  const result = { schemaVersion: 1, verifiedAt: new Date().toISOString(),
    scope: 'pinned real plugin/framework interfaces and synthetic HTTP authority; no model or deployed backend',
    platform: process.platform, architecture: process.arch, node: process.version,
    versions: { sdk: '0.3.1', openclaw: '2026.9.2', openaiAgents: '0.17.0' },
    checks, targetEffects: effects.length, resumeCalls,
    persistenceScope: 'owned single-host POSIX attempt markers across fresh factories/store instances; native contexts are synthetic',
    sourceSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') };
  if (argv['--output']) await writeFile(resolve(argv['--output']), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (priorFixtureKey === undefined) delete process.env.PRAESIDIA_RUNTIME_TEST_KEY;
  else process.env.PRAESIDIA_RUNTIME_TEST_KEY = priorFixtureKey;
  await close(authority); await close(target);
  await rm(stateRoot, { recursive: true, force: true });
}
