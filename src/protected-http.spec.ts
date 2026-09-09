import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PraesidiaProtectedHttp, verifyProtectedHttpResult, type ProtectedHttpRequest, type ProtectedHttpResult, type TrustedHttpTarget } from './protected-http.js';
import { httpRequestCommitment, type HttpRequestEnvelope } from './http-receipt.js';
const fixture = JSON.parse(readFileSync(new URL('../test-fixtures/http-receipt-v1.json', import.meta.url), 'utf8')) as {
 target: TrustedHttpTarget; request: ProtectedHttpRequest; envelope: HttpRequestEnvelope; organizationId: string; response: ProtectedHttpResult;
};
afterEach(() => vi.unstubAllGlobals());
describe('protected HTTP resource and independently pinned receipt', () => {
  it('verifies the frozen cross-language commitment and signed target response', () => {
    expect(httpRequestCommitment(fixture.envelope)).toBe(fixture.response.requestCommitment);
    expect(verifyProtectedHttpResult(fixture.response, fixture.request, fixture.target, fixture.organizationId)).toBe(true);
  });
  it.each(['result','body','identity','signature'] as const)('rejects tampered %s', mode => {
    const copy = structuredClone(fixture);
    if (mode === 'result') copy.response.result = { applied: '999' };
    if (mode === 'body') copy.request.body = { amount: '999' };
    if (mode === 'identity') copy.target.targetId = 'other-target';
    if (mode === 'signature' && copy.response.receipt) copy.response.receipt.signature = 'A'.repeat(86) + '==';
    expect(verifyProtectedHttpResult(copy.response, copy.request, copy.target, copy.organizationId)).toBe(false);
  });
  it('rejects invalid trust pins and target/closure contradictions without throwing', () => {
    expect(verifyProtectedHttpResult(fixture.response, fixture.request, { ...fixture.target, publicKeyPem: 'not-a-key' }, fixture.organizationId)).toBe(false);
    expect(verifyProtectedHttpResult({ ...fixture.response, closure: 'PARTIAL' }, fixture.request, fixture.target, fixture.organizationId)).toBe(false);
  });
  it('wires prepare/readback/resume/acknowledge to the owned REST resource', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(fixture.response), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const client = new PraesidiaProtectedHttp({ apiKey: 'pk_test', orgId: fixture.organizationId, baseUrl: 'https://api.example' });
    await client.prepare({ ...fixture.request, description: 'Review exact request' });
    await client.checkpoint(fixture.response.approvalId);
    await client.resume({ ...fixture.request, approvalId: fixture.response.approvalId });
    await client.acknowledge(fixture.response);
    await client.revoke(fixture.response.approvalId);
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['prepare',`checkpoints/${fixture.response.approvalId}`,'resume','acknowledge',`checkpoints/${fixture.response.approvalId}/revoke`].map(path => `https://api.example/organizations/${fixture.organizationId}/protected-actions/http/${path}`));
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({ approvalId: fixture.response.approvalId, resultCommitment: fixture.response.resultCommitment });
  });
  it('never retries a resume whose HTTP response was lost', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('socket closed'));
    vi.stubGlobal('fetch', fetcher);
    const client = new PraesidiaProtectedHttp({ apiKey: 'pk_test', orgId: fixture.organizationId, baseUrl: 'https://api.example' });
    await expect(client.resume({ ...fixture.request, approvalId: fixture.response.approvalId })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('binds prepare and resume to the configured installation without mutating caller state', async () => {
    const installationId = '12345678-1234-4234-8234-123456789abc';
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(fixture.response), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const client = new PraesidiaProtectedHttp({ apiKey: 'pk_test', orgId: fixture.organizationId, runtimeInstallationId: installationId });
    await client.prepare({ ...fixture.request, description: 'Review' });
    await client.resume({ ...fixture.request, approvalId: fixture.response.approvalId });
    for (const call of fetcher.mock.calls) expect(JSON.parse(String(call[1]?.body)).checkpoint.installationId).toBe(installationId);
    expect(fixture.request.checkpoint.installationId).toBeUndefined();
    expect(() => client.prepare({ ...fixture.request, checkpoint: { ...fixture.request.checkpoint, installationId: 'aaaaaaaa-1234-4234-8234-123456789abc' }, description: 'Conflicting installation' })).toThrow('conflicts');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid installation configuration before any network call', () => {
    expect(() => new PraesidiaProtectedHttp({ apiKey: 'pk_test', orgId: fixture.organizationId, runtimeInstallationId: '../other' })).toThrow('UUID');
  });
});
