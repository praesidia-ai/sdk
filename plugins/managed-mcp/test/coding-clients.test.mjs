import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedActions } from '../src/managed.mjs';
import { serveHttp } from '../src/server.mjs';
import { fixture } from './fixture.mjs';

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native discovery exceeded 30 seconds')); }, 30000);
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

for (const runtime of ['opencode', 'claude-code']) test(`released ${runtime} authenticates and discovers the managed MCP server in isolated configuration`, async t => {
  const binary = process.env[runtime === 'opencode' ? 'PRAESIDIA_OPENCODE_BINARY' : 'PRAESIDIA_CLAUDE_BINARY'];
  if (!binary) throw new Error('Explicit installed native client binary required; discovery tests never silently skip');
  const f = await fixture(runtime); t.after(() => f.close());
  const actions = new ManagedActions(f.config); await actions.verifyInstallation();
  const server = await serveHttp(actions); t.after(() => new Promise(r => server.close(r)));
  let authenticatedRequests = 0, rejectedRequests = 0;
  server.on('request', req => { if (req.headers.authorization === `Bearer ${f.config.httpToken}`) authenticatedRequests++; else rejectedRequests++; });
  const authority = `127.0.0.1:${server.address().port}`; f.config.http.allowedHosts.push(authority);
  const directory = await mkdtemp(join(tmpdir(), 'praesidia-native-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'); await mkdir(project);
  const env = { PATH: process.env.PATH, NO_COLOR: '1', CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    PRAESIDIA_MANAGED_MCP_URL: `http://${authority}/mcp`, PRAESIDIA_MANAGED_MCP_TOKEN: f.config.httpToken };
  let args;
  if (runtime === 'opencode') {
    await writeFile(join(project, 'opencode.json'), await readFile(new URL('../clients/opencode-http.json', import.meta.url)));
    args = ['mcp', 'list'];
  } else {
    const template = JSON.parse(await readFile(new URL('../clients/claude-code-http.mcp.json', import.meta.url), 'utf8'));
    const added = await run(binary, ['mcp', 'add-json', '--scope', 'local', 'praesidia', JSON.stringify(template.mcpServers.praesidia)], { cwd: project, env });
    assert.equal(added.code, 0, 'Explicit local fixture connection must be configured');
    args = ['mcp', 'list'];
  }
  const version = await run(binary, ['--version'], { cwd: project, env });
  assert.match(version.stdout, runtime === 'opencode' ? /1\.18\.29/ : /2\.1\.202/);
  const result = await run(binary, args, { cwd: project, env });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /connected/i);
  assert.ok(authenticatedRequests > 0, 'Native client must reach the real Bearer-authenticated endpoint');
  assert.equal(f.counters.effects, 0);
  const before = authenticatedRequests;
  const denied = await run(binary, args, { cwd: project, env: { ...env, PRAESIDIA_MANAGED_MCP_TOKEN: 'wrong-synthetic-credential-000000000000' } });
  assert.ok(rejectedRequests > 0, 'Wrong native credential must actually be rejected');
  assert.equal(authenticatedRequests, before);
  assert.doesNotMatch(denied.stdout, /(?:✓|●)\s*(?:praesidia[^\n]*[Cc]onnected|[Cc]onnected)/);
});
