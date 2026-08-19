import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PraesidiaAnalytics } from './analytics.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

/**
 * AUD-0063 — analytics resource coverage gate.
 *
 * `be/src/analytics/analytics.controller.ts` exposes every
 * `/organizations/{orgId}/analytics*` operation; this test derives that list
 * from `ui/swagger.json` (be's exported OpenAPI spec — the SAME file
 * `scripts/audit-api-contract.mjs` gates SDK call sites against, loaded the
 * same way: `BE_SWAGGER_PATH` env override, else this checkout's committed
 * sibling copy) and fails on any operation `PraesidiaAnalytics` does not
 * cover. A be-added 17th analytics operation therefore goes RED here
 * instead of silently missing the SDK.
 *
 * The routes under test come from `loadAnalyticsOperations()` below (real
 * swagger.json paths) — NOT from a second hand-authored route list. `COVERAGE`
 * only supplies, per REAL route, which `PraesidiaAnalytics` method is
 * supposed to satisfy it; an operation with no entry (or whose entry names a
 * method that does not exist) fails with a specific, actionable message
 * rather than a silent pass.
 */

const DEFAULT_SPEC_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../ui/swagger.json',
);
const SPEC_PATH = process.env['BE_SWAGGER_PATH']
  ? resolve(process.cwd(), process.env['BE_SWAGGER_PATH'])
  : DEFAULT_SPEC_PATH;

const ANALYTICS_PREFIX = '/organizations/{orgId}/analytics';

interface AnalyticsOperation {
  method: 'GET' | 'POST';
  /** Path with the `/organizations/{orgId}/analytics` prefix stripped; `/` for the base route. */
  suffix: string;
}

function loadAnalyticsOperations(): AnalyticsOperation[] {
  if (!existsSync(SPEC_PATH)) {
    throw new Error(
      `AUD-0063 coverage gate: no swagger.json at ${SPEC_PATH} — export one from be-core ` +
        '(npm run export:openapi) or set BE_SWAGGER_PATH. Failing closed rather than skipping.',
    );
  }
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as {
    paths?: Record<string, Record<string, unknown>>;
  };
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

type CoverageEntry =
  | { method: string; args: unknown[] }
  /** Escape hatch (DoD #1) — none used today; every known route is covered. */
  | { allow: string };

/**
 * Real-swagger-route → `PraesidiaAnalytics` method mapping. Every value here
 * is asserted to (a) exist as a callable on the class and (b) actually issue
 * a request to the matching path+method through a mocked `fetch`.
 */
const COVERAGE: Record<string, CoverageEntry> = {
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

describe('PraesidiaAnalytics coverage vs be swagger.json (AUD-0063)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const operations = loadAnalyticsOperations();

  it('be exports at least the 15 known analytics paths (sanity: the real spec loaded)', () => {
    expect(operations.length).toBeGreaterThanOrEqual(15);
  });

  it.each(operations)(
    '$method .../analytics$suffix is reachable through PraesidiaAnalytics',
    async ({ method, suffix }) => {
      const key = `${method} ${suffix}`;
      const entry = COVERAGE[key];
      if (!entry) {
        throw new Error(
          `AUD-0063: be exposes ${key} (organizations/{orgId}/analytics${suffix === '/' ? '' : suffix}) ` +
            'with no PraesidiaAnalytics coverage entry and no allow-list reason. Add a resource ' +
            'method (both SDKs) or allow-list it in COVERAGE with a stated reason.',
        );
      }
      if ('allow' in entry) return; // explicitly out of scope, reason recorded alongside

      const analytics = new PraesidiaAnalytics({ apiKey: 'pk_x', orgId: 'org-1' });
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
      expect((init.method ?? 'GET').toUpperCase()).toBe(method);

      const expectedSuffix = suffix === '/' ? '' : suffix.replace('{agentId}', 'agent-1');
      expect(new URL(rawUrl).pathname).toBe(`/organizations/org-1/analytics${expectedSuffix}`);
    },
  );
});
