import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeBaseUrl } from './client.js';
import { PraesidiaConfigError } from './errors.js';
import { PraesidiaAgents, PraesidiaGuard, PraesidiaInteractionHooks, PraesidiaTrust } from './index.js';

// SDK-0339 — plaintext http: is refused except for loopback or an explicit opt-in.
describe('normalizeBaseUrl plaintext-http rule (SDK-0339)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['https://api.example.com', 'https://10.0.0.5:8443/v1'])('accepts https %s', (url) => {
    expect(normalizeBaseUrl(url)).toBe(url);
  });

  it.each(['http://localhost:5001', 'http://127.0.0.1', 'http://127.8.9.10:80', 'http://[::1]:5001', 'http://LOCALHOST'])(
    'accepts loopback %s',
    (url) => expect(() => normalizeBaseUrl(url)).not.toThrow(),
  );

  it.each(['http://api.example.com', 'http://api.localhost', 'http://0.0.0.0:5001', 'http://128.0.0.1', 'http://127.0.0.1.example.com', 'http://[::2]'])(
    'rejects non-loopback %s with a config error naming the option',
    (url) => {
      expect(() => normalizeBaseUrl(url)).toThrow(PraesidiaConfigError);
      expect(() => normalizeBaseUrl(url)).toThrow(/allowInsecureHttp/);
    },
  );

  it('accepts non-loopback http with the explicit option or env opt-in', () => {
    expect(normalizeBaseUrl('http://api.example.com', true)).toBe('http://api.example.com');
    vi.stubEnv('PRAESIDIA_ALLOW_INSECURE_HTTP', '1');
    expect(normalizeBaseUrl('http://api.example.com')).toBe('http://api.example.com');
    expect(() => normalizeBaseUrl('http://api.example.com', false)).toThrow(PraesidiaConfigError);
  });

  it('holds on every product constructor and env default', () => {
    const cfg = { apiKey: 'pk_test', orgId: 'org', agentId: 'agent' };
    const url = 'http://api.example.com';
    expect(() => new PraesidiaAgents({ ...cfg, baseUrl: url })).toThrow(PraesidiaConfigError);
    expect(() => new PraesidiaGuard({ ...cfg, baseUrl: url })).toThrow(PraesidiaConfigError);
    expect(() => new PraesidiaTrust({ baseUrl: url })).toThrow(PraesidiaConfigError);
    expect(() => new PraesidiaInteractionHooks({ ...cfg, baseUrl: url })).toThrow(PraesidiaConfigError);
    vi.stubEnv('PRAESIDIA_BASE_URL', url);
    expect(() => new PraesidiaAgents(cfg)).toThrow(PraesidiaConfigError);
    expect(() => new PraesidiaAgents({ ...cfg, allowInsecureHttp: true })).not.toThrow();
    expect(() => new PraesidiaGuard({ ...cfg, allowInsecureHttp: true })).not.toThrow();
    expect(() => new PraesidiaTrust({ allowInsecureHttp: true })).not.toThrow();
    expect(() => new PraesidiaInteractionHooks({ ...cfg, allowInsecureHttp: true })).not.toThrow();
  });
});
