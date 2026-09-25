// SDK-0328 — examples/refund-authorization against this checkout's src (the
// example's own selfcheck.mjs runs the same checks against the installed tarball).
import { describe, expect, it } from 'vitest';
import * as sdk from './index.ts';
import { EXIT } from '../examples/refund-authorization/refund.mjs';
import { VALID_ENV, fakeFetch, runWith, selfcheck } from '../examples/refund-authorization/selfcheck.mjs';

const stripe = (calls) => calls.filter((c) => c.url.startsWith('https://api.stripe.com/'));

describe('examples/refund-authorization', () => {
  it.each([undefined, 'sk_live_placeholder'])('refuses STRIPE_SECRET_KEY=%s with exit 2 and no call', async (key) => {
    const fake = fakeFetch(['allow']);
    expect(await runWith(sdk, fake, { ...VALID_ENV, STRIPE_SECRET_KEY: key })).toBe(EXIT.CONFIG);
    expect(fake.calls).toHaveLength(0);
  });

  it('exits 3 on deny without calling Stripe', async () => {
    const fake = fakeFetch(['deny']);
    expect(await runWith(sdk, fake, VALID_ENV)).toBe(EXIT.DENIED);
    expect(fake.calls.some((c) => c.url.endsWith('/interaction-decisions'))).toBe(true);
    expect(stripe(fake.calls)).toHaveLength(0);
  });

  // SDK-0340 — be 3add0c3d (BE-1636): the by-external-id routes take `ai-systems:write`.
  const graphCalls = (calls) => calls.filter((c) => c.url.includes('/by-external-id/'));
  const logged = async (fake, env) => {
    const lines = [];
    await runWith(sdk, fake, env, { log: (l) => lines.push(l) });
    return lines;
  };

  it('maps the graph with the one org key (no second key)', async () => {
    const fake = fakeFetch(['deny'], 200, 200);
    const lines = await logged(fake, VALID_ENV);
    expect(graphCalls(fake.calls)).toHaveLength(3);
    for (const c of graphCalls(fake.calls)) expect(c.headers.get('authorization')).toBe(`Bearer ${VALID_ENV.PRAESIDIA_API_KEY}`);
    expect(lines).toContain('graph: agent -> Stripe edge created');
  });

  it('uses PRAESIDIA_INVENTORY_API_KEY for the graph only, when set', async () => {
    const fake = fakeFetch(['deny'], 200, 200);
    await logged(fake, { ...VALID_ENV, PRAESIDIA_INVENTORY_API_KEY: 'inventory-key' });
    for (const c of graphCalls(fake.calls)) expect(c.headers.get('authorization')).toBe('Bearer inventory-key');
    const decide = fake.calls.find((c) => c.url.endsWith('/interaction-decisions'));
    expect(decide.headers.get('authorization')).toBe(`Bearer ${VALID_ENV.PRAESIDIA_API_KEY}`);
  });

  it('on a graph 403 names the missing ai-systems:write scope and carries on', async () => {
    const fake = fakeFetch(['deny'], 200, 403);
    const lines = await logged(fake, VALID_ENV);
    const hint = lines.find((l) => l.startsWith('graph: mapping skipped (403)'));
    expect(hint).toContain('ai-systems:write');
    expect(hint).not.toMatch(/org api keys/i);
    expect(fake.calls.some((c) => c.url.endsWith('/interaction-decisions'))).toBe(true);
  });

  it('passes the full offline selfcheck (approval id is the Stripe Idempotency-Key)', async () => {
    await expect(selfcheck(sdk)).resolves.toBeUndefined();
  });
});
