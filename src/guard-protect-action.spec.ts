import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaGuard } from './guard.js';
import {
  PraesidiaApiError,
  PraesidiaConfigError,
  ProtectedActionDeniedError,
  UnsupportedProtectedActionTargetError,
} from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

const config = {
  apiKey: 'pk_test_key',
  orgId: 'org-uuid-123',
  agentId: 'agent-uuid-456',
};

const CALL_PATH =
  '/organizations/org-uuid-123/mcp-servers/srv-1/tools/search/call';

describe('PA01 DX-001 — guard.protectAction', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws UnsupportedProtectedActionTargetError for a non-mcp protocol, before any network call', async () => {
    const guard = new PraesidiaGuard(config);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      guard.protectAction({
        // @ts-expect-error — deliberately an unsupported protocol
        target: { protocol: 'http', mcpServerId: 'x', toolName: 'y' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedProtectedActionTargetError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws PraesidiaConfigError in local/offline mode — no silent fallback', async () => {
    const guard = new PraesidiaGuard({ apiKey: undefined, orgId: undefined });
    await expect(
      guard.protectAction({
        target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
      }),
    ).rejects.toBeInstanceOf(PraesidiaConfigError);
  });

  it('resolves with the dispatch result on success and sends the correct route/body', async () => {
    const guard = new PraesidiaGuard(config);
    globalThis.fetch = makeFetchMock([
      {
        json: {
          success: true,
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          latencyMs: 12,
        },
      },
    ]);

    const result = await guard.protectAction({
      target: {
        protocol: 'mcp',
        mcpServerId: 'srv-1',
        toolName: 'search',
        arguments: { q: 'quarterly filings' },
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.actionId).toBeUndefined();

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(`https://api.praesidia.ai${CALL_PATH}`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      toolName: 'search',
      arguments: { q: 'quarterly filings' },
    });
  });

  // PA-0026 — these are the tests that would have caught the original
  // heuristic bug: it decided "pre-dispatch denial?" via
  // `errorCode !== 'TOOL_ERROR'`, but `'TOOL_ERROR'` is never present in
  // this endpoint's caller-visible response at all (it only exists in `be`'s
  // internal forensic write). Both cases below satisfy that old heuristic's
  // "throw" branch and would have wrongly raised ProtectedActionDeniedError.
  it('does NOT throw when a successful call´s tool itself reports failure (isError:true, no errorCode, no actionDenyReason)', async () => {
    const guard = new PraesidiaGuard(config);
    globalThis.fetch = makeFetchMock([
      {
        json: {
          success: false,
          content: [],
          isError: true,
          latencyMs: 5,
          error: 'downstream tool failed',
          // be sends NO errorCode at all for this case — verified by
          // tracing mcp-client.service.ts's success-with-tool-error return
          // site (PA01-FIXED-be3.md "Design decision 2").
        },
      },
    ]);

    const result = await guard.protectAction({
      target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
    });
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('does NOT throw on a genuine downstream tool/transport exception (errorCode BAD_REQUEST, no actionDenyReason)', async () => {
    const guard = new PraesidiaGuard(config);
    globalThis.fetch = makeFetchMock([
      {
        json: {
          success: false,
          content: [],
          isError: true,
          latencyMs: 5,
          error: 'downstream tool threw',
          errorCode: 'BAD_REQUEST',
        },
      },
    ]);

    const result = await guard.protectAction({
      target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
    });
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('does NOT throw on a genuine downstream transport exception (errorCode INTERNAL_ERROR, no actionDenyReason)', async () => {
    const guard = new PraesidiaGuard(config);
    globalThis.fetch = makeFetchMock([
      {
        json: {
          success: false,
          content: [],
          isError: true,
          latencyMs: 5,
          error: 'transport failure',
          errorCode: 'INTERNAL_ERROR',
        },
      },
    ]);

    const result = await guard.protectAction({
      target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
    });
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
  });

  it.each([
    ['PERMIT_MISSING', 'no Permit presented (X-Praesidia-Permit missing)'],
    ['PERMIT_INVALID', 'Permit signature invalid'],
    ['PERMIT_EXPIRED', 'Permit expired'],
    ['PERMIT_MISMATCH', 'Permit commitment mismatch'],
    ['PERMIT_REPLAYED', 'Permit already consumed (replay suppressed)'],
    ['POLICY_DENIED', 'denied by agent tool policy'],
  ] as const)(
    'throws ProtectedActionDeniedError with actionDenyReason %s (the reliable discriminator, PA-0026)',
    async (actionDenyReason, message) => {
      const guard = new PraesidiaGuard(config);
      globalThis.fetch = makeFetchMock([
        {
          json: {
            success: false,
            content: [],
            isError: true,
            latencyMs: 0,
            error: `Tool "search" denied: ${message}`,
            errorCode: `PERMIT_${actionDenyReason}`,
            actionDenyReason,
          },
        },
      ]);

      const err: ProtectedActionDeniedError = await guard
        .protectAction({
          target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ProtectedActionDeniedError);
      expect(err.actionDenyReason).toBe(actionDenyReason);
    },
  );

  it('propagates PraesidiaApiError unchanged for an HTTP-level denial (RBAC/ABAC gates)', async () => {
    const guard = new PraesidiaGuard(config);
    globalThis.fetch = makeFetchMock([{ ok: false, status: 403, text: 'ABAC denied' }]);

    await expect(
      guard.protectAction({
        target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
      }),
    ).rejects.toBeInstanceOf(PraesidiaApiError);
  });

  it('sends the Permit on X-Praesidia-Permit, distinct from X-Praesidia-Capability-Token', async () => {
    const guard = new PraesidiaGuard(config);
    globalThis.fetch = makeFetchMock([
      { json: { success: true, content: [], latencyMs: 1 } },
    ]);

    await guard.protectAction({
      target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
      permit: 'permit.jwt.token',
      capabilityToken: 'capability.jwt.token',
    });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Praesidia-Permit']).toBe('permit.jwt.token');
    expect(headers['X-Praesidia-Capability-Token']).toBe('capability.jwt.token');
  });
});
