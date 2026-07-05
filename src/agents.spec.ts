import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaAgents } from './agents.js';
import { PraesidiaGuard } from './guard.js';
import { PraesidiaApiError, PraesidiaConfigError } from './errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchMock(
  responses: Array<{ ok: boolean; status?: number; body: unknown }>,
) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[call % responses.length];
    call++;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  });
}

const config = {
  apiKey: 'pk_test_key',
  orgId: 'org-uuid-123',
};

const ROTATED_WITH_GRACE = {
  clientId: 'ag_1a2b3c4d5e6f7a8b',
  clientSecret: 'sec_new_9f8e7d6c',
  graceEndsAt: '2026-07-05T12:34:56.000Z',
  gracePeriodSeconds: 3600,
};

const ROTATED_INSTANT = {
  clientId: 'ag_1a2b3c4d5e6f7a8b',
  clientSecret: 'sec_new_instant',
  graceEndsAt: null,
  gracePeriodSeconds: 0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PraesidiaAgents', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Construction ──────────────────────────────────────────────────────────

  it('throws PraesidiaConfigError when apiKey/orgId are missing', () => {
    expect(
      () => new PraesidiaAgents({ apiKey: undefined, orgId: undefined }),
    ).toThrow(PraesidiaConfigError);
  });

  // ── rotateClientSecret ────────────────────────────────────────────────────

  it('rotateClientSecret POSTs to the client-secret/rotate endpoint with grace', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, body: ROTATED_WITH_GRACE },
    ]) as typeof fetch;

    const agents = new PraesidiaAgents(config);
    const result = await agents.rotateClientSecret('agent-uuid-456', {
      gracePeriodSeconds: 3600,
    });

    expect(result.clientId).toBe('ag_1a2b3c4d5e6f7a8b');
    expect(result.clientSecret).toBe('sec_new_9f8e7d6c');
    expect(result.graceEndsAt).toBe('2026-07-05T12:34:56.000Z');
    expect(result.gracePeriodSeconds).toBe(3600);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain(
      '/organizations/org-uuid-123/agents/agent-uuid-456/client-secret/rotate',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ gracePeriodSeconds: 3600 });
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_test_key',
    );
  });

  it('rotateClientSecret sends an empty body for an instant (no-grace) rotation', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, body: ROTATED_INSTANT },
    ]) as typeof fetch;

    const agents = new PraesidiaAgents(config);
    const result = await agents.rotateClientSecret('agent-uuid-456');

    expect(result.graceEndsAt).toBeNull();
    expect(result.gracePeriodSeconds).toBe(0);

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('rotateClientSecret surfaces a clear error on a JIT-first 403 (Q4-05)', async () => {
    globalThis.fetch = makeFetchMock([
      {
        ok: false,
        status: 403,
        body: { message: 'Static client secrets are deprecated and disabled' },
      },
    ]) as typeof fetch;

    const agents = new PraesidiaAgents(config);
    let caught: unknown;
    try {
      await agents.rotateClientSecret('agent-uuid-456');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PraesidiaApiError);
    const apiErr = caught as PraesidiaApiError;
    expect(apiErr.status).toBe(403);
    expect(apiErr.message).toContain('JIT-first');
    expect(apiErr.message).toContain('capability tokens');
  });

  it('rotateClientSecret passes through non-403 errors unchanged', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: false, status: 500, body: { message: 'boom' } },
    ]) as typeof fetch;

    const agents = new PraesidiaAgents(config);
    await expect(agents.rotateClientSecret('agent-uuid-456')).rejects.toThrow(
      PraesidiaApiError,
    );
  });

  it('rotateClientSecret url-encodes the agent id', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, body: ROTATED_INSTANT },
    ]) as typeof fetch;

    const agents = new PraesidiaAgents(config);
    await agents.rotateClientSecret('agent/../evil');

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string];
    expect(url).toContain('agent%2F..%2Fevil');
  });

  // ── refreshCredential ─────────────────────────────────────────────────────

  it('refreshCredential swaps the credential used on subsequent requests', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, body: ROTATED_WITH_GRACE },
      { ok: true, body: ROTATED_INSTANT },
    ]) as typeof fetch;

    const agents = new PraesidiaAgents(config);
    const rotated = await agents.rotateClientSecret('agent-uuid-456', {
      gracePeriodSeconds: 3600,
    });

    // Adopt the freshly minted secret in-process.
    agents.refreshCredential(rotated.clientSecret);
    await agents.rotateClientSecret('agent-uuid-456');

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      RequestInit,
    ][];
    expect((calls[0][1].headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_test_key',
    );
    expect((calls[1][1].headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sec_new_9f8e7d6c',
    );
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
    ]) as typeof fetch;

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
