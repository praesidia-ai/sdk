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

  it('does NOT throw when the tool itself reports failure (errorCode TOOL_ERROR)', async () => {
    const guard = new PraesidiaGuard(config);
    globalThis.fetch = makeFetchMock([
      {
        json: {
          success: false,
          content: [],
          isError: true,
          latencyMs: 5,
          error: 'downstream tool failed',
          errorCode: 'TOOL_ERROR',
        },
      },
    ]);

    const result = await guard.protectAction({
      target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
    });
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('throws ProtectedActionDeniedError on a Proof Edge permit denial (200 body, success:false)', async () => {
    const guard = new PraesidiaGuard(config);
    globalThis.fetch = makeFetchMock([
      {
        json: {
          success: false,
          content: [],
          isError: true,
          latencyMs: 0,
          error: 'Tool "search" denied: no Permit presented (X-Praesidia-Permit missing)',
          errorCode: 'PERMIT_MISSING',
        },
      },
    ]);

    const err: ProtectedActionDeniedError = await guard
      .protectAction({
        target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ProtectedActionDeniedError);
    expect(err.errorCode).toBe('PERMIT_MISSING');
  });

  it('throws ProtectedActionDeniedError on a confirmed replay (DUPLICATE_SUPPRESSED-mapped errorCode)', async () => {
    const guard = new PraesidiaGuard(config);
    globalThis.fetch = makeFetchMock([
      {
        json: {
          success: false,
          content: [],
          isError: true,
          latencyMs: 0,
          error: 'Tool "search" denied: Permit already consumed (replay suppressed)',
          errorCode: 'PERMIT_REPLAYED',
        },
      },
    ]);

    await expect(
      guard.protectAction({
        target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'search' },
      }),
    ).rejects.toMatchObject({
      name: 'ProtectedActionDeniedError',
      errorCode: 'PERMIT_REPLAYED',
    });
  });

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
