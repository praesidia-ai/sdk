import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaGuard } from './guard.js';
import { GuardrailBlockedError } from './errors.js';

// ---------------------------------------------------------------------------
// Helpers (mirror guard.spec.ts)
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
  agentId: 'agent-uuid-456',
};

const PASS = { passed: true, triggered: [], processingTimeMs: 1 };
const BLOCK = {
  passed: false,
  triggered: [
    {
      guardrailId: 'g-1',
      guardrailName: 'PII',
      category: 'pii',
      severity: 'HIGH',
      action: 'BLOCK',
      reason: 'ssn',
    },
  ],
  processingTimeMs: 1,
};
const TASK = { id: 'task-abc-123' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('H1-02a — identity', () => {
  it('reports the connected identity', () => {
    const guard = new PraesidiaGuard(config);
    expect(guard.identity()).toEqual({
      orgId: 'org-uuid-123',
      agentId: 'agent-uuid-456',
      baseUrl: 'https://api.praesidia.ai',
      connected: true,
    });
  });

  it('reports offline (unconnected) identity in local mode', () => {
    const guard = new PraesidiaGuard({ apiKey: undefined, orgId: undefined });
    const id = guard.identity();
    expect(id.connected).toBe(false);
    expect(id.orgId).toBeUndefined();
    expect(id.agentId).toBeUndefined();
  });
});

describe('H1-02a — guardrail pre/post hooks', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('guardInput throws GuardrailBlockedError on a block (fail-closed)', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: BLOCK }]) as typeof fetch;
    const guard = new PraesidiaGuard(config);
    await expect(guard.guardInput('My SSN is ...')).rejects.toThrow(
      GuardrailBlockedError,
    );
  });

  it('guardInput returns the CheckResult when the input passes', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: PASS }]) as typeof fetch;
    const guard = new PraesidiaGuard(config);
    const result = await guard.guardInput('hello');
    expect(result.passed).toBe(true);
  });

  it('guardOutput is fail-open by default (returns block, does not throw)', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: BLOCK }]) as typeof fetch;
    const guard = new PraesidiaGuard(config);
    const result = await guard.guardOutput('leaky output');
    expect(result.passed).toBe(false);
    expect(result.triggered).toHaveLength(1);
  });

  it('guardOutput throws when throwOnBlock is set', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: BLOCK }]) as typeof fetch;
    const guard = new PraesidiaGuard(config);
    await expect(
      guard.guardOutput('leaky output', { throwOnBlock: true }),
    ).rejects.toThrow(GuardrailBlockedError);
  });
});

describe('H1-02a — task lifecycle handle', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('complete() records exactly one task row (status completed)', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, status: 201, body: TASK },
    ]) as typeof fetch;

    const guard = new PraesidiaGuard(config);
    const task = guard.beginTask({ input: 'hi', taskType: 'chat' });
    const taskId = await task.complete('there', {
      usage: { totalTokens: 42 },
    });

    expect(taskId).toBe('task-abc-123');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain('/organizations/org-uuid-123/tasks');
    const body = JSON.parse(init.body as string);
    expect(body.status).toBe('completed');
    expect(body.input).toBe('hi');
    expect(body.output).toBe('there');
    expect(body.taskType).toBe('chat');
    expect(body.usage).toEqual({ totalTokens: 42 });
    // startedAt captured at begin(), completedAt at complete().
    expect(body.startedAt).toBeTruthy();
    expect(body.completedAt).toBeTruthy();
  });

  it('fail() records one failed task row with the error message as output', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, status: 201, body: TASK },
    ]) as typeof fetch;

    const guard = new PraesidiaGuard(config);
    const task = guard.beginTask({ input: 'do a thing' });
    await task.fail(new Error('model timeout'));

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.status).toBe('failed');
    expect(body.output).toBe('model timeout');
  });

  it('forwards chainId on the lifecycle task body', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: true, status: 201, body: TASK },
    ]) as typeof fetch;

    const guard = new PraesidiaGuard(config);
    const task = guard.beginTask({ input: 'hi', chainId: 'chain-xyz' });
    await task.complete('ok');

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.chainId).toBe('chain-xyz');
  });
});
