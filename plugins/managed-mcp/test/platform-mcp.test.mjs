import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { ManagedActions } from '../src/managed.mjs';
import { fixture } from './fixture.mjs';

test('actual Praesidia MCP server proof read uses separate personal credential and returns exact tenant', async t => {
  if (!process.env.PRAESIDIA_MCP_MODULE) throw new Error('Built Praesidia MCP module required for mandatory real-server contract');
  const { createApp } = await import(pathToFileURL(process.env.PRAESIDIA_MCP_MODULE).href);
  const f = await fixture(); t.after(() => f.close());
  const app = createApp({ port: 0, name: 'praesidia-managed-acceptance', version: 'fixture', apiUrl: f.config.apiUrl }, 18);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await app.shutdown(); await new Promise(r => server.close(r)); });
  f.config.mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  const actions = new ManagedActions(f.config); await actions.verifyInstallation();
  const p = await actions.execute({ operation: 'prepare', operationKey: 'proof', body: { message: 'no effect on read' } });
  const proof = await actions.execute({ operation: 'list_actions' });
  assert.equal(proof.organizationId, f.config.organizationId); assert.equal(proof.installationId, f.config.installationId);
  assert.equal(proof.data[0].actionId, p.actionId); assert.equal(proof.independentVerificationPerformed, false);
  assert.ok(f.counters.proofAuth > 0); assert.ok(f.counters.proofReads > 0); assert.equal(f.counters.effects, 0);
  f.control.credential = false;
  await assert.rejects(actions.execute({ operation: 'list_actions' }));
  assert.equal(f.counters.effects, 0);
});
