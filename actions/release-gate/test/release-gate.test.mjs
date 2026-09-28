// node --test actions/release-gate/test — runs release-gate.sh against a
// loopback mock (no network). Covers pass, fail, 401, malformed + edges.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, KEY } from './mock-server.mjs';

const SCRIPT = fileURLToPath(new URL('../release-gate.sh', import.meta.url));
let mock;
before(async () => (mock = await startMock()));
after(() => mock.close());

async function gate(evalRunId, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-gate-'));
  const output = join(dir, 'out');
  writeFileSync(output, '');
  mock.requests.length = 0;
  const child = spawn('bash', [SCRIPT], {
    env: {
      PATH: process.env.PATH, GITHUB_OUTPUT: output,
      PRAESIDIA_API_URL: `${mock.url}/`, PRAESIDIA_API_KEY: KEY,
      PRAESIDIA_ORG_ID: 'org-1', PRAESIDIA_AI_SYSTEM_ID: 'sys-1',
      PRAESIDIA_EVAL_RUN_ID: evalRunId, PRAESIDIA_TIMEOUT: '10', ...extra,
    },
  });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  const code = await new Promise((resolve) => child.on('close', resolve));
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  return { code, log, outputs, requests: [...mock.requests] };
}

test('pass: exits 0, posts the EvaluateQualityGateDto body with the bearer key', async () => {
  const r = await gate('pass');
  assert.equal(r.code, 0, r.log);
  assert.equal(r.outputs.verdict, 'pass');
  assert.equal(r.outputs['report-url'], '');
  assert.equal(r.requests.length, 1);
  const [req] = r.requests;
  assert.equal(req.url, '/organizations/org-1/ai-systems/sys-1/quality-gate/evaluate');
  assert.deepEqual(JSON.parse(req.body), { evalRunId: 'pass' });
  assert.equal(req.headers['content-type'], 'application/json');
  assert.match(r.log, new RegExp(`::add-mask::${KEY}`));
});

test('fail verdict: exits non-zero with verdict=fail', async () => {
  const r = await gate('fail');
  assert.notEqual(r.code, 0);
  assert.equal(r.outputs.verdict, 'fail');
  assert.match(r.log, /::error::.*effectiveResult=fail/);
});

test('401: fails closed and never reads a verdict', async () => {
  const r = await gate('pass', { PRAESIDIA_API_KEY: 'pra_wrong' });
  assert.notEqual(r.code, 0);
  assert.match(r.log, /HTTP 401/);
  assert.equal(r.outputs.verdict, undefined);
});

test('malformed JSON: fails closed', async () => {
  const r = await gate('malformed');
  assert.notEqual(r.code, 0);
  assert.match(r.log, /unparsable JSON/);
});

test('409 and missing verdict both fail closed', async () => {
  assert.match((await gate('conflict')).log, /HTTP 409/);
  const r = await gate('noverdict');
  assert.notEqual(r.code, 0);
  assert.match(r.log, /no recognised effectiveResult/);
});

test('unreachable API fails closed', async () => {
  const r = await gate('pass', { PRAESIDIA_API_URL: 'http://127.0.0.1:1' });
  assert.notEqual(r.code, 0);
  assert.match(r.log, /HTTP 000/);
});

test('advisory_fail passes with a warning; reportUrl and commitSha flow through', async () => {
  const sha = 'a'.repeat(40);
  const a = await gate('advisory', { PRAESIDIA_COMMIT_SHA: sha });
  assert.equal(a.code, 0, a.log);
  assert.match(a.log, /::warning::/);
  assert.deepEqual(JSON.parse(a.requests[0].body), { evalRunId: 'advisory', commitSha: sha });
  assert.equal((await gate('report')).outputs['report-url'], 'https://app.example/r/e1');
});

test('aibom-path: imports the BOM verbatim before gating', async () => {
  const bom = join(mkdtempSync(join(tmpdir(), 'bom-')), 'bom.json');
  const doc = '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[]}';
  writeFileSync(bom, doc);
  const r = await gate('pass', { PRAESIDIA_AIBOM_PATH: bom });
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(r.requests.map((q) => q.url), [
    '/organizations/org-1/ai-systems/sys-1/aibom/import',
    '/organizations/org-1/ai-systems/sys-1/quality-gate/evaluate',
  ]);
  assert.equal(r.requests[0].body, doc);
  assert.notEqual((await gate('pass', { PRAESIDIA_AIBOM_PATH: '/nonexistent.json' })).code, 0);
});

test('the API key never reaches curl argv', async () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /curl[^\n]*PRAESIDIA_API_KEY/);
});
