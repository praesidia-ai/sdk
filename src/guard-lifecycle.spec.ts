import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaGuard } from './guard.js';
import { GuardrailBlockedError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

const config = {
  apiKey: 'pk_test_key',
  orgId: 'org-uuid-123',
  agentId: 'agent-uuid-456',
  // AUDIT-SDK-02 — required to submit a CreateAgentTaskDto-valid task.
  connectionId: '00000000-0000-4000-8000-000000000c01',
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
    globalThis.fetch = makeFetchMock([{ ok: true, body: BLOCK }]);
    const guard = new PraesidiaGuard(config);
    await expect(guard.guardInput('My SSN is ...')).rejects.toThrow(
      GuardrailBlockedError,
    );
  });

  it('guardInput returns the CheckResult when the input passes', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: PASS }]);
    const guard = new PraesidiaGuard(config);
    const result = await guard.guardInput('hello');
    expect(result.passed).toBe(true);
  });

  it('guardOutput is fail-open by default (returns block, does not throw)', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: BLOCK }]);
    const guard = new PraesidiaGuard(config);
    const result = await guard.guardOutput('leaky output');
    expect(result.passed).toBe(false);
    expect(result.triggered).toHaveLength(1);
  });

  it('guardOutput throws when throwOnBlock is set', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: BLOCK }]);
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
    globalThis.fetch = makeFetchMock([{ ok: true, status: 201, body: TASK }]);

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
    // AUDIT-SDK-02 — CreateAgentTaskDto-valid body: connectionId + type +
    // non-empty input OBJECT. The SDK's telemetry is preserved as NESTED keys
    // under `input` (they are not top-level DTO fields).
    expect(body.connectionId).toBe('00000000-0000-4000-8000-000000000c01');
    expect(body.type).toBe('MESSAGE');
    expect(body.input.message).toBe('hi');
    expect(body.input.output).toBe('there');
    expect(body.input.taskType).toBe('chat');
    expect(body.input.status).toBe('completed');
    expect(body.input.usage).toEqual({ totalTokens: 42 });
    // startedAt captured at begin(), completedAt at complete().
    expect(body.input.startedAt).toBeTruthy();
    expect(body.input.completedAt).toBeTruthy();
  });

  it('fail() records one failed task row with the error message as output', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, status: 201, body: TASK }]);

    const guard = new PraesidiaGuard(config);
    const task = guard.beginTask({ input: 'do a thing' });
    await task.fail(new Error('model timeout'));

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.input.status).toBe('failed');
    expect(body.input.output).toBe('model timeout');
  });

  it('forwards chainId on the lifecycle task body', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, status: 201, body: TASK }]);

    // AUDIT-SDK-02 — CreateAgentTaskDto.chainId is @IsUUID; use a real UUID.
    const CHAIN_UUID = '22222222-2222-4222-8222-222222222222';
    const guard = new PraesidiaGuard(config);
    const task = guard.beginTask({ input: 'hi', chainId: CHAIN_UUID });
    await task.complete('ok');

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.chainId).toBe(CHAIN_UUID);
  });
});
