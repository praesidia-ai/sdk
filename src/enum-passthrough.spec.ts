import { afterEach, describe, expect, it, vi } from 'vitest';
import { PraesidiaAgents, PraesidiaAiSystems, PraesidiaAudit, PraesidiaConnections, PraesidiaMemory } from './index.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

const config = { apiKey: 'pk_x', orgId: 'org-1', baseUrl: 'https://api.test', retry: false as const };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// be validates these enums; an installed SDK must not block a value be adds later.
describe('enum values outside the known list are sent unchanged', () => {
  it.each<[string, () => Promise<unknown>, string]>([
    ['agents.list role', () => new PraesidiaAgents(config).list({ role: 'FUTURE' }), 'role'],
    ['agents.list status', () => new PraesidiaAgents(config).list({ status: 'FUTURE' }), 'status'],
    ['agents.list visibility', () => new PraesidiaAgents(config).list({ visibility: 'FUTURE' }), 'visibility'],
    ['agents.list tier', () => new PraesidiaAgents(config).list({ tier: 'FUTURE' }), 'tier'],
    ['agents.list scope', () => new PraesidiaAgents(config).list({ scope: 'FUTURE' }), 'scope'],
    ['connections.list status', () => new PraesidiaConnections(config).list({ status: 'FUTURE' }), 'status'],
    ['connections.updateStatus body', () => new PraesidiaConnections(config).updateStatus('c1', 'FUTURE'), 'status'],
    ['aiSystems.listRelationships crossBorderStatus', () => new PraesidiaAiSystems(config).listRelationships({ crossBorderStatus: 'FUTURE' }), 'crossBorderStatus'],
    ['aiSystems.listLifecycleRequests status', () => new PraesidiaAiSystems(config).listLifecycleRequests({ status: 'FUTURE' }), 'status'],
    ['memory.create sourceType body', () => new PraesidiaMemory(config).create({ content: 'ok', sourceType: 'FUTURE' }), 'sourceType'],
    ['memory.list sourceType', () => new PraesidiaMemory(config).list({ sourceType: 'FUTURE' }), 'sourceType'],
    ['audit.export format', () => new PraesidiaAudit(config).export({ format: 'FUTURE' }), 'format'],
  ])('%s', async (_name, run, key) => {
    globalThis.fetch = makeFetchMock([{ json: [] }]);
    await run();
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    expect(new URL(url).searchParams.get(key) ?? body[key]).toBe('FUTURE');
  });
});
