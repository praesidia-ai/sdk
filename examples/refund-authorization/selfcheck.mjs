#!/usr/bin/env node
/**
 * Offline self-check for refund.mjs: no network, no keys. It checks that
 * `@praesidia/sdk` resolves from node_modules, that bad Stripe keys are refused
 * (exit 2), that a deny exits 3 without calling Stripe, and that an approved
 * refund sends the approval id as the Stripe Idempotency-Key. Praesidia and
 * Stripe are answered by the in-process `fakeFetch` below.
 */
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, EXIT } from './refund.mjs';

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
export const VALID_ENV = Object.freeze({
  PRAESIDIA_API_KEY: 'placeholder-key',
  PRAESIDIA_ORG_ID: ID(1),
  PRAESIDIA_AGENT_ID: ID(2),
  PRAESIDIA_BASE_URL: 'https://praesidia.invalid',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  STRIPE_CHARGE_ID: 'ch_placeholder',
});

/** A STORED zip as be's ZipStreamWriter writes it (local headers are all refund.mjs reads). */
export function storedZip(entries) {
  return Buffer.concat(Object.entries(entries).flatMap(([name, text]) => {
    const [n, d, h] = [Buffer.from(name), Buffer.from(text), Buffer.alloc(30)];
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt32LE(d.length, 18);
    h.writeUInt32LE(d.length, 22);
    h.writeUInt16LE(n.length, 26);
    return [h, n, d];
  }));
}

/**
 * Answers each decision POST with the next verdict in `verdicts`; records every call.
 * `graphStatus` 403 is a key without `ai-systems:write` on the by-external-id routes.
 * `pkg.to` / `pkg.clampReason` go into the package's verification.txt; `pkg.effectiveTo`
 * answers the bundle probes' X-Praesidia-Effective-To in turn (the last one repeats).
 */
export function fakeFetch(verdicts, stripeStatus = 200, graphStatus = 403, pkg = {}) {
  const { to = '2026-01-01T00:00:00.000Z', clampReason = 'clamped_to_last_rooted_hour', effectiveTo = [] } = pkg;
  const calls = [];
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body });
    const { pathname } = new URL(url);
    if (url.startsWith('https://api.stripe.com/')) {
      return stripeStatus === 200
        ? json({ id: 're_fake', object: 'refund', status: 'succeeded' })
        : json({ error: { message: 'refused by fake Stripe' } }, stripeStatus);
    }
    if (pathname.includes('/by-external-id/')) {
      if (graphStatus !== 200) return json({ statusCode: graphStatus, message: 'Forbidden' }, graphStatus);
      const externalId = decodeURIComponent(pathname.split('/').pop());
      return json({ id: ID(7), externalId, created: true, changed: true, updatedAt: '', resource: {} });
    }
    if (pathname.endsWith('/interaction-decisions')) {
      // 'observe' = an allow without an approval, as an org still in observe mode answers.
      const next = verdicts.shift() ?? 'deny';
      const verdict = next === 'observe' ? 'allow' : next;
      const approvalId = next === 'deny' || next === 'observe' ? null : ID(3);
      const reasonCode = { allow: 'approval_consumed', deny: 'policy_denied', require_approval: 'step_up_required', observe: 'observe_step_up' }[next];
      const enforcementMode = next === 'observe' ? 'observe' : 'enforce';
      return json({ verdict, reasonCode, approvalId, policyFingerprint: 'fp', ttlSeconds: 0, enforcementMode, decisionId: ID(4) });
    }
    if (pathname.endsWith('/interaction-decisions/outcome')) return json({ approvalId: ID(3), decisionId: ID(5) });
    if (pathname.endsWith('/receipt')) return json({ decisionId: ID(4) });
    if (pathname.endsWith('/download')) {
      const receipt = `Evidence range: 2025-12-31T00:00:00.000Z .. ${to}\nRequested range end: ${new Date().toISOString()}\nRange end clamp: ${clampReason}\n`;
      return new Response(storedZip({ 'evidence/audit-bundle.zip': 'PK inner bundle', 'verification.txt': receipt }), { status: 200 });
    }
    if (pathname.endsWith('/audit/bundle')) {
      const eff = effectiveTo.length > 1 ? effectiveTo.shift() : effectiveTo[0];
      return new Response(new Uint8Array([80, 75, 5, 6]), { status: 200, headers: eff ? { 'X-Praesidia-Effective-To': eff } : {} });
    }
    if (pathname.includes('/audit/packages')) return json({ id: ID(6), status: 'done', error: null, createdAt: '', completedAt: '' });
    return json({ statusCode: 404 }, 404);
  };
  return { fetch, calls };
}

/** refund.mjs with `fake` as the global fetch (the SDK's transport and the Stripe call). */
export async function runWith(sdk, fake, env, extra = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    return await run({ env, sdk, argv: [], log: () => {}, ...extra });
  } finally {
    globalThis.fetch = real;
  }
}

export async function selfcheck(sdk) {
  const stripeCalls = (calls) => calls.filter((c) => c.url.startsWith('https://api.stripe.com/'));
  for (const key of [undefined, 'sk_live_placeholder', 'rk_test_placeholder']) {
    const fake = fakeFetch([]);
    const code = await runWith(sdk, fake, { ...VALID_ENV, STRIPE_SECRET_KEY: key });
    assert.equal(code, EXIT.CONFIG, `STRIPE_SECRET_KEY=${key} must exit 2`);
    assert.equal(fake.calls.length, 0, 'a refused run makes no call at all');
  }
  for (const name of ['PRAESIDIA_API_KEY', 'PRAESIDIA_ORG_ID', 'PRAESIDIA_AGENT_ID', 'STRIPE_CHARGE_ID']) {
    assert.equal(await runWith(sdk, fakeFetch([]), { ...VALID_ENV, [name]: '' }), EXIT.CONFIG, `empty ${name} must exit 2`);
  }

  const denied = fakeFetch(['deny']);
  assert.equal(await runWith(sdk, denied, VALID_ENV), EXIT.DENIED);
  assert.equal(stripeCalls(denied.calls).length, 0, 'a deny never reaches Stripe');

  const unapproved = fakeFetch(['observe']);
  assert.equal(await runWith(sdk, unapproved, VALID_ENV), EXIT.CONFIG, 'an allow without an approval exits 2');
  assert.equal(stripeCalls(unapproved.calls).length, 0, 'no approval, no Stripe call');

  for (const [stripeStatus, status] of [[400, 'failed_no_effect'], [502, 'unknown']]) {
    const fake = fakeFetch(['allow'], stripeStatus);
    assert.equal(await runWith(sdk, fake, VALID_ENV), EXIT.FAILED, `Stripe ${stripeStatus} exits 1`);
    const outcome = fake.calls.find((c) => c.url.endsWith('/interaction-decisions/outcome'));
    assert.equal(JSON.parse(outcome.body).status, status, `Stripe ${stripeStatus} is reported as ${status}`);
  }

  const dir = await mkdtemp(join(tmpdir(), 'refund-selfcheck-'));
  try {
    const approved = fakeFetch(['require_approval', 'allow']);
    const env = { ...VALID_ENV, AUDIT_PACKAGE_FILE: join(dir, 'audit-package.zip') };
    const lines = [];
    assert.equal(await runWith(sdk, approved, env, { approvalPollIntervalMs: 1, sleep: async () => {}, log: (l) => lines.push(l) }), EXIT.OK);
    assert.ok(lines.some((l) => l.startsWith('refund not yet covered: ')), 'a package cut before the refund says so');
    assert.ok(lines.some((l) => l.startsWith('verify offline: ') && l.includes(' --platform-key ')), 'verify command pins a platform key');
    const [refund, ...more] = stripeCalls(approved.calls);
    assert.equal(more.length, 0, 'exactly one Stripe call');
    assert.equal(refund.headers.get('idempotency-key'), ID(3), 'Idempotency-Key is the approval id');
    assert.equal(new URLSearchParams(refund.body).get('amount'), '825000', 'EUR 8,250 in cents');
    assert.ok(approved.calls.some((c) => c.url.endsWith('/interaction-decisions/outcome')), 'outcome reported');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = '@praesidia/sdk';
  const resolved = fileURLToPath(import.meta.resolve(pkg));
  assert.ok(resolved.includes(`${join('node_modules', '@praesidia', 'sdk')}`), `@praesidia/sdk resolved outside node_modules: ${resolved}`);
  await selfcheck(await import(pkg));
  console.log(`selfcheck ok: @praesidia/sdk from ${resolved}`);
}
