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

/** Answers each decision POST with the next verdict in `verdicts`; records every call. */
export function fakeFetch(verdicts, stripeStatus = 200) {
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
    // be's desired-state routes carry no @RequireKeyScope, so an org key gets 403 there.
    if (pathname.includes('/by-external-id/')) return json({ statusCode: 403, message: 'Forbidden' }, 403);
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
    if (pathname.endsWith('/download')) return new Response(new Uint8Array([80, 75, 5, 6]), { status: 200 });
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
    return await run({ env, sdk, log: () => {}, ...extra });
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
    assert.equal(await runWith(sdk, approved, env, { approvalPollIntervalMs: 1, sleep: async () => {} }), EXIT.OK);
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
