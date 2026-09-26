import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { loadConfig, endpoint } from '../src/config.mjs';

test('targetless connection defaults cannot enable execution; exact native ecosystem/runtime pairs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'praesidia-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.json');
  const config = { apiUrl: 'https://api.praesidia.ai', organizationId: randomUUID(), createdByUserId: randomUUID(),
    ecosystemId: 'opencode', profileId: 'managed-mcp', runtimeVersion: '1.18.29', stateDirectory: join(directory, 'state') };
  const env = { PRAESIDIA_MANAGED_CONFIG: path, PRAESIDIA_RUNTIME_INSTALLATION_ID: randomUUID(),
    PRAESIDIA_RUNTIME_THREAD_ID: 'operator-thread', PRAESIDIA_API_KEY: 'pk_test_synthetic_credential_0000' };
  const load = async value => { await writeFile(path, JSON.stringify(value)); return loadConfig(env); };
  assert.equal((await load(config)).enableResume, false);
  await assert.rejects(load({ ...config, enablePrepare: true }), /target/);
  await assert.rejects(load({ ...config, enableResume: true }), /target/);
  await load(config); await assert.rejects(loadConfig({ ...env, PRAESIDIA_RUNTIME_THREAD_ID: undefined }));
  for (const [ecosystemId, checkpointRuntime] of [['zeroclaw', 'zeroclaw'], ['nemoclaw', 'openclaw'], ['n8n', 'custom'], ['dify', 'custom'], ['langflow', 'custom'], ['claude-code', 'custom']]) {
    assert.equal((await load({ ...config, ecosystemId, checkpointRuntime })).checkpointRuntime, checkpointRuntime);
    await assert.rejects(load({ ...config, ecosystemId, checkpointRuntime: checkpointRuntime === 'custom' ? 'openclaw' : 'custom' }));
  }
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const target = { targetId: 'reviewed', destination: 'https://independent-target.example/action', keyId: 'pin', publicKeyPem: key };
  assert.equal((await load({ ...config, target, enablePrepare: true, enableResume: true })).enableResume, true);
});

test('endpoint validation forbids embedded credentials, non-loopback HTTP, query and fragment', () => {
  for (const value of ['http://remote.example/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp?token=secret', 'https://example.com/mcp#token', 'file:///tmp/target']) assert.throws(() => endpoint(value));
  assert.equal(endpoint('http://127.0.0.1:4319/mcp').hostname, '127.0.0.1');
});
