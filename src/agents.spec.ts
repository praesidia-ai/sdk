import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaAgents } from './agents.js';
import { PraesidiaGuard } from './guard.js';
import { PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PraesidiaAgents', () => {
  // ── Construction ──────────────────────────────────────────────────────────

  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(
      () => new PraesidiaAgents({ apiKey: undefined, orgId: undefined }),
    ).toThrow(PraesidiaConfigError);
  });
});

describe('PraesidiaGuard.refreshCredential', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('swaps the credential used on subsequent guarded calls', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, body: { passed: true, triggered: [], processingTimeMs: 1 } },
    ]);

    const guard = new PraesidiaGuard({
      apiKey: 'pk_old',
      orgId: 'org-uuid-123',
    });
    guard.refreshCredential('pk_rotated');
    await guard.checkInput('hello');

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_rotated',
    );
  });

  it('throws PraesidiaConfigError in local/offline mode', () => {
    const guard = new PraesidiaGuard({ apiKey: undefined, orgId: undefined });
    expect(() => guard.refreshCredential('pk_new')).toThrow(
      PraesidiaConfigError,
    );
  });
});
