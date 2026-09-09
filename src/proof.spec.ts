import { afterEach, describe, expect, it, vi } from 'vitest';
import { PraesidiaProof, PraesidiaAudit, PROTECTED_ACTION_CLOSURES } from './index.js';
import { PraesidiaApiError, PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

const config = { apiKey: 'pk_personal', orgId: 'org-1', baseUrl: 'https://api.test', retry: false as const };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.unstubAllEnvs(); });
const call = (index = 0) => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[index] as [string, RequestInit];

describe('protected-action evidence readback', () => {
  it('requires connected credentials and supports environment configuration', () => {
    vi.stubEnv('PRAESIDIA_API_KEY', '');
    vi.stubEnv('PRAESIDIA_ORG_ID', '');
    expect(() => new PraesidiaProof()).toThrow(PraesidiaConfigError);
    vi.stubEnv('PRAESIDIA_API_KEY', 'pk_personal');
    vi.stubEnv('PRAESIDIA_ORG_ID', 'org-1');
    expect(() => new PraesidiaProof()).not.toThrow();
  });

  it('preserves pagination and serializes the exact backend filters', async () => {
    const response = { data: [{ actionId: 'a1', closure: 'SUCCEEDED', evidenceGrade: 'C' }], total: 102, meta: { page: 2, limit: 10, total: 102, totalPages: 11, hasNextPage: true, hasPrevPage: true } };
    globalThis.fetch = makeFetchMock([{ json: response }]);
    const proof = new PraesidiaProof(config);
    expect(await proof.list({agentId:'agent-id',taskId:'task-id',chainId:'chain-id',state:'OUTCOME_UNKNOWN & review',closure:'OUTCOME_UNKNOWN',from:'2026-09-01T00:00:00+03:00',to:'2026-09-02T00:00:00+03:00',page:2,limit:10})).toEqual(response);
    const [url, init] = call();
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/organizations/org-1/protected-actions');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({agentId:'agent-id',taskId:'task-id',chainId:'chain-id',state:'OUTCOME_UNKNOWN & review',closure:'OUTCOME_UNKNOWN',from:'2026-09-01T00:00:00+03:00',to:'2026-09-02T00:00:00+03:00',page:'2',limit:'10'});
    expect(init.headers).toMatchObject({Authorization:'Bearer pk_personal'});
  });

  it('does not equate operational success with verification, or coerce event sequences', async () => {
    const detail = { actionId:'action1', closure:'SUCCEEDED', verificationStatus:'INCOMPLETE', evidenceGrade:null };
    const events = [{actionSeq:'90071992547409931234',payload:null,signature:'exact/base64==',eventType:'Closure',eventCommitment:'sha256:original'}];
    globalThis.fetch = makeFetchMock([{json:detail},{json:events}]);
    const proof = new PraesidiaProof(config);
    expect(await proof.get('action/one')).toEqual(detail);
    expect(await proof.events('action/one')).toEqual(events);
    expect(call()[0]).toBe('https://api.test/organizations/org-1/protected-actions/action%2Fone');
    expect(call(1)[0]).toBe('https://api.test/organizations/org-1/protected-actions/action%2Fone/events');
  });

  it('returns declared scope and exact aggregate counts without inventing coverage', async () => {
    const scope = [{edgeId:'external',supportStatus:'UNSUPPORTED',maxEvidenceGrade:null,gapNotes:'Not captured'}];
    const coverage = {organizationId:'org-1',closureCounts:{OUTCOME_UNKNOWN:12},openPhaseCounts:{AUTHORIZED:3},totalClosed:12,totalOpen:3};
    globalThis.fetch = makeFetchMock([{json:scope},{json:coverage}]);
    const proof = new PraesidiaProof(config);
    expect(await proof.captureScope()).toEqual(scope);
    proof.refreshCredential('pk_rotated');
    expect(await proof.coverageSummary()).toEqual(coverage);
    expect(call()[0]).toMatch(/\/capture-scope$/);
    expect(call(1)[0]).toMatch(/\/coverage-summary$/);
    expect(call(1)[1].headers).toMatchObject({Authorization:'Bearer pk_rotated'});
  });

  it.each([{page:0},{limit:101},{limit:1.5},{closure:'SUCCESS'},{from:'2026-02-30'},{from:'2026-09-01T24:00:00Z'},{from:'2026-09-01T10:00:00'},{from:'2026-09-02',to:'2026-09-01'}])('rejects invalid query %j without sending a request', async query => {
    globalThis.fetch = makeFetchMock([]);
    await expect(new PraesidiaProof(config).list(query as never)).rejects.toThrow(PraesidiaConfigError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('omits unset query fields and propagates forbidden responses without fallback', async () => {
    globalThis.fetch = makeFetchMock([{status:403,json:{message:'Protected-action access denied'}}]);
    await expect(new PraesidiaProof(config).list()).rejects.toBeInstanceOf(PraesidiaApiError);
    expect(call()[0]).toBe('https://api.test/organizations/org-1/protected-actions');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(PROTECTED_ACTION_CLOSURES).toContain('OUTCOME_UNKNOWN');
  });

  it.each(['', '..', 'action\nsecret'])('rejects unsafe action id %j', value => {
    expect(() => new PraesidiaProof(config).get(value)).toThrow(PraesidiaConfigError);
  });
});

describe('signed bundle export', () => {
  it('downloads exact binary bytes using from/to rather than log-export filters', async () => {
    const bytes = new Uint8Array([80,75,3,4,0,255,128]);
    globalThis.fetch = makeFetchMock([{bytes}]);
    const result = await new PraesidiaAudit(config).exportBundle({from:'2026-01-01T00:00:00+03:00',to:'2026-04-01T00:00:00+03:00'});
    expect(result).toEqual(bytes);
    const url = new URL(call()[0]);
    expect(url.pathname).toBe('/organizations/org-1/audit/bundle');
    expect(Object.fromEntries(url.searchParams)).toEqual({from:'2026-01-01T00:00:00+03:00',to:'2026-04-01T00:00:00+03:00'});
  });

  it.each([
    {from:'',to:'2026-09-02'},
    {from:'2026-09-01',to:'2026-09-01'},
    {from:'2026-09-02',to:'2026-09-01'},
    {from:'2026-01-01',to:'2026-04-02'},
    {from:'2026-01-01T00:00:00Z',to:'2026-04-01T00:00:00.001Z'},
    {from:'2026-02-30',to:'2026-03-02'},
  ])('rejects invalid bundle window %j', query => {
    globalThis.fetch = makeFetchMock([]);
    expect(() => new PraesidiaAudit(config).exportBundle(query)).toThrow(PraesidiaConfigError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('propagates a denied export and the bounded transport rejects oversized downloads', async () => {
    globalThis.fetch = makeFetchMock([{status:403,json:{message:'Denied'}}]);
    await expect(new PraesidiaAudit(config).exportBundle({from:'2026-09-01',to:'2026-09-02'})).rejects.toBeInstanceOf(PraesidiaApiError);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('x',{headers:{'content-length':String(128*1024*1024+1)}}));
    await expect(new PraesidiaAudit(config).exportBundle({from:'2026-09-01',to:'2026-09-02'})).rejects.toThrow('limit');
  });
});
