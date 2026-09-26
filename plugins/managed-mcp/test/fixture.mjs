import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpRequestCommitment, httpTargetKeyFingerprint, jcsCanonicalize, jcsCommitment } from '@praesidia/sdk';

export async function fixture(ecosystemId = 'opencode') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const org = randomUUID(), creator = randomUUID(), approver = randomUUID(), installationId = randomUUID();
  const state = await mkdtemp(join(tmpdir(), 'praesidia-managed-test-'));
  const values = new Map();
  const counters = { verify: 0, prepare: 0, checkpoint: 0, resume: 0, effects: 0, proofAuth: 0, proofReads: 0 };
  const control = { credential: true, disabled: false, loseResponse: false, wrongReceipt: false, wrongCheckpoint: false };
  let target;
  const targetServer = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); counters.effects++;
    const result = { accepted: input.body.message ?? null, effectNumber: counters.effects };
    const statement = { version: 'praesidia.http-receipt.v1', actionId: input.actionId, organizationId: org,
      targetId: target.targetId, keyId: target.keyId, requestCommitment: input.commitment, resultCommitment: jcsCommitment(result),
      effect: input.body.effect ?? 'succeeded', issuedAt: new Date().toISOString(), targetTransactionId: randomUUID() };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result, receipt: { statement, signature: sign(null, jcsCanonicalize(statement), privateKey).toString('base64') } }));
  });
  await new Promise(r => targetServer.listen(0, '127.0.0.1', r));
  target = { targetId: 'inert-write', destination: `http://127.0.0.1:${targetServer.address().port}/effect`, keyId: 'independent-fixture-pin', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const apiKey = 'pk_test_synthetic_' + randomUUID();
  const mcpToken = 'pk_test_separate_proof_' + randomUUID();
  const challenge = 'x'.repeat(43);
  const installation = () => ({ id: installationId, organizationId: org, createdByUserId: creator, ecosystemId,
    profileId: 'managed-mcp', targetId: target.targetId, status: control.disabled ? 'DISABLED' : 'CONNECTED',
    runtimeVersion: 'fixture-contract', verifiedAt: new Date().toISOString(), checks: { executionObserved: counters.effects > 0 } });
  const apiServer = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/me' || req.url.startsWith(`/organizations/${org}/protected-actions?`)) {
      if (!control.credential || req.headers['x-api-key'] !== mcpToken) { res.writeHead(401).end('{}'); return; }
      if (req.url === '/auth/me') { counters.proofAuth++; res.end(JSON.stringify({ userId: creator, organizations: [{ id: org, name: 'Synthetic fixture', role: 'OWNER' }] })); return; }
      counters.proofReads++; res.end(JSON.stringify({ data: [...values.values()].map(v => ({ actionId: v.checkpoint.actionId, closure: v.checkpoint.closure ?? null })), total: values.size, page: 1, limit: 20 })); return;
    }
    if (!control.credential || req.headers.authorization !== `Bearer ${apiKey}`) { res.writeHead(401).end('{}'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    if (req.url.endsWith('/verify')) {
      counters.verify++;
      if (body.challenge !== challenge || counters.verify > 1) { res.writeHead(400).end('{}'); return; }
      res.end(JSON.stringify(installation())); return;
    }
    if (req.method === 'GET' && req.url.endsWith('/runtime-installations/' + installationId)) { res.end(JSON.stringify(installation())); return; }
    if (req.url.endsWith('/prepare')) {
      counters.prepare++;
      if (control.disabled || body.checkpoint.installationId !== installationId) { res.writeHead(403).end('{}'); return; }
      const key = jcsCommitment(body.checkpoint);
      const commitment = httpRequestCommitment({ version: 'praesidia.http-request.v1', targetId: target.targetId,
        destination: target.destination, targetKeyFingerprint: httpTargetKeyFingerprint(target.publicKeyPem), method: 'POST', contentType: 'application/json', body: body.body });
      const previous = [...values.values()].find(v => v.key === key);
      if (previous && previous.checkpoint.requestCommitment !== commitment) { res.writeHead(409).end('{}'); return; }
      const checkpoint = previous?.checkpoint ?? { approvalId: randomUUID(), actionId: randomUUID(), requestCommitment: commitment,
        status: 'PENDING', expiresAt: new Date(Date.now() + 3600000).toISOString(), consumedAt: null, approverId: null };
      values.set(checkpoint.approvalId, { key, request: body, checkpoint }); res.end(JSON.stringify(checkpoint)); return;
    }
    if (req.method === 'GET') {
      counters.checkpoint++;
      const stored = values.get(req.url.split('/').at(-1));
      if (!stored) { res.writeHead(404).end('{}'); return; }
      res.end(JSON.stringify({ ...stored.checkpoint, ...(control.wrongCheckpoint ? { actionId: randomUUID() } : {}) })); return;
    }
    if (req.url.endsWith('/resume')) {
      counters.resume++;
      const stored = values.get(body.approvalId);
      if (control.disabled || !stored || stored.checkpoint.status !== 'APPROVED' || stored.checkpoint.approverId === creator || stored.checkpoint.consumedAt ||
        jcsCommitment({ targetId: body.targetId, body: body.body, checkpoint: body.checkpoint }) !==
        jcsCommitment({ targetId: stored.request.targetId, body: stored.request.body, checkpoint: stored.request.checkpoint })) { res.writeHead(403).end('{}'); return; }
      stored.checkpoint.consumedAt = new Date().toISOString();
      const response = await fetch(target.destination, { method: 'POST', body: JSON.stringify({ body: body.body, actionId: stored.checkpoint.actionId, commitment: stored.checkpoint.requestCommitment }) });
      const executed = await response.json();
      const effect = executed.receipt.statement.effect;
      Object.assign(stored.checkpoint, { closure: { succeeded: 'SUCCEEDED', partial: 'PARTIAL', failed_no_effect: 'FAILED_NO_EFFECT', unknown: 'OUTCOME_UNKNOWN' }[effect],
        result: executed.result, resultCommitment: jcsCommitment(executed.result), receipt: executed.receipt, evidenceGrade: 'A' });
      if (control.wrongReceipt) stored.checkpoint.receipt.statement.organizationId = randomUUID();
      if (control.loseResponse) { req.socket.destroy(); return; }
      res.end(JSON.stringify(stored.checkpoint)); return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise(r => apiServer.listen(0, '127.0.0.1', r));
  const config = { apiUrl: `http://127.0.0.1:${apiServer.address().port}`, organizationId: org, createdByUserId: creator,
    installationId, ecosystemId, profileId: 'managed-mcp', runtimeVersion: 'fixture-contract', checkpointRuntime: ecosystemId === 'zeroclaw' ? 'zeroclaw' : 'custom',
    stateDirectory: state, enablePrepare: true, enableResume: true, target, apiKey, mcpToken, threadId: 'operator-owned-run', challenge,
    httpToken: 'synthetic_companion_' + randomUUID(), http: { host: '127.0.0.1', port: 0, allowedHosts: [] } };
  return { config, values, counters, control, approver,
    approve(id, actor = approver) { Object.assign(values.get(id).checkpoint, { status: 'APPROVED', approverId: actor }); },
    async close() { await Promise.all([new Promise(r => apiServer.close(r)), new Promise(r => targetServer.close(r))]); await rm(state, { recursive: true, force: true }); } };
}
