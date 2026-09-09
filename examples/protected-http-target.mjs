/** Local receipt target for acceptance. Run after npm run build. No production deployment. */
import { createServer } from 'node:http';
import { generateKeyPairSync, sign, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { jcsCanonicalize, jcsCommitment } from '../dist/jcs-canonical.js';
import { httpRequestCommitment, httpTargetKeyFingerprint } from '../dist/http-receipt.js';
const organizationId = process.env.PRAESIDIA_ORG_ID;
const bearerToken = process.env.TARGET_BEARER_TOKEN;
if (!organizationId || !bearerToken) throw new Error('Set PRAESIDIA_ORG_ID and TARGET_BEARER_TOKEN for this local fixture');
const port = Number(process.env.PORT ?? '5099');
const statePath = process.env.TARGET_STATE_FILE ?? '/tmp/praesidia-http-target-state.json';
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : (() => {
  const keys = generateKeyPairSync('ed25519');
  return { publicKeyPem: keys.publicKey.export({type:'spki',format:'pem'}).toString(), privateKeyPem: keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(), actions:{} };
})();
writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
const target = { targetId: 'acceptance-target', destination: `http://127.0.0.1:${port}/execute`, keyId: 'acceptance-key', publicKeyPem: state.publicKeyPem };
const publicPinFile = process.env.TARGET_PUBLIC_PIN_FILE ?? '/tmp/praesidia-http-target-pin.json';
writeFileSync(publicPinFile, JSON.stringify(target, null, 2));
function authenticated(header) {
  const actual = Buffer.from(header ?? ''); const expected = Buffer.from(`Bearer ${bearerToken}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const server = createServer(async (req,res) => {
  if (req.method !== 'POST' || req.url !== '/execute' || !authenticated(req.headers.authorization)) { res.writeHead(403);res.end();return; }
  try {
    let text = '';
    for await (const chunk of req) {text += chunk.toString(); if (Buffer.byteLength(text) > 65536) throw new Error('Request too large');}
    const body = JSON.parse(text);
    const actionId = req.headers['x-praesidia-action-id'];
    if (typeof actionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId) || req.headers['x-praesidia-organization-id'] !== organizationId) throw new Error('Unbound action');
    const envelope = { version:'praesidia.http-request.v1', targetId:target.targetId, destination:target.destination,
      targetKeyFingerprint:httpTargetKeyFingerprint(target.publicKeyPem), method:'POST', contentType:'application/json', body };
    const requestCommitment = httpRequestCommitment(envelope);
    if (requestCommitment !== req.headers['x-praesidia-request-commitment']) throw new Error('Request commitment mismatch');
    if (state.actions[actionId]) {
      if (state.actions[actionId].receipt.statement.requestCommitment !== requestCommitment) throw new Error('Changed action replay');
      res.setHeader('content-type','application/json');res.end(JSON.stringify(state.actions[actionId]));return;
    }
    const effect = ['succeeded','partial','failed_no_effect','unknown'].includes(body.effect) ? body.effect : 'succeeded';
    const result = { recorded:true, value:body.value ?? 'acceptance-value', transactionId:actionId, effect };
    const statement = { version:'praesidia.http-receipt.v1', actionId, organizationId, targetId:target.targetId, keyId:target.keyId,
      requestCommitment, resultCommitment:jcsCommitment(result), effect, issuedAt:new Date().toISOString(), targetTransactionId:actionId };
    const reply = { result, receipt:{ statement, signature:sign(null,jcsCanonicalize(statement),state.privateKeyPem).toString('base64') } };
    state.actions[actionId] = reply;
    // Synchronous durable write precedes acknowledgment; the fixture models an effect ledger.
    writeFileSync(statePath,JSON.stringify(state),{mode:0o600,flush:true});
    if (body.simulateLostResponse === true) { req.socket.destroy();return; }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));
  } catch { res.writeHead(400);res.end(JSON.stringify({error:'Request rejected'})); }
});
server.listen(port,'127.0.0.1',() => process.stdout.write(JSON.stringify({ destination:target.destination, publicPinFile, organizationId })+'\n'));
