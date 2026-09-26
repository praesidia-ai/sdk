import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { ManagedActions } from '../src/managed.mjs';
import { State } from '../src/state.mjs';
import { serveHttp } from '../src/server.mjs';
import { callRemote } from '../src/client.mjs';
import { fixture } from './fixture.mjs';

const prepare = { operation: 'prepare', operationKey: 'one', body: { message: 'inert effect' } };
const resume = p => ({ operation: 'resume', approvalId: p.approvalId, requestCommitment: p.requestCommitment,
  confirm: `RESUME ${p.approvalId} ${p.requestCommitment}` });
async function setup(t, ecosystem = 'opencode') {
  const f = await fixture(ecosystem); t.after(() => f.close());
  const actions = new ManagedActions(f.config); await actions.verifyInstallation(); return { ...f, actions };
}

test('one-use authenticated installation binds creator, tenant, target and profile', async t => {
  const f = await setup(t);
  assert.equal((await f.actions.execute({ operation: 'connection' })).hostAttestationPerformed, false);
  await assert.rejects(f.actions.verifyInstallation());
  for (const key of ['organizationId', 'createdByUserId', 'installationId', 'targetId', 'ecosystemId', 'profileId']) {
    const binding = { id: f.config.installationId, ...f.actions.binding(), verifiedAt: new Date().toISOString(), status: 'CONNECTED' };
    binding[key === 'installationId' ? 'id' : key] = 'wrong';
    assert.throws(() => f.actions.assertInstallation(binding));
  }
  assert.equal(f.counters.effects, 0);
});

test('prepare never dispatches; distinct approval and explicit resume verify real target receipt', async t => {
  const f = await setup(t);
  const p = await f.actions.execute(prepare);
  assert.equal(p.status, 'PENDING'); assert.equal(f.counters.effects, 0);
  await assert.rejects(f.actions.execute(resume(p)), /approval/);
  f.approve(p.approvalId, f.config.createdByUserId);
  await assert.rejects(f.actions.execute(resume(p)), /distinct-human/);
  f.approve(p.approvalId);
  await assert.rejects(f.actions.execute({ ...resume(p), confirm: 'yes' }), /confirmation/);
  const result = await f.actions.execute(resume(p));
  assert.equal(result.targetReceiptIndependentlyVerified, true); assert.equal(result.closure, 'SUCCEEDED');
  assert.equal(result.auditBundleIndependentlyVerified, false); assert.equal(f.counters.effects, 1);
  const restarted = new ManagedActions(f.config);
  assert.equal((await restarted.execute(resume(p))).targetReceiptIndependentlyVerified, true);
  assert.equal(f.counters.resume, 1); assert.equal(f.counters.effects, 1);
});

test('pending checkpoint survives restart; changed original arguments are rejected', async t => {
  const f = await setup(t);
  const p = await f.actions.execute(prepare);
  const restarted = new ManagedActions(f.config);
  assert.equal((await restarted.execute({ operation: 'checkpoint', approvalId: p.approvalId })).status, 'PENDING');
  await assert.rejects(restarted.execute({ ...prepare, body: { changed: true } }));
  assert.equal(f.counters.effects, 0);
});

for (const status of ['REJECTED', 'CANCELLED', 'EXPIRED']) test(`${status} never reaches dispatch`, async t => {
  const f = await setup(t); const p = await f.actions.execute(prepare);
  f.approve(p.approvalId); f.values.get(p.approvalId).checkpoint.status = status;
  await assert.rejects(f.actions.execute(resume(p))); assert.equal(f.counters.resume, 0);
});

test('expired approval, changed checkpoint and revoked credential fail closed', async t => {
  const f = await setup(t); const p = await f.actions.execute(prepare); f.approve(p.approvalId);
  f.values.get(p.approvalId).checkpoint.expiresAt = new Date(0).toISOString();
  await assert.rejects(f.actions.execute(resume(p)));
  f.control.wrongCheckpoint = true; await assert.rejects(f.actions.execute({ operation: 'checkpoint', approvalId: p.approvalId }));
  f.control.wrongCheckpoint = false; f.control.credential = false;
  await assert.rejects(f.actions.execute(resume(p))); assert.equal(f.counters.effects, 0);
});

test('disabled installation is checked by actual dispatch; attempt cannot be retried after admission denial', async t => {
  const f = await setup(t); const p = await f.actions.execute(prepare); f.approve(p.approvalId); f.control.disabled = true;
  const result = await f.actions.execute(resume(p)); assert.equal(result.dispatchResponseUncertain, true);
  f.control.disabled = false;
  assert.equal((await new ManagedActions(f.config).execute(resume(p))).dispatchAttemptPreviouslyClaimed, true);
  assert.equal(f.counters.resume, 1); assert.equal(f.counters.effects, 0);
});

test('lost effect response reads only; restarts and concurrent resumes never resend', async t => {
  const f = await setup(t); const p = await f.actions.execute(prepare); f.approve(p.approvalId); f.control.loseResponse = true;
  const results = await Promise.all([f.actions.execute(resume(p)), new ManagedActions(f.config).execute(resume(p))]);
  assert.ok(results.some(r => r.targetReceiptIndependentlyVerified));
  await new ManagedActions(f.config).execute(resume(p));
  assert.equal(f.counters.resume, 1); assert.equal(f.counters.effects, 1);
});

test('partial effect and wrong independent pin are never mislabeled as verified success', async t => {
  const f = await setup(t); const p = await f.actions.execute({ ...prepare, body: { effect: 'partial' } }); f.approve(p.approvalId);
  const result = await f.actions.execute(resume(p));
  assert.equal(result.closure, 'PARTIAL'); assert.equal(result.targetReceiptIndependentlyVerified, true);
  const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const other = new ManagedActions({ ...f.config, target: { ...f.config.target, publicKeyPem: wrong } });
  assert.equal((await other.execute({ operation: 'checkpoint', approvalId: p.approvalId })).targetReceiptIndependentlyVerified, false);
});

test('signed unknown target effect remains unknown even when receipt authenticity verifies', async t => {
  const f = await setup(t); const p = await f.actions.execute({ ...prepare, body: { effect: 'unknown' } }); f.approve(p.approvalId);
  const result = await f.actions.execute(resume(p));
  assert.equal(result.targetReceiptIndependentlyVerified, true);
  assert.equal(result.closure, 'OUTCOME_UNKNOWN'); assert.equal(result.outcome, 'unknown'); assert.equal(result.retryAllowed, false);
});

test('state permission and corrupted records block rather than overwrite', async t => {
  const f = await setup(t); const p = await f.actions.execute(prepare);
  const path = join(f.config.stateDirectory, 'request-' + p.approvalId + '.json');
  await writeFile(path, '{'); await assert.rejects(f.actions.execute({ operation: 'checkpoint', approvalId: p.approvalId }));
  assert.equal(await readFile(path, 'utf8'), '{');
  await chmod(f.config.stateDirectory, 0o755); await assert.rejects(new State(f.config.stateDirectory).read('anything'));
  await chmod(f.config.stateDirectory, 0o700);
});

test('local preparation persistence failure stops without effects; stable operation recovers pending action', async t => {
  const f = await setup(t);
  const original = f.actions.state.writeOnce.bind(f.actions.state);
  f.actions.state.writeOnce = async (name, value) => { if (name.startsWith('request-')) throw new Error('synthetic disk failure'); return original(name, value); };
  await assert.rejects(f.actions.execute(prepare)); assert.equal(f.values.size, 1); assert.equal(f.counters.effects, 0);
  const p = await new ManagedActions(f.config).execute(prepare);
  assert.equal(p.status, 'PENDING'); assert.equal(f.values.size, 1); assert.equal(f.counters.effects, 0);
});

test('host run changes require new request scope but do not consume another installation challenge', async t => {
  const f = await setup(t); const p = await f.actions.execute(prepare);
  const other = new ManagedActions({ ...f.config, threadId: 'another-operator-run' });
  assert.equal((await other.execute({ operation: 'connection' })).status, 'CONNECTED');
  await assert.rejects(other.execute({ operation: 'checkpoint', approvalId: p.approvalId }));
  assert.equal(f.counters.verify, 1);
});

test('MCP redirects never forward a bearer credential to a second server', async t => {
  let reached = 0;
  const sink = createServer((_req, res) => { reached++; res.end('{}'); });
  await new Promise(r => sink.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => sink.close(r)));
  const redirect = createServer((_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${sink.address().port}/mcp` }).end(); });
  await new Promise(r => redirect.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => redirect.close(r)));
  await assert.rejects(callRemote(`http://127.0.0.1:${redirect.address().port}/mcp`, 'synthetic-secret-that-never-leaves-origin', 'tenant', 'praesidia_managed_action', { operation: 'connection' }));
  assert.equal(reached, 0);
});

test('real authenticated Streamable HTTP MCP call; wrong token, tenant, browser origin and redirect denied', async t => {
  const f = await setup(t);
  const server = await serveHttp(f.actions); t.after(() => new Promise(r => server.close(r)));
  const authority = `127.0.0.1:${server.address().port}`; f.config.http.allowedHosts.push(authority);
  const url = `http://${authority}/mcp`;
  const connected = await callRemote(url, f.config.httpToken, f.config.organizationId, 'praesidia_managed_action', { operation: 'connection' });
  assert.equal(connected.installationId, f.config.installationId);
  await assert.rejects(callRemote(url, 'wrong-token-that-is-long-enough-0000', f.config.organizationId, 'praesidia_managed_action', {}));
  await assert.rejects(callRemote(url, f.config.httpToken, 'different-tenant', 'praesidia_managed_action', {}));
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${f.config.httpToken}`, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal(f.counters.effects, 0);
});
