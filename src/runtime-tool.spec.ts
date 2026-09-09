import { describe, expect, it, vi } from 'vitest';
import { PraesidiaRuntimeTool, type RuntimeToolResource } from './runtime-tool.js';
import { jcsCommitment } from './jcs-canonical.js';
import type { ProtectedHttpCheckpoint, ProtectedHttpRequest } from './protected-http.js';

const approvalId = '20000000-0000-4000-8000-000000000001';
const actionId = '30000000-0000-7000-8000-000000000001';
const approverId = '40000000-0000-4000-8000-000000000001';
const call = { threadId: 'host-session', callId: 'call-1' };
function fixture(status = 'PENDING') {
  const checkpoint: ProtectedHttpCheckpoint = {
    approvalId, actionId, requestCommitment: 'a'.repeat(64), status,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), consumedAt: null,
    approverId: status === 'APPROVED' ? approverId : null,
  };
  let committed: string | undefined;
  let effects = 0;
  const attempts = new Set<string>();
  const store = { claim: vi.fn(async (attempt: { approvalId: string }) => {
    if (attempts.has(attempt.approvalId)) return false;
    attempts.add(attempt.approvalId); return true;
  }) };
  const resource = {
    prepare: vi.fn(async (request: ProtectedHttpRequest) => {
      const hash = JSON.stringify(request);
      if (committed && committed !== hash) throw new Error('checkpoint request changed');
      committed = hash;
      return { ...checkpoint };
    }),
    checkpoint: vi.fn(async () => ({ ...checkpoint })),
    resume: vi.fn(async () => {
      if (checkpoint.consumedAt) throw new Error('already consumed');
      effects++;
      const result = { applied: true };
      Object.assign(checkpoint, { consumedAt: new Date().toISOString(), closure: 'SUCCEEDED', result,
        resultCommitment: jcsCommitment(result), evidenceGrade: 'C' });
      return { approvalId, actionId, requestCommitment: checkpoint.requestCommitment,
        closure: 'SUCCEEDED', result, resultCommitment: jcsCommitment(result), evidenceGrade: 'C' as const, receipt: null };
    }),
    revoke: vi.fn(async () => ({ approvalId, status: 'CANCELLED' as const })),
  } satisfies RuntimeToolResource;
  const make = () => new PraesidiaRuntimeTool(resource, { name: 'reviewed_write', targetId: 'fixed-target',
    runtime: 'openai-agents', description: 'Review the write' }, store);
  return { resource, checkpoint, make, store, effects: () => effects };
}
describe('runtime protected tools', () => {
  it('never dispatches from the framework approval callback even when approved', async () => {
    const f = fixture('APPROVED');
    expect((await f.make().prepare({}, call)).kind).toBe('ready');
    expect(f.effects()).toBe(0);
  });
  it('prepares a pending action without calling the effect', async () => {
    const f = fixture();
    const result = await f.make().invoke({ message: 'hello' }, call);
    expect(result.kind).toBe('approval_required');
    expect(f.effects()).toBe(0);
    expect(f.resource.prepare.mock.calls[0][0]).toMatchObject({ targetId: 'fixed-target',
      checkpoint: { runtime: 'openai-agents', threadId: 'host-session', nodeId: 'reviewed_write:call-1' } });
  });
  it('recovers through a fresh adapter and dispatches once after actual approval', async () => {
    const f = fixture();
    await f.make().invoke({ message: 'hello' }, call);
    Object.assign(f.checkpoint, { status: 'APPROVED', approverId });
    expect((await f.make().invoke({ message: 'hello' }, call)).kind).toBe('completed');
    expect((await f.make().invoke({ message: 'hello' }, call)).kind).toBe('completed');
    expect(f.effects()).toBe(1);
  });
  it('blocks changed arguments after approval even with no local saved state', async () => {
    const f = fixture();
    await f.make().invoke({ message: 'hello' }, call);
    Object.assign(f.checkpoint, { status: 'APPROVED', approverId });
    await expect(f.make().invoke({ message: 'changed' }, call)).rejects.toThrow('checkpoint request changed');
    expect(f.effects()).toBe(0);
  });
  it.each(['REJECTED', 'CANCELLED', 'EXPIRED'])('never executes %s', async status => {
    const f = fixture(status);
    expect((await f.make().invoke({}, call)).kind).toBe('denied');
    expect(f.effects()).toBe(0);
  });
  it('does not accept an expired or reviewer-less approval', async () => {
    const f = fixture('APPROVED');
    f.checkpoint.expiresAt = new Date(0).toISOString();
    expect((await f.make().invoke({}, call)).kind).toBe('denied');
    f.checkpoint.expiresAt = new Date(Date.now() + 60_000).toISOString();
    f.checkpoint.approverId = null;
    await expect(f.make().invoke({}, call)).rejects.toThrow('reviewer');
    expect(f.effects()).toBe(0);
  });
  it('preserves the authoritative grade D cancellation without dispatch', async () => {
    const f = fixture('CANCELLED');
    Object.assign(f.checkpoint, { closure: 'CANCELLED_BEFORE_DISPATCH', evidenceGrade: 'D' });
    expect(await f.make().invoke({}, call)).toMatchObject({ kind: 'denied',
      closure: 'CANCELLED_BEFORE_DISPATCH', evidenceGrade: 'D' });
    expect(f.effects()).toBe(0);
  });
  it('rejects a changed checkpoint result instead of returning it as completed', async () => {
    const f = fixture('APPROVED');
    Object.assign(f.checkpoint, { consumedAt: new Date().toISOString(), closure: 'SUCCEEDED',
      result: { changed: true }, resultCommitment: jcsCommitment({ changed: false }), evidenceGrade: 'A' });
    await expect(f.make().invoke({}, call)).rejects.toThrow('result does not match');
    expect(f.resource.resume).not.toHaveBeenCalled();
  });
  it('fails closed on missing identity, non-JSON arguments and policy errors', async () => {
    const f = fixture('APPROVED');
    expect(() => f.make().invoke({}, { ...call, callId: '' })).toThrow('Host callId');
    expect(() => f.make().invoke({ invalid: NaN }, call)).toThrow();
    f.resource.prepare.mockRejectedValue(new Error('authority revoked'));
    await expect(f.make().invoke({}, call)).rejects.toThrow('authority revoked');
    expect(f.effects()).toBe(0);
  });
  it('rejects malformed or substituted server checkpoints', async () => {
    const f = fixture('APPROVED');
    f.resource.checkpoint.mockResolvedValue({ ...f.checkpoint, actionId: approvalId });
    await expect(f.make().invoke({}, call)).rejects.toThrow('changed');
    f.resource.checkpoint.mockResolvedValue({ ...f.checkpoint, status: 'ALLOW' });
    await expect(f.make().invoke({}, call)).rejects.toThrow('Invalid protected checkpoint');
    expect(f.effects()).toBe(0);
  });
  it('snapshots input before async work and coalesces the same concurrent call', async () => {
    const f = fixture('APPROVED');
    const tool = f.make();
    const args = { message: 'original' };
    const first = tool.invoke(args, call);
    args.message = 'changed';
    const second = tool.invoke({ message: 'original' }, call);
    expect(() => tool.invoke(args, call)).toThrow('different tool arguments');
    expect(first).toBe(second);
    await first;
    expect(f.effects()).toBe(1);
    expect(f.resource.prepare.mock.calls[0][0].body).toEqual({ message: 'original' });
  });
  it('does readback only when dispatch response is lost', async () => {
    const f = fixture('APPROVED');
    const realResume = f.resource.resume.getMockImplementation()!;
    f.resource.resume.mockImplementation(async () => { await realResume(); throw new Error('response lost'); });
    expect((await f.make().invoke({}, call)).kind).toBe('completed');
    expect(f.resource.resume).toHaveBeenCalledTimes(1);
    expect(f.effects()).toBe(1);
  });
  it('keeps a lost response unknown when readback has no consumption yet', async () => {
    const f = fixture('APPROVED');
    f.resource.resume.mockRejectedValue(new Error('connection lost'));
    expect((await f.make().invoke({}, call)).kind).toBe('outcome_unknown');
    expect((await f.make().invoke({}, call)).kind).toBe('outcome_unknown');
    expect(f.resource.resume).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch when durable attempt persistence fails', async () => {
    const f = fixture('APPROVED');
    f.store.claim.mockRejectedValue(new Error('state unavailable'));
    await expect(f.make().invoke({}, call)).rejects.toThrow('state unavailable');
    expect(f.resource.resume).not.toHaveBeenCalled();
  });
  it.each([['PARTIAL', 'partial'], ['FAILED_NO_EFFECT', 'failed_no_effect'], ['OUTCOME_UNKNOWN', 'outcome_unknown']])('preserves %s', async (closure, kind) => {
    const f = fixture('APPROVED');
    Object.assign(f.checkpoint, { consumedAt: new Date().toISOString(), closure });
    expect((await f.make().invoke({}, call)).kind).toBe(kind);
    expect(f.resource.resume).not.toHaveBeenCalled();
  });
});
