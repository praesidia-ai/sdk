import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  DEFAULT_FAIL_MODES,
  INTERACTION_TYPES,
  INTERACTION_VERDICTS,
  PraesidiaInteractionHooks,
  type InteractionDecision,
  type InteractionHookResult,
  type InteractionHooksConfig,
  type InteractionType,
} from './interaction-hooks.js';
import {
  IdempotencyKeyReusedError,
  InteractionDecisionUnavailableError,
  InteractionDeniedError,
  PraesidiaApiError,
  PraesidiaConfigError,
} from './errors.js';
import { jcsCommitment } from './jcs-canonical.js';
import { toolCallContextFromTask } from './guard.js';
import { InteractionTaskNotLiveError, type InteractionDecisionRecordDetails } from './index.js';
import { makeFetchMock, mockResponse, type MockResponseInit } from './__tests__/fetch-mock.js';

// Byte-identical copy of be/test-fixtures/interaction-decision-v1.json (BE-1486).
interface FixtureCase { name: string; request: Record<string, unknown>; response: InteractionDecision }
const fixture = JSON.parse(
  readFileSync(new URL('../test-fixtures/interaction-decision-v1.json', import.meta.url), 'utf8'),
) as { orgId: string; verdicts: string[]; interactionTypes: string[]; cases: FixtureCase[] };
const byName = (name: string): FixtureCase => fixture.cases.find((c) => c.name === name)!;
const AGENT = byName('allow_by_policy').request['agentId'] as string;
const URL_ = `https://api.example/organizations/${fixture.orgId}/interaction-decisions`;
const ALLOW = byName('allow_by_policy').response;
const DENY = byName('deny_by_policy').response;
const PENDING = byName('require_approval_minted').response;
const CONSUMED = byName('approval_granted_consumed').response;

function hooks(extra: Partial<InteractionHooksConfig> = {}): PraesidiaInteractionHooks {
  return new PraesidiaInteractionHooks({
    apiKey: 'pk_test',
    orgId: fixture.orgId,
    agentId: AGENT,
    baseUrl: 'https://api.example',
    approvalPollIntervalMs: 1,
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
    ...extra,
  });
}
function stub(responses: MockResponseInit[]) {
  const f = makeFetchMock(responses);
  vi.stubGlobal('fetch', f);
  return f;
}
const sentBody = (f: ReturnType<typeof vi.fn>, i: number): string => String(f.mock.calls[i]?.[1]?.body);

type Hook = (h: PraesidiaInteractionHooks) => Promise<InteractionHookResult>;
// `fail` is the README-documented default, stated here, not read from DEFAULT_FAIL_MODES.
const HOOKS: { hook: string; fail: 'open' | 'closed'; type: InteractionType; call: Hook }[] = [
  { hook: 'beforeToolCall', fail: 'open', type: 'model_to_tool', call: (h) => h.beforeToolCall({ toolName: 'search.web', arguments: { q: 'x' } }) },
  { hook: 'beforeExec', fail: 'closed', type: 'agent_to_shell', call: (h) => h.beforeExec({ command: 'rm -rf /srv' }) },
  { hook: 'beforeFsAccess(read)', fail: 'open', type: 'agent_to_filesystem', call: (h) => h.beforeFsAccess({ path: '/srv/reports/q3.csv', mode: 'read' }) },
  { hook: 'beforeFsAccess(write)', fail: 'closed', type: 'agent_to_filesystem', call: (h) => h.beforeFsAccess({ path: '/srv/x', mode: 'write' }) },
  { hook: 'beforeBrowserAction', fail: 'open', type: 'agent_to_browser', call: (h) => h.beforeBrowserAction({ action: 'navigate', url: 'https://example.com' }) },
];

afterEach(() => vi.unstubAllGlobals());

describe('interaction-decision contract (BE-1486 fixture)', () => {
  it('enums equal the recorded fixture', () => {
    expect([...INTERACTION_TYPES]).toEqual(fixture.interactionTypes);
    expect([...INTERACTION_VERDICTS]).toEqual(fixture.verdicts);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s: decide() sends the recorded request and returns the recorded response', async (_n, c) => {
    const f = stub([{ json: c.response }]);
    const { interactionType, action, approvalId } = c.request as { interactionType: InteractionType; action: { name: string; arguments?: Record<string, never> }; approvalId?: string };
    await expect(hooks().decide(interactionType, action, approvalId)).resolves.toEqual(c.response);
    expect(String(f.mock.calls[0]?.[0])).toBe(URL_);
    expect(f.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(sentBody(f, 0)).toBe(JSON.stringify(c.request));
  });

  it.each([
    ['fsAccess read', 'allow_by_policy', (h: PraesidiaInteractionHooks) => h.beforeFsAccess({ path: '/srv/reports/q3.csv', mode: 'read' })],
    ['exec', 'deny_by_policy', (h: PraesidiaInteractionHooks) => h.beforeExec({ command: 'rm -rf /srv' })],
    ['browser', 'deny_no_policy_matched', (h: PraesidiaInteractionHooks) => h.beforeBrowserAction({ action: 'navigate', url: 'https://example.com' })],
  ] as const)('%s hook body is byte-identical to fixture %s', async (_h, name, call) => {
    const f = stub([{ json: byName(name).response }]);
    await call(hooks()).catch(() => undefined);
    expect(sentBody(f, 0)).toBe(JSON.stringify(byName(name).request));
  });
});

describe.each(HOOKS)('$hook', ({ fail, type, call }) => {
  it('allow passes through with the decision', async () => {
    const f = stub([{ json: ALLOW }]);
    await expect(call(hooks())).resolves.toEqual({ decision: ALLOW });
    expect(JSON.parse(sentBody(f, 0)).interactionType).toBe(type);
  });

  it('deny throws InteractionDeniedError', async () => {
    stub([{ json: DENY }]);
    const err = await call(hooks()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InteractionDeniedError);
    expect(err).toMatchObject({ interactionType: type, reasonCode: 'denied_by_policy', decision: DENY });
  });

  it('require_approval blocks until the approval resolves, echoing approvalId', async () => {
    let approved = false;
    const f = vi.fn(async () => mockResponse({ json: approved ? CONSUMED : PENDING }));
    vi.stubGlobal('fetch', f);
    const onApprovalRequired = vi.fn();
    let settled = false;
    const pending = call(hooks({ onApprovalRequired })).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(onApprovalRequired).toHaveBeenCalledWith(PENDING);
    approved = true;
    await expect(pending).resolves.toEqual({ decision: CONSUMED });
    expect(JSON.parse(sentBody(f, f.mock.calls.length - 1)).approvalId).toBe(PENDING.approvalId);
  });

  it(`decision-API outage → documented fail-${fail}`, async () => {
    const outage = new TypeError('fetch failed');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(outage));
    const result = call(hooks());
    if (fail === 'closed') {
      await expect(result).rejects.toBeInstanceOf(InteractionDecisionUnavailableError);
    } else {
      await expect(result).resolves.toEqual({ decision: null, failOpenError: outage });
    }
  });
});

describe('fail modes', () => {
  it('defaults: fail-closed for exec and fs writes only', () => {
    expect(DEFAULT_FAIL_MODES).toEqual({ toolCall: 'open', exec: 'closed', fsRead: 'open', fsWrite: 'closed', browser: 'open' });
  });

  it.each([[{ status: 503, text: 'down' }], [{ json: { verdict: 'maybe' } }], [{ text: 'not json' }]])(
    'fail-closed exec treats %j as an outage', async (res) => {
      stub([res]);
      await expect(hooks().beforeExec({ command: 'ls' })).rejects.toBeInstanceOf(InteractionDecisionUnavailableError);
    });

  // SDK-0352 — same degrade predicate as the guard (SDK-0348): a 429 is caller-triggerable
  // (shared egress IP), so it must never open a fail-open hook; a 503 still degrades.
  it.each(['open', 'closed'] as const)('a 429 throws PraesidiaApiError on a fail-%s hook', async (mode) => {
    stub([{ status: 429, text: 'slow' }]);
    const err = await hooks({ failMode: { toolCall: mode } }).beforeToolCall({ toolName: 'search.web', arguments: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect(err).toMatchObject({ status: 429 });
  });

  it('a 503 degrades a fail-open hook', async () => {
    stub([{ status: 503, text: 'down' }]);
    const res = await hooks().beforeToolCall({ toolName: 'search.web', arguments: {} });
    expect(res.decision).toBeNull();
    expect(res.failOpenError).toMatchObject({ status: 503 });
  });

  it('a caller error (401) throws even on a fail-open hook', async () => {
    stub([{ status: 401, text: 'bad key' }]);
    await expect(hooks().beforeFsAccess({ path: '/a', mode: 'read' })).rejects.toBeInstanceOf(PraesidiaApiError);
  });

  it('failMode override flips a class', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    await expect(hooks({ failMode: { exec: 'open' } }).beforeExec({ command: 'ls' })).resolves.toMatchObject({ decision: null });
    await expect(hooks({ failMode: { browser: 'closed' } }).beforeBrowserAction({ action: 'click' })).rejects.toBeInstanceOf(InteractionDecisionUnavailableError);
  });

  it('beforeInteraction defaults to fail-closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    await expect(hooks().beforeInteraction('agent_to_email', { name: 'send' })).rejects.toBeInstanceOf(InteractionDecisionUnavailableError);
  });

  it('an outage while waiting for approval never allows, even fail-open', async () => {
    const f = vi.fn().mockResolvedValueOnce(mockResponse({ json: PENDING })).mockRejectedValue(new TypeError('down'));
    vi.stubGlobal('fetch', f);
    const err = await hooks({ approvalTimeoutMs: 20 }).beforeBrowserAction({ action: 'click' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'InteractionDeniedError', reasonCode: 'approval_wait_timeout' });
  });
});

describe('approval outcomes (fixture)', () => {
  const email = byName('require_approval_minted').request as { action: { name: string; arguments: Record<string, string> } };
  it('granted: the re-POST is the recorded approval_granted_consumed request', async () => {
    const f = stub([{ json: PENDING }, { json: CONSUMED }]);
    await expect(hooks().beforeInteraction('agent_to_email', email.action)).resolves.toEqual({ decision: CONSUMED });
    expect(sentBody(f, 1)).toBe(JSON.stringify(byName('approval_granted_consumed').request));
  });
  it('rejected: throws approval_rejected', async () => {
    stub([{ json: PENDING }, { json: byName('approval_rejected').response }]);
    await expect(hooks().beforeInteraction('agent_to_email', email.action)).rejects.toMatchObject({ reasonCode: 'approval_rejected' });
  });
});

describe('reportOutcome (BE-1582)', () => {
  const OUTCOME_URL = `${URL_}/outcome`;
  const RECEIPT = { approvalId: CONSUMED.approvalId as string, reportedDecisionId: null, decisionId: '66666666-6666-4666-8666-666666666601' };
  const email = byName('require_approval_minted').request as { action: { name: string; arguments: Record<string, string> } };

  it('a consumed allow surfaces approvalId, and the report carries a commitment, never the raw result', async () => {
    const f = stub([{ json: PENDING }, { json: CONSUMED }, { json: RECEIPT }]);
    const h = hooks();
    const { decision } = await h.beforeInteraction('agent_to_email', email.action);
    expect(decision?.reasonCode).toBe('approval_consumed');
    const approvalId = decision!.approvalId!;
    expect(approvalId).toBe(CONSUMED.approvalId);
    const result = { messageId: 'msg_secret_123', to: 'cfo@example.com' };
    await expect(h.reportOutcome({ approvalId, status: 'succeeded', result, targetSystem: 'smtp', targetTransactionId: 'tx-1' }))
      .resolves.toEqual(RECEIPT);
    expect(String(f.mock.calls[2]?.[0])).toBe(OUTCOME_URL);
    expect(f.mock.calls[2]?.[1]?.method).toBe('POST');
    const body = sentBody(f, 2);
    expect(JSON.parse(body)).toEqual({
      agentId: AGENT,
      approvalId,
      status: 'succeeded',
      resultCommitment: jcsCommitment(result),
      targetSystem: 'smtp',
      targetTransactionId: 'tx-1',
    });
    expect(body).not.toContain('msg_secret_123');
    expect(body).not.toContain('"result"');
  });

  it('no result → no resultCommitment', async () => {
    const f = stub([{ json: RECEIPT }]);
    await hooks().reportOutcome({ approvalId: RECEIPT.approvalId, status: 'failed_no_effect' });
    expect(JSON.parse(sentBody(f, 0))).toEqual({ agentId: AGENT, approvalId: RECEIPT.approvalId, status: 'failed_no_effect' });
  });

  it('409 → typed PraesidiaApiError, one request only', async () => {
    const f = stub([{ status: 409, json: { message: 'already reported' } }, { json: RECEIPT }]);
    const err = await hooks().reportOutcome({ approvalId: RECEIPT.approvalId, status: 'succeeded' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect(err).toMatchObject({ status: 409 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad status or missing approvalId before any request', async () => {
    const f = stub([{ json: RECEIPT }]);
    await expect(hooks().reportOutcome({ approvalId: RECEIPT.approvalId, status: 'done' as never })).rejects.toBeInstanceOf(PraesidiaConfigError);
    await expect(hooks().reportOutcome({ approvalId: '', status: 'succeeded' })).rejects.toBeInstanceOf(PraesidiaConfigError);
    expect(f).not.toHaveBeenCalled();
  });

  it('a plain allow reports by decisionId only (BE-1808)', async () => {
    const receipt = { approvalId: null, reportedDecisionId: ALLOW.decisionId as string, decisionId: '66666666-6666-4666-8666-666666666602' };
    const f = stub([{ json: ALLOW }, { json: receipt }]);
    const h = hooks();
    const { decision } = await h.beforeInteraction('agent_to_email', email.action);
    expect(decision?.approvalId).toBeNull();
    const r = await h.reportOutcome({ decisionId: decision!.decisionId, status: 'succeeded', targetSystem: 'smtp' });
    expect(r).toEqual(receipt);
    expect(String(f.mock.calls[1]?.[0])).toBe(OUTCOME_URL);
    expect(sentBody(f, 1)).toBe(JSON.stringify({ agentId: AGENT, decisionId: ALLOW.decisionId, status: 'succeeded', targetSystem: 'smtp' }));
  });

  it('neither, both, or an empty decisionId throws before any request', async () => {
    const f = stub([{ json: RECEIPT }]);
    const h = hooks();
    // @ts-expect-error neither key
    await expect(h.reportOutcome({ status: 'succeeded' })).rejects.toBeInstanceOf(PraesidiaConfigError);
    // @ts-expect-error both keys
    await expect(h.reportOutcome({ approvalId: RECEIPT.approvalId, decisionId: RECEIPT.decisionId, status: 'succeeded' }))
      .rejects.toBeInstanceOf(PraesidiaConfigError);
    await expect(h.reportOutcome({ decisionId: '', status: 'succeeded' })).rejects.toBeInstanceOf(PraesidiaConfigError);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('decision cache', () => {
  const read = (h: PraesidiaInteractionHooks, path = '/a') => h.beforeFsAccess({ path, mode: 'read' });
  it('reuses a verdict for ttlSeconds, including a cached deny', async () => {
    const f = stub([{ json: ALLOW }]);
    const h = hooks();
    await read(h);
    await read(h);
    expect(f).toHaveBeenCalledTimes(1);
    const g = stub([{ json: DENY }]);
    const h2 = hooks();
    await expect(read(h2)).rejects.toBeInstanceOf(InteractionDeniedError);
    await expect(read(h2)).rejects.toBeInstanceOf(InteractionDeniedError);
    expect(g).toHaveBeenCalledTimes(1);
  });
  it('ttlSeconds 0 is never cached', async () => {
    const f = stub([{ json: { ...ALLOW, ttlSeconds: 0 } }]);
    const h = hooks();
    await read(h);
    await read(h);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('a new policy fingerprint evicts every cached verdict', async () => {
    const f = stub([{ json: ALLOW }, { json: { ...ALLOW, policyFingerprint: 'f2' } }, { json: ALLOW }]);
    const h = hooks();
    await read(h, '/a');
    await read(h, '/b');
    await read(h, '/a');
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe('task envelope (BE-1609, SDK-0332)', () => {
  const TASK = '00000000-0000-4000-8000-0000000000a1';
  it('taskId from the task context rides every decision body, after approvalId', async () => {
    const f = stub([{ json: PENDING }, { json: CONSUMED }]);
    const ctx = toolCallContextFromTask({ id: TASK, chainId: null, capabilityToken: undefined, serverAgentId: AGENT });
    await hooks({ taskId: ctx.taskId }).beforeToolCall({ toolName: 'search.web' });
    expect(JSON.parse(sentBody(f, 0))).toEqual({ interactionType: 'model_to_tool', agentId: AGENT, action: { name: 'search.web' }, taskId: TASK });
    expect(sentBody(f, 1)).toBe(JSON.stringify({ interactionType: 'model_to_tool', agentId: AGENT, action: { name: 'search.web' }, approvalId: PENDING.approvalId, taskId: TASK }));
  });
  it('no taskId → no taskId key', async () => {
    const f = stub([{ json: ALLOW }]);
    await hooks().decide('model_to_tool', { name: 'search.web' });
    expect(sentBody(f, 0)).toBe(JSON.stringify({ interactionType: 'model_to_tool', agentId: AGENT, action: { name: 'search.web' } }));
  });
  it('rejects a non-UUID taskId at construction', () => {
    expect(() => hooks({ taskId: 'task-1' })).toThrow(PraesidiaConfigError);
  });
  it('surfaces constrainedBy on a delegation deny', async () => {
    stub([{ json: { ...DENY, reasonCode: 'delegation_tool_not_allowed', constrainedBy: 'delegation' } }]);
    const err = await hooks({ taskId: TASK }).beforeToolCall({ toolName: 'search.web' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InteractionDeniedError);
    expect((err as InteractionDeniedError).decision.constrainedBy).toBe('delegation');
  });
});

describe('validation', () => {
  it('rejects a bad action name before any request', async () => {
    const f = stub([{ json: ALLOW }]);
    await expect(hooks().beforeToolCall({ toolName: 'github/create issue' })).rejects.toBeInstanceOf(PraesidiaConfigError);
    expect(f).not.toHaveBeenCalled();
  });
  it('requires apiKey, orgId and agentId; rejects a bad failMode', () => {
    expect(() => new PraesidiaInteractionHooks({ apiKey: 'pk_test', orgId: fixture.orgId, agentId: '' })).toThrow(PraesidiaConfigError);
    expect(() => hooks({ failMode: { exec: 'maybe' as never } })).toThrow(PraesidiaConfigError);
  });
});

describe('Idempotency-Key (SDK-2503, BE-1759)', () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const keyOf = (f: ReturnType<typeof vi.fn>, i: number): string | undefined =>
    (f.mock.calls[i]?.[1]?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
  const RECEIPT = { approvalId: CONSUMED.approvalId as string, reportedDecisionId: null, decisionId: '66666666-6666-4666-8666-666666666601' };
  const REUSED = { status: 409, json: { statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency-Key was already used with a different request body' } };

  it('a retried decide sends the same UUID v4 key on every attempt', async () => {
    const f = stub([{ status: 503, text: 'down' }, { status: 502, text: 'down' }, { json: ALLOW }]);
    await hooks().decide('model_to_tool', { name: 'search.web' });
    expect(f).toHaveBeenCalledTimes(3);
    expect(keyOf(f, 0)).toMatch(V4);
    expect(keyOf(f, 1)).toBe(keyOf(f, 0));
    expect(keyOf(f, 2)).toBe(keyOf(f, 0));
  });

  it('a retried reportOutcome sends the same key; the key never enters the body', async () => {
    const f = stub([{ status: 503, text: 'down' }, { json: RECEIPT }]);
    await hooks().reportOutcome({ approvalId: RECEIPT.approvalId, status: 'succeeded' });
    expect(f).toHaveBeenCalledTimes(2);
    expect(keyOf(f, 0)).toMatch(V4);
    expect(keyOf(f, 1)).toBe(keyOf(f, 0));
    expect(sentBody(f, 1)).not.toContain('idempotencyKey');
  });

  it('two logical calls, and every approval poll (new body), send different keys', async () => {
    const f = stub([{ json: { ...ALLOW, ttlSeconds: 0 } }]);
    const h = hooks();
    await h.decide('model_to_tool', { name: 'search.web' });
    await h.decide('model_to_tool', { name: 'search.web' });
    expect(keyOf(f, 0)).toMatch(V4);
    expect(keyOf(f, 1)).toMatch(V4);
    expect(keyOf(f, 1)).not.toBe(keyOf(f, 0));
    const g = stub([{ json: PENDING }, { json: PENDING }, { json: CONSUMED }]);
    await hooks().beforeInteraction('agent_to_email', { name: 'send' });
    expect(new Set([0, 1, 2].map((i) => keyOf(g, i))).size).toBe(3);
  });

  it('a caller-supplied key is sent verbatim on decide and reportOutcome', async () => {
    const f = stub([{ json: ALLOW }, { json: RECEIPT }]);
    const h = hooks();
    await h.decide('model_to_tool', { name: 'search.web' }, undefined, { idempotencyKey: 'order-42:decide' });
    await h.reportOutcome({ approvalId: RECEIPT.approvalId, status: 'succeeded', idempotencyKey: 'order-42:outcome' });
    expect(keyOf(f, 0)).toBe('order-42:decide');
    expect(keyOf(f, 1)).toBe('order-42:outcome');
  });

  it.each([['x'.repeat(256)], [' padded'], ['']])('rejects key %j before any request', async (key) => {
    const f = stub([{ json: ALLOW }]);
    await expect(hooks().decide('model_to_tool', { name: 'search.web' }, undefined, { idempotencyKey: key }))
      .rejects.toBeInstanceOf(PraesidiaConfigError);
    expect(f).not.toHaveBeenCalled();
  });

  it('409 IDEMPOTENCY_KEY_REUSED raises the typed error once, with no retry', async () => {
    const f = stub([REUSED, { json: RECEIPT }]);
    const err = await hooks().reportOutcome({ approvalId: RECEIPT.approvalId, status: 'succeeded', idempotencyKey: 'k1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect(err).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED', retryable: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('409 IDEMPOTENCY_KEY_REUSED on a hook throws, never fail-opens', async () => {
    const f = stub([REUSED, { json: ALLOW }]);
    const err = await hooks().beforeToolCall({ toolName: 'search.web' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a 409 without the code stays a plain PraesidiaApiError', async () => {
    stub([{ status: 409, json: { message: 'A request with this Idempotency-Key is already in progress.' } }]);
    const err = await hooks().decide('model_to_tool', { name: 'search.web' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect(err).not.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('retry: false sends one request', async () => {
    const f = stub([{ status: 503, text: 'down' }, { json: ALLOW }]);
    await expect(hooks({ retry: false }).decide('model_to_tool', { name: 'search.web' })).rejects.toMatchObject({ status: 503 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('stale taskId (BE-2836, SDK-2800)', () => {
  const TASK = '00000000-0000-4000-8000-0000000000a1';
  // be 5bdee08a's exact 403 body: interaction-decisions.service.ts's ForbiddenException run
  // through be's global AllExceptionsFilter (no `code`, no `error`); only timestamp/requestId vary.
  const NOT_LIVE = {
    status: 403,
    json: {
      statusCode: 403,
      timestamp: '2026-10-01T12:30:10.811Z',
      path: `/organizations/${fixture.orgId}/interaction-decisions`,
      method: 'POST',
      requestId: '00000000-0000-4000-8000-0000000000ff',
      message: 'taskId is not a live task this agent executes',
    },
  };

  it('403 for a taskId that is not a live task → InteractionTaskNotLiveError, one request', async () => {
    const f = stub([NOT_LIVE, { json: ALLOW }]);
    const err = await hooks({ taskId: TASK }).decide('model_to_tool', { name: 'search.web' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InteractionTaskNotLiveError);
    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect(err).toMatchObject({ status: 403, taskId: TASK, requestId: '00000000-0000-4000-8000-0000000000ff', retryable: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a fail-open hook throws it, never fail-opens', async () => {
    stub([NOT_LIVE, { json: ALLOW }]);
    const err = await hooks({ taskId: TASK }).beforeToolCall({ toolName: 'search.web' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InteractionTaskNotLiveError);
  });

  it('any other 403 stays a plain PraesidiaApiError', async () => {
    stub([{ status: 403, json: { ...NOT_LIVE.json, message: 'Caller may not act as this agent' } }]);
    const err = await hooks({ taskId: TASK }).decide('model_to_tool', { name: 'search.web' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403 });
    expect(err).not.toBeInstanceOf(InteractionTaskNotLiveError);
  });

  it('types the BE-2836 Decision Record keys', () => {
    // `details` of be's recorded interaction decision (service spec, implicit live-task deny).
    const details: InteractionDecisionRecordDetails = {
      decision: 'DENY',
      constrainedBy: 'delegation',
      constrainingTaskId: TASK,
      delegationReason: 'delegation_implicit_live_task',
    };
    expectTypeOf(details.delegationReason).toEqualTypeOf<'delegation_implicit_live_task' | undefined>();
    expectTypeOf(details.constrainingTaskId).toEqualTypeOf<string | null | undefined>();
    expectTypeOf(details.delegationBypass).toEqualTypeOf<'owner' | undefined>();
    expect(details.constrainingTaskId).toBe(TASK);
  });
});
