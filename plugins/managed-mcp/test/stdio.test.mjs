import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';

test('real stdio server restarts preserve preparation, approval and one dispatch; disabled connection blocks', async t => {
  const f = await fixture('zeroclaw'); t.after(() => f.close());
  const { installationId, threadId, apiKey, challenge, httpToken, mcpToken, ...publicConfig } = f.config;
  delete publicConfig.http;
  const configFile = join(f.config.stateDirectory, 'config.json'); await writeFile(configFile, JSON.stringify(publicConfig), { mode: 0o600 });
  const env = { PATH: process.env.PATH, PRAESIDIA_MANAGED_CONFIG: configFile, PRAESIDIA_API_KEY: apiKey,
    PRAESIDIA_RUNTIME_INSTALLATION_ID: installationId, PRAESIDIA_RUNTIME_THREAD_ID: threadId, PRAESIDIA_RUNTIME_INSTALLATION_CHALLENGE: challenge };
  const execute = (script, args) => new Promise((resolve, reject) => {
    const scriptPath = process.env.PRAESIDIA_MANAGED_PACKAGE_DIRECTORY
      ? join(process.env.PRAESIDIA_MANAGED_PACKAGE_DIRECTORY, 'src', script)
      : fileURLToPath(new URL('../src/' + script, import.meta.url));
    const child = spawn(process.execPath, [scriptPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.resume();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Explicit stdio invocation timed out')); }, 30000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Explicit stdio invocation blocked'));
      else { try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid stdio JSON')); } } });
  });
  assert.equal((await execute('cli.mjs', ['verify'])).installationId, installationId);
  const input = join(f.config.stateDirectory, 'args.json');
  const invoke = async args => { await writeFile(input, JSON.stringify(args), { mode: 0o600 }); return execute('invoke.mjs', ['--arguments-file', input]); };
  const p = await invoke({ operation: 'prepare', operationKey: 'native-stdio', body: { message: 'stdio-inert-effect' } });
  assert.equal(p.status, 'PENDING'); assert.equal(f.counters.effects, 0);
  assert.equal((await invoke({ operation: 'checkpoint', approvalId: p.approvalId })).actionId, p.actionId);
  const resume = { operation: 'resume', approvalId: p.approvalId, requestCommitment: p.requestCommitment,
    confirm: `RESUME ${p.approvalId} ${p.requestCommitment}` };
  await assert.rejects(invoke(resume)); f.approve(p.approvalId);
  assert.equal((await invoke(resume)).targetReceiptIndependentlyVerified, true);
  await invoke(resume); assert.equal(f.counters.effects, 1); assert.equal(f.counters.resume, 1);
  f.control.disabled = true; await assert.rejects(invoke({ operation: 'connection' }));
  assert.equal((await invoke({ operation: 'checkpoint', approvalId: p.approvalId })).closure, 'SUCCEEDED');
});
