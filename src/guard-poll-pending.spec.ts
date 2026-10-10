import { afterEach, describe, expect, it } from 'vitest';
import { PraesidiaGuard } from './guard.js';
import { PraesidiaConfigError } from './errors.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

const config = { apiKey: 'pk_test_key', orgId: 'org-1', baseUrl: 'https://api.test' };
const ROW = { id: 't-1', chainId: 'c-1', hopIndex: 0, capabilityToken: 'jwt' };
const ENVELOPE = { data: [ROW], total: 1, page: 1, limit: 1 };
const realFetch = globalThis.fetch;

function lastCall(mock: ReturnType<typeof makeFetchMock>) {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string> };
}

describe('PraesidiaGuard.pollPendingTasks (GET /a2a/tasks/pending/:clientId)', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('uses the configured Bearer key and unwraps the { data } envelope', async () => {
    const mock = makeFetchMock([{ status: 200, body: ENVELOPE }]);
    globalThis.fetch = mock;
    const rows = await new PraesidiaGuard(config).pollPendingTasks('client/1');
    expect(rows).toEqual([ROW]);
    const { url, headers } = lastCall(mock);
    expect(url).toBe('https://api.test/a2a/tasks/pending/client%2F1');
    expect(headers.Authorization).toBe('Bearer pk_test_key');
  });

  it('static clientSecret sends X-A2A-* headers and no Authorization header', async () => {
    const mock = makeFetchMock([{ status: 200, body: [ROW] }]);
    globalThis.fetch = mock;
    const rows = await new PraesidiaGuard(config).pollPendingTasks('cid', {
      clientSecret: 's3cret',
    });
    expect(rows).toEqual([ROW]);
    const { headers } = lastCall(mock);
    expect(headers['X-A2A-Client-Id']).toBe('cid');
    expect(headers['X-A2A-Client-Secret']).toBe('s3cret');
    expect('Authorization' in headers).toBe(false);
  });

  it('accessToken replaces the management Bearer header', async () => {
    const mock = makeFetchMock([{ status: 200, body: ENVELOPE }]);
    globalThis.fetch = mock;
    await new PraesidiaGuard(config).pollPendingTasks('cid', { accessToken: 'oauth-tok' });
    expect(lastCall(mock).headers.Authorization).toBe('Bearer oauth-tok');
  });

  it.each([
    [{ clientSecret: 'a', accessToken: 'b' }],
    [{ clientSecret: '' }],
    [{ accessToken: 'x\r\nInjected: 1' }],
  ])('rejects invalid credentials %j before any request', async (opts) => {
    const mock = makeFetchMock([]);
    globalThis.fetch = mock;
    await expect(new PraesidiaGuard(config).pollPendingTasks('cid', opts)).rejects.toThrow(
      PraesidiaConfigError,
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it('throws PraesidiaConfigError in local mode (no connected client)', async () => {
    await expect(new PraesidiaGuard({ apiKey: '', orgId: '' }).pollPendingTasks('cid')).rejects.toThrow(
      PraesidiaConfigError,
    );
  });
});
