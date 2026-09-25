// SDK-0328 — examples/refund-authorization against this checkout's src (the
// example's own selfcheck.mjs runs the same checks against the installed tarball).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

  // SDK-0341 — the package's verification.txt says where the rooted evidence ends (be
  // audit-package.service.ts buildVerificationTxt); the job response carries no window.
  describe('audit package coverage and verify command', () => {
    let dir;
    beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'refund-spec-')); });
    afterAll(() => rm(dir, { recursive: true, force: true }));
    const approvedRun = async (pkg, extra = {}, env = {}) => {
      const fake = fakeFetch(['allow'], 200, 403, pkg);
      const lines = [];
      const code = await runWith(sdk, fake, { ...VALID_ENV, AUDIT_PACKAGE_FILE: join(dir, 'p.zip'), ...env },
        { log: (l) => lines.push(l), sleep: async () => {}, ...extra });
      return { code, lines, fake, verify: lines.find((l) => l.startsWith('verify offline: ')) };
    };
    const PAST = '2026-01-01T00:00:00.000Z';
    const FUTURE = '2999-01-01T00:00:00.000Z';
    // A frozen clock pins refundedAt, so the boundaries below are exact. be cuts rows at
    // `signedAt < to` and clamps effectiveTo to min(to, rooted end): a rooted hour answers
    // effectiveTo === its end, never later.
    const NOW = Date.parse('2026-09-25T10:17:00.000Z');
    const HOUR = 3_600_000;
    const HOUR_END = new Date(Math.floor(NOW / HOUR) * HOUR + HOUR).toISOString(); // as refund.mjs computes it
    const frozen = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); };
    afterEach(() => vi.useRealTimers());
    const bundles = (calls) => calls.filter((c) => new URL(c.url).pathname.endsWith('/audit/bundle'));

    it('says the refund is not yet covered when the clamp ends before it', async () => {
      const { code, lines } = await approvedRun({ to: PAST, clampReason: 'clamped_to_last_rooted_hour' });
      expect(code).toBe(EXIT.OK);
      const line = lines.find((l) => l.startsWith('refund not yet covered: '));
      expect(line).toContain(`ends at ${PAST} (clamp clamped_to_last_rooted_hour)`);
      expect(line).toMatch(/once the hour ending \d{4}-\d\d-\d\dT\d\d:00:00\.000Z is Merkle-rooted/);
      expect(lines.some((l) => l.startsWith('refund covered: '))).toBe(false);
    });

    it('says the refund is covered when the rooted window ends after it', async () => {
      const { lines } = await approvedRun({ to: FUTURE, clampReason: 'none' });
      expect(lines.find((l) => l.startsWith('refund covered: '))).toContain(`ends at ${FUTURE} (clamp none)`);
      expect(lines.some((l) => l.startsWith('refund not yet covered: '))).toBe(false);
    });

    it('a window ending exactly at the refund does not cover it (the end is exclusive)', async () => {
      frozen();
      const { lines } = await approvedRun({ to: new Date(NOW).toISOString(), clampReason: 'clamped_to_last_rooted_hour' });
      expect(lines.some((l) => l.startsWith('refund not yet covered: '))).toBe(true);
      const after = await approvedRun({ to: new Date(NOW + 1).toISOString(), clampReason: 'clamped_to_last_rooted_hour' });
      expect(after.lines.some((l) => l.startsWith('refund covered: '))).toBe(true);
    });

    it('treats an unknown clamp reason as not yet covered', async () => {
      const { lines } = await approvedRun({ to: FUTURE, clampReason: 'include_unrooted' });
      expect(lines.find((l) => l.startsWith('refund not yet covered: '))).toContain('unknown clamp reason include_unrooted');
    });

    it('knows clamped_to_unrooted_gap (BE-1638): covered after the refund, plainly not yet covered before it', async () => {
      const after = await approvedRun({ to: FUTURE, clampReason: 'clamped_to_unrooted_gap' });
      expect(after.lines.find((l) => l.startsWith('refund covered: '))).toContain(`ends at ${FUTURE} (clamp clamped_to_unrooted_gap)`);
      const before = await approvedRun({ to: PAST, clampReason: 'clamped_to_unrooted_gap' });
      expect(before.lines.find((l) => l.startsWith('refund not yet covered: '))).toContain(`ends at ${PAST} (clamp clamped_to_unrooted_gap);`);
    });

    it('prints the verify command with the platform key flags, placeholders unless configured', async () => {
      const { verify, lines } = await approvedRun();
      expect(verify).toBe(`verify offline: npx @praesidia/audit-verifier ${join(dir, 'p.zip')} --platform-key <platform-key.pem> --platform-key-fingerprint <sha256hex> --summary`);
      expect(lines.some((l) => l.startsWith('platform key: '))).toBe(true);
      const set = await approvedRun({}, {}, { PRAESIDIA_PLATFORM_KEY_FILE: './k.pem', PRAESIDIA_PLATFORM_KEY_FINGERPRINT: 'ab'.repeat(32) });
      expect(set.verify).toContain(`--platform-key ./k.pem --platform-key-fingerprint ${'ab'.repeat(32)} --summary`);
      expect(set.lines.some((l) => l.startsWith('platform key: '))).toBe(false);
      for (const only of [{ PRAESIDIA_PLATFORM_KEY_FILE: './k.pem' }, { PRAESIDIA_PLATFORM_KEY_FINGERPRINT: 'ab'.repeat(32) }]) {
        const half = await approvedRun({}, {}, only);
        expect(half.lines.some((l) => l.startsWith('platform key: '))).toBe(true);
      }
    });

    it('--wait-rooted polls the refund hour until it is rooted, then requests the package', async () => {
      frozen();
      const { lines, fake } = await approvedRun({ to: HOUR_END, clampReason: 'none', effectiveTo: [PAST, HOUR_END] }, { argv: ['--wait-rooted'] });
      const probes = bundles(fake.calls);
      expect(probes).toHaveLength(2);
      const q = new URL(probes[0].url).searchParams;
      expect(q.get('to')).toBe(HOUR_END);
      expect(Date.parse(q.get('to')) - Date.parse(q.get('from'))).toBe(HOUR);
      expect(fake.calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/audit/packages')))
        .toBeGreaterThan(fake.calls.indexOf(probes[1]));
      expect(lines).toContain(`--wait-rooted: rooted through ${HOUR_END}`);
      expect(lines.some((l) => l.startsWith('refund covered: '))).toBe(true);
    });

    it('--wait-rooted gives up after a bounded number of polls', async () => {
      const { code, lines, fake } = await approvedRun({ effectiveTo: [PAST] }, { argv: ['--wait-rooted'] });
      expect(code).toBe(EXIT.OK);
      expect(bundles(fake.calls)).toHaveLength(41);
      expect(lines).toContain('--wait-rooted: not rooted after 80 min; requesting the package anyway');
      expect(lines.some((l) => l.startsWith('refund not yet covered: '))).toBe(true);
    });

    it('does not probe bundles without --wait-rooted', async () => {
      const { fake } = await approvedRun();
      expect(bundles(fake.calls)).toHaveLength(0);
    });
  });

  it('passes the full offline selfcheck (approval id is the Stripe Idempotency-Key)', async () => {
    await expect(selfcheck(sdk)).resolves.toBeUndefined();
  });
});
