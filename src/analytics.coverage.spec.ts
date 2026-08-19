import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PraesidiaAnalytics } from './analytics.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

/**
 * AUD-0063 — analytics resource coverage gate.
 *
 * `be/src/analytics/analytics.controller.ts` exposes every
 * `/organizations/{orgId}/analytics*` operation; this test derives that list
 * from be's exported OpenAPI spec and fails on any operation
 * `PraesidiaAnalytics` does not cover, so a be-added 17th analytics
 * operation goes RED here instead of silently missing the SDK.
 *
 * The routes under test come from `extractAnalyticsOperations()` below (real
 * spec paths) — NOT a second hand-authored route list. `COVERAGE` only
 * supplies, per REAL route, which `PraesidiaAnalytics` method is supposed to
 * satisfy it; an operation with no entry (or whose entry names a method that
 * does not exist) fails with a specific, actionable message.
 *
 * Close-out review (lead) — `be` is a SEPARATE git repo, never an npm
 * dependency of `sdk`: this repo must still build/test standalone for any
 * checkout without a be sibling (a bare `sdk` clone, `ci.yml`, or this
 * package's published npm tarball). The live comparison below therefore
 * SKIPS (never throws) when no spec is found, and runs for real only when
 * one is — which two concrete layouts both resolve, mirroring `mcp`'s
 * AUD-0062 gate (`trust-level-thresholds.test.ts`,
 * `.github/workflows/contract-drift.yml`) so the two SDKs and mcp solve this
 * cross-repo problem the same way, not a third variant:
 *
 *   1. Local monorepo dev checkout — `sdk` and `ui` as siblings under
 *      `core/` (`../../ui/swagger.json` from this file).
 *   2. CI: `.github/workflows/contract-drift.yml` checks this repo out to
 *      `path: sdk` and freshly exports be-core's OpenAPI spec to
 *      `../swagger.generated.json` relative to its `be-core/` checkout —
 *      i.e. the job's workspace root, `../../swagger.generated.json` from
 *      this file. That job now ALSO runs this spec file (see its "AUD-0063"
 *      step) with the export present, so the live comparison genuinely
 *      executes — and can genuinely fail — on every PR. `ci.yml`, the
 *      workflow that runs `npm test`, checks out `sdk` alone — neither
 *      candidate exists there, so this suite SKIPS on that job specifically;
 *      expected, not a gap, because `contract-drift.yml` is the job that
 *      actually catches drift.
 *
 * `AUD_0063_REQUIRE_SWAGGER` (mirrors mcp's `AUD_0062_REQUIRE_BE_SOURCE`) —
 * set to the literal string `"true"` ONLY in contract-drift.yml's step env
 * (a job whose entire reason to exist is having a fresh be export), turns
 * "can't find a spec" from a skip into a HARD test failure. Without it, a
 * future checkout-shape change that silently broke both candidates would
 * still report the anchor test `skipped` — not failed — and this file's
 * other (unconditional, fixture-based) tests would still pass, so the job
 * would go green having never actually compared against be. Everywhere else
 * (local dev without a spec, `ci.yml`, this package's own npm tarball) the
 * var is unset, so the original standalone-safe skip is unchanged.
 *
 * contract-drift.yml's step also runs this file BY PATH, not by `-t
 * "<title>"`: `vitest run -t <pattern>` exits 0 when the pattern matches
 * zero tests (a renamed test title would silently stop gating), whereas
 * running the file by path re-runs every test in it regardless of title,
 * and `vitest run <path-that-matches-nothing>` exits 1 — a renamed/deleted
 * FILE fails loudly instead (same fix mcp applied in its own close-out
 * round 2).
 *
 * `extractAnalyticsOperations` and the per-operation coverage check
 * (`assertOperationCovered`) are unit tested against fixtures below, so the
 * extraction/comparison logic itself stays proven even when both live paths
 * are absent (skipped).
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * Relative candidates, tried in order against this file's own directory —
 * exported so the CI-layout resolution can be unit tested against fixture
 * directories (below) rather than trusted on hand-worked relative-path
 * arithmetic alone. Mirrors mcp's `BE_TRUST_SERVICE_CANDIDATES` (AUD-0062).
 */
export const ANALYTICS_SPEC_RELATIVE_CANDIDATES = [
  '../../ui/swagger.json', // 1. local monorepo dev checkout (sdk + ui siblings under core/)
  '../../swagger.generated.json', // 2. contract-drift.yml CI export (workspace root)
] as const;

/**
 * Pure path-resolution helper, factored out so the CI-layout fix can be unit
 * tested against fixture directories rather than trusted on hand-worked
 * relative-path arithmetic alone. Mirrors mcp's `findFirstExisting`.
 */
export function findFirstExisting(baseDir: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const resolved = resolve(baseDir, candidate);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

// BE_SWAGGER_PATH stays available as an explicit override (matches
// scripts/audit-api-contract.mjs's own convention) for pointing at an
// arbitrary spec without disturbing the two real checkout layouts above. A
// bad/missing override silently falls through to those — this file never
// throws on a missing spec, only skips (or, under AUD_0063_REQUIRE_SWAGGER,
// fails loudly through the anchor test below — never a silent pass).
const envOverride = process.env['BE_SWAGGER_PATH'];
const envSpecPath =
  envOverride && existsSync(resolve(process.cwd(), envOverride))
    ? resolve(process.cwd(), envOverride)
    : null;
const SPEC_PATH = envSpecPath ?? findFirstExisting(HERE, ANALYTICS_SPEC_RELATIVE_CANDIDATES);
const specAvailable = SPEC_PATH !== null;
const REQUIRE_SWAGGER = process.env['AUD_0063_REQUIRE_SWAGGER'] === 'true';

if (!specAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    '[AUD-0063] no be swagger.json found at any known path (BE_SWAGGER_PATH, ' +
      `${ANALYTICS_SPEC_RELATIVE_CANDIDATES.join(', ')} relative to src/) — live analytics-route ` +
      'coverage check ' +
      (REQUIRE_SWAGGER
        ? 'will FAIL (AUD_0063_REQUIRE_SWAGGER=true — this job must have a real spec).'
        : 'skipped so sdk can still build/test standalone. Runs for real in the local monorepo ' +
          "checkout and in contract-drift.yml's CI job, both of which have a real spec."),
  );
}

const ANALYTICS_PREFIX = '/organizations/{orgId}/analytics';

export interface AnalyticsOperation {
  method: 'GET' | 'POST';
  /** Path with the `/organizations/{orgId}/analytics` prefix stripped; `/` for the base route. */
  suffix: string;
}

/** Pure extraction, factored out so it can be unit tested against a fixture spec object below. */
export function extractAnalyticsOperations(spec: {
  paths?: Record<string, Record<string, unknown>>;
}): AnalyticsOperation[] {
  const ops: AnalyticsOperation[] = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    if (path !== ANALYTICS_PREFIX && !path.startsWith(`${ANALYTICS_PREFIX}/`)) continue;
    const suffix = path.slice(ANALYTICS_PREFIX.length) || '/';
    for (const method of Object.keys(methods)) {
      if (method === 'get' || method === 'post') {
        ops.push({ method: method.toUpperCase() as 'GET' | 'POST', suffix });
      }
    }
  }
  return ops.sort((a, b) => (a.suffix + a.method).localeCompare(b.suffix + b.method));
}

const operations: AnalyticsOperation[] = specAvailable
  ? extractAnalyticsOperations(JSON.parse(readFileSync(SPEC_PATH as string, 'utf8')))
  : [];

type CoverageEntry =
  | { method: string; args: unknown[] }
  /** Escape hatch (DoD #1) — none used today; every known route is covered. */
  | { allow: string };

/**
 * Real-swagger-route → `PraesidiaAnalytics` method mapping. Every value here
 * is asserted to (a) exist as a callable on the class and (b) actually issue
 * a request to the matching path+method through a mocked `fetch`.
 */
export const COVERAGE: Record<string, CoverageEntry> = {
  'GET /': { method: 'usage', args: [] },
  'GET /capture-state': { method: 'captureState', args: [] },
  'GET /agents/{agentId}': { method: 'agentAnalytics', args: ['agent-1'] },
  'GET /events': { method: 'events', args: [] },
  'POST /events': { method: 'recordEvent', args: [{ eventType: 'REQUEST' }] },
  'GET /activity-log': { method: 'activityLog', args: [] },
  'GET /advanced/agent-performance': { method: 'agentPerformance', args: [] },
  'GET /advanced/security': { method: 'securityMetrics', args: [] },
  'GET /advanced/cost-trends': { method: 'costTrends', args: [] },
  'GET /advanced/usage-heatmap': { method: 'usageHeatmap', args: [] },
  'GET /advanced/top-agents': { method: 'topAgents', args: [] },
  'GET /advanced/compliance': { method: 'complianceMetrics', args: [] },
  'GET /advanced/anomalies': { method: 'anomalies', args: [] },
  'GET /advanced/cost-by-team': { method: 'costByTeam', args: [] },
  'GET /export': { method: 'export', args: [] },
  'GET /advanced/model-comparison': { method: 'modelComparison', args: [] },
};

/**
 * Per-operation coverage check, factored out of the `it.each` body so a
 * fixture test below can assert it fails on a synthetic unmapped route
 * WITHOUT needing a live spec — direct proof the gate is capable of
 * failing, independent of `specAvailable`.
 */
export async function assertOperationCovered(
  analytics: PraesidiaAnalytics,
  op: AnalyticsOperation,
): Promise<void> {
  const key = `${op.method} ${op.suffix}`;
  const entry = COVERAGE[key];
  if (!entry) {
    throw new Error(
      `AUD-0063: be exposes ${key} (organizations/{orgId}/analytics${op.suffix === '/' ? '' : op.suffix}) ` +
        'with no PraesidiaAnalytics coverage entry and no allow-list reason. Add a resource ' +
        'method (both SDKs) or allow-list it in COVERAGE with a stated reason.',
    );
  }
  if ('allow' in entry) return; // explicitly out of scope, reason recorded alongside

  const fn = (analytics as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
    entry.method
  ];
  if (typeof fn !== 'function') {
    throw new Error(
      `AUD-0063: be exposes ${key} but PraesidiaAnalytics has no method "${entry.method}" yet ` +
        '(the coverage map references it — add the method to close the gap).',
    );
  }

  globalThis.fetch = makeFetchMock([{ json: {} }]);
  await fn.apply(analytics, entry.args);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);

  const [rawUrl, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    RequestInit,
  ];
  expect((init.method ?? 'GET').toUpperCase()).toBe(op.method);

  const expectedSuffix = op.suffix === '/' ? '' : op.suffix.replace('{agentId}', 'agent-1');
  expect(new URL(rawUrl).pathname).toBe(`/organizations/org-1/analytics${expectedSuffix}`);
}

describe('PraesidiaAnalytics coverage vs be swagger.json (AUD-0063)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Anchor test — carries the "this job cannot go green without genuinely
  // comparing" guarantee. Only skips when the spec is genuinely absent AND
  // this run doesn't require it; under AUD_0063_REQUIRE_SWAGGER=true
  // (contract-drift.yml) it never skips, so a broken checkout shape fails
  // this test explicitly instead of silently reporting "skipped".
  it.skipIf(!specAvailable && !REQUIRE_SWAGGER)(
    'be swagger.json is available and exports at least the 15 known analytics paths',
    () => {
      if (!specAvailable) {
        throw new Error(
          'AUD_0063_REQUIRE_SWAGGER=true but no swagger.json was found at any known path ' +
            `(${ANALYTICS_SPEC_RELATIVE_CANDIDATES.join(', ')} relative to src/) — this job's only ` +
            'reason to exist is comparing against a real be-core export; failing loudly instead ' +
            'of silently skipping.',
        );
      }
      expect(operations.length).toBeGreaterThanOrEqual(15);
    },
  );

  it.each(operations)(
    '$method .../analytics$suffix is reachable through PraesidiaAnalytics',
    async (op) => {
      const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
      await assertOperationCovered(analytics, op);
    },
  );
});

// ── Fixture-based proofs — ALWAYS run, independent of live spec
// availability, so the extraction + comparison logic itself is proven even
// when both `specAvailable` paths are absent (mirrors mcp's AUD-0062
// `parseBeLevelThresholds`/`findFirstExisting` fixture tests).

describe('extractAnalyticsOperations — fixture parsing', () => {
  it('extracts every analytics GET/POST operation and ignores unrelated paths', () => {
    const fixtureSpec = {
      paths: {
        '/organizations/{orgId}/analytics': { get: {} },
        '/organizations/{orgId}/analytics/events': { get: {}, post: {} },
        '/organizations/{orgId}/analytics/advanced/anomalies': { get: {} },
        '/organizations/{orgId}/agents': { get: {} }, // unrelated — must be ignored
      },
    };
    // `.sort()` uses `localeCompare`, which is order-irrelevant for the
    // gate's actual pass/fail (each operation is checked independently) —
    // assert the same SET regardless of the exact locale-collation order.
    expect(extractAnalyticsOperations(fixtureSpec)).toEqual(
      expect.arrayContaining([
        { method: 'GET', suffix: '/' },
        { method: 'GET', suffix: '/advanced/anomalies' },
        { method: 'GET', suffix: '/events' },
        { method: 'POST', suffix: '/events' },
      ]),
    );
    expect(extractAnalyticsOperations(fixtureSpec)).toHaveLength(4);
  });
});

describe('assertOperationCovered — proves the gate can fail (no live spec required)', () => {
  it('throws on a synthetic analytics operation with no COVERAGE entry', async () => {
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    await expect(
      assertOperationCovered(analytics, { method: 'GET', suffix: '/advanced/new-thing-be-added' }),
    ).rejects.toThrow(/no PraesidiaAnalytics coverage entry/);
  });

  it('throws when a COVERAGE entry names a method PraesidiaAnalytics does not have', async () => {
    const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
    const savedEntry = COVERAGE['GET /capture-state'];
    COVERAGE['GET /capture-state'] = { method: 'thisMethodDoesNotExist', args: [] };
    try {
      await expect(
        assertOperationCovered(analytics, { method: 'GET', suffix: '/capture-state' }),
      ).rejects.toThrow(/has no method "thisMethodDoesNotExist" yet/);
    } finally {
      COVERAGE['GET /capture-state'] = savedEntry as CoverageEntry;
    }
  });
});

describe('findFirstExisting — CI-layout path resolution (same candidate list used at runtime)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the local monorepo ui/swagger.json layout when present', () => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-analytics-coverage-test-'));
    const uiSwagger = join(dir, 'ui', 'swagger.json');
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(uiSwagger, '{}');
    const sdkSrcDir = join(dir, 'sdk', 'src');
    mkdirSync(sdkSrcDir, { recursive: true });

    expect(findFirstExisting(sdkSrcDir, ANALYTICS_SPEC_RELATIVE_CANDIDATES)).toBe(uiSwagger);
  });

  it("resolves contract-drift.yml's workspace-root swagger.generated.json when ui/swagger.json is absent", () => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-analytics-coverage-test-'));
    // Mirrors contract-drift.yml's real checkout shape: sdk + be-core +
    // shared as siblings under one workspace root, with the freshly
    // exported spec landing at that same workspace root — not a `ui/` dir.
    const generated = join(dir, 'swagger.generated.json');
    writeFileSync(generated, '{}');
    const sdkSrcDir = join(dir, 'sdk', 'src');
    mkdirSync(sdkSrcDir, { recursive: true });

    expect(findFirstExisting(sdkSrcDir, ANALYTICS_SPEC_RELATIVE_CANDIDATES)).toBe(generated);
  });

  it('returns null when neither layout is present (proves the standalone skip is real)', () => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-analytics-coverage-test-'));
    const sdkSrcDir = join(dir, 'sdk', 'src');
    mkdirSync(sdkSrcDir, { recursive: true });

    expect(findFirstExisting(sdkSrcDir, ANALYTICS_SPEC_RELATIVE_CANDIDATES)).toBeNull();
  });
});
