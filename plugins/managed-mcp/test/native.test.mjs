import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ManagedActions } from '../src/managed.mjs';
import { serveHttp } from '../src/server.mjs';
import { fixture } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { PraesidiaManagedMcp } = require('../clients/n8n/nodes/PraesidiaManagedMcp.node.js');
const { PraesidiaManagedMcp: Credential } = require('../clients/n8n/credentials/PraesidiaManagedMcp.credentials.js');
const root = fileURLToPath(new URL('../', import.meta.url));
async function setup(t, ecosystem) {
  const f = await fixture(ecosystem); t.after(() => f.close());
  const actions = new ManagedActions(f.config); await actions.verifyInstallation();
  const server = await serveHttp(actions); t.after(() => new Promise(r => server.close(r)));
  const authority = `127.0.0.1:${server.address().port}`; f.config.http.allowedHosts.push(authority);
  return { ...f, endpoint: `http://${authority}/mcp` };
}

test('actual n8n node class executes explicit review/resume over authenticated MCP; no batch effects', async t => {
  const f = await setup(t, 'n8n');
  const node = new PraesidiaManagedMcp();
  assert.equal(new Credential().properties.find(p => p.name === 'token').typeOptions.password, true);
  const invoke = async parameters => (await node.execute.call({
    getInputData: () => [{ json: {} }],
    getCredentials: async name => { assert.equal(name, 'praesidiaManagedMcp'); return { endpoint: f.endpoint, token: f.config.httpToken,
      organizationId: f.config.organizationId, installationId: f.config.installationId }; },
    getNodeParameter: (name, index) => { assert.equal(index, 0); return parameters[name]; },
  }))[0][0].json;
  const p = await invoke({ operation: 'prepare', operationKey: 'native-node', body: '{"message":"n8n inert effect"}' });
  assert.equal(p.status, 'PENDING'); assert.equal(f.counters.effects, 0);
  await assert.rejects(invoke({ operation: 'resume', approvalId: p.approvalId, requestCommitment: p.requestCommitment,
    confirm: `RESUME ${p.approvalId} ${p.requestCommitment}` }));
  f.approve(p.approvalId);
  const params = { operation: 'resume', approvalId: p.approvalId, requestCommitment: p.requestCommitment,
    confirm: `RESUME ${p.approvalId} ${p.requestCommitment}` };
  assert.equal((await invoke(params)).targetReceiptIndependentlyVerified, true);
  await invoke(params); assert.equal(f.counters.effects, 1); assert.equal(f.counters.resume, 1);
  await assert.rejects(node.execute.call({ getInputData: () => [{}, {}] }), /exactly one/);
  f.control.disabled = true;
  assert.equal((await invoke({ operation: 'checkpoint', approvalId: p.approvalId })).closure, 'SUCCEEDED');
  await assert.rejects(invoke(params));
  f.control.credential = false; await assert.rejects(invoke({ operation: 'connection' }));
});

function python(payload, runtime) {
  const executable = process.env.PRAESIDIA_NATIVE_PYTHON;
  if (!executable) throw new Error('PRAESIDIA_NATIVE_PYTHON required for mandatory native adapter tests (Python3.12, lfx1.12.0, mcp1.29.1)');
  const difyPath = process.env.PRAESIDIA_DIFY_SDK_PATH;
  if (runtime === 'dify' && !difyPath) throw new Error('PRAESIDIA_DIFY_SDK_PATH required (dify_plugin0.10.2 isolated dependency directory)');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [root + 'acceptance/python-client.py'], { cwd: root,
      env: { PATH: process.env.PATH, PYTHONPATH: runtime === 'dify' ? difyPath : root + 'clients/python',
        PYTHONUNBUFFERED: '1', DO_NOT_TRACK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native client exceeded 30 seconds; effect is not retried')); }, 30000);
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Native ${runtime} exited ${code}: ${stderr.slice(-1200)}`));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Malformed native output')); } } });
    child.stdin.end(JSON.stringify({ runtime, ...payload }));
  });
}

for (const runtime of ['dify', 'langflow']) test(`actual ${runtime} SDK loads and executes authenticated prepare/read/resume with inert signed target`, async t => {
  const f = await setup(t, runtime);
  await python({ metadata: true }, runtime);
  const credentials = { endpoint: f.endpoint, token: f.config.httpToken, organization_id: f.config.organizationId, installation_id: f.config.installationId };
  const invoke = parameters => python({ credentials, parameters }, runtime);
  const p = await invoke({ operation: 'prepare', operation_key: 'native-client', body_json: '{"message":"native inert effect"}' });
  assert.equal(p.status, 'PENDING'); assert.equal(f.counters.effects, 0);
  assert.equal((await invoke({ operation: 'checkpoint', approval_id: p.approvalId })).actionId, p.actionId);
  const params = { operation: 'resume', approval_id: p.approvalId, request_commitment: p.requestCommitment,
    confirm: `RESUME ${p.approvalId} ${p.requestCommitment}` };
  await assert.rejects(invoke(params)); assert.equal(f.counters.resume, 0);
  f.approve(p.approvalId);
  const result = await invoke(params);
  assert.equal(result.closure, 'SUCCEEDED'); assert.equal(result.targetReceiptIndependentlyVerified, true);
  await invoke(params); assert.equal(f.counters.effects, 1); assert.equal(f.counters.resume, 1);
  f.control.disabled = true;
  assert.equal((await invoke({ operation: 'checkpoint', approval_id: p.approvalId })).closure, 'SUCCEEDED');
  await assert.rejects(invoke(params));
  f.control.credential = false; await assert.rejects(invoke({ operation: 'connection' }));
});

test('Dify vendored connection code is exactly the tested shared Python package', async () => {
  assert.deepEqual(await readFile(root + 'clients/python/praesidia_managed_client.py'), await readFile(root + 'clients/dify/praesidia_managed_client.py'));
});
