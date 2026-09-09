import { afterEach, describe, expect, it, vi } from 'vitest';
import { PraesidiaIdentity } from './identity.js';

const token = `pfa_00000000-0000-4000-8000-000000000001.${'a'.repeat(43)}`;
const result = { access_token: token, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 299, scope: 'agents:invoke mcp:invoke' };
const input = { organizationId: 'org', subjectBindingId: 'workload', subjectToken: 'fresh.jwt.assertion', resource: 'https://api.test', scopes: ['agents:invoke', 'mcp:invoke'] };
afterEach(() => vi.unstubAllGlobals());

describe('federated identity credential client', () => {
  it('sends exact subject and actor bindings without sending any management credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new PraesidiaIdentity({ baseUrl: 'https://api.test' });
    expect(await client.exchange({ ...input, delegation: { actorBindingId: 'actor', actorToken: 'actor.jwt.assertion', consentId: 'consent' } })).toEqual(result);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/oauth/token-exchange');
    expect(request.redirect).toBe('error');
    expect(request.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(request.body)).toMatchObject({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', subject_token: input.subjectToken, organization_id: 'org', subject_binding_id: 'workload', actor_token_type: 'urn:ietf:params:oauth:token-type:jwt', actor_token: 'actor.jwt.assertion', actor_binding_id: 'actor', consent_id: 'consent' });
  });
  it('binds downexchange ingress resource and retains parent scopes when omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new PraesidiaIdentity({ baseUrl: 'https://api.test' }).downExchange(token, { subjectResource: 'https://mcp.test/mcp', resource: 'https://api.test' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ subject_token: token, subject_resource: 'https://mcp.test/mcp', resource: 'https://api.test' });
    expect(body).not.toHaveProperty('scope');
  });
  it('does not retry a rejected or ambiguous one-use assertion or expose server echo in its error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: input.subjectToken }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new PraesidiaIdentity().exchange(input)).rejects.toThrow('Identity request rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset().mockRejectedValue(new Error('network unavailable'));
    await expect(new PraesidiaIdentity().exchange(input)).rejects.toThrow('network unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('obtains a fresh assertion for every use-time credential acquisition', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const fresh = vi.fn().mockResolvedValueOnce(input).mockResolvedValueOnce({ ...input, subjectToken: 'next.jwt.assertion' });
    const acquire = new PraesidiaIdentity().credentialProvider(fresh);
    expect(await acquire()).toBe(token);
    expect(await acquire()).toBe(token);
    expect(fresh).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).subject_token).toBe('next.jwt.assertion');
  });
  it('performs live introspection with bearer authentication and no cached authorization', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ grantId: 'grant', resource: 'https://api.test' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new PraesidiaIdentity();
    await client.introspect(token);
    await client.introspect(token);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
  });
  it('rejects plaintext remote endpoints and wildcard authority before IO', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => new PraesidiaIdentity({ baseUrl: 'http://remote.test' })).toThrow('HTTPS');
    expect(() => new PraesidiaIdentity().exchange({ ...input, scopes: ['*'] })).toThrow('scopes');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
