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

  it('passes the full offline selfcheck (approval id is the Stripe Idempotency-Key)', async () => {
    await expect(selfcheck(sdk)).resolves.toBeUndefined();
  });
});
