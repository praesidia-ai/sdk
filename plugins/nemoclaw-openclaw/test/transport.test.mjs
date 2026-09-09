import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

test('actual pinned plugin handler uses fixed HTTPS managed MCP, binds live installation and does not retry a lost response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nemo-native-tls-'));
  let server;
  try {
    // Ephemeral synthetic TLS material only; never part of the distributable package.
    await writeFile(join(root, 'openssl.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(root, 'openssl.cnf'), '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { timeout: 10000 });
    let mode = 'success'; const calls = [];
    server = createServer({ key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) }, async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      assert.equal(req.url, '/mcp'); assert.equal(req.headers.authorization, 'Bearer openshell:resolve:env:PRAESIDIA_MCP_TOKEN');
      let input = ''; for await (const part of req) input += part;
      const message = JSON.parse(input); res.setHeader('content-type', 'application/json');
      const reply = result => res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      if (message.method === 'initialize') { reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'inert-managed-companion', version: '1' } }); return; }
      if (message.method !== 'tools/call') { res.writeHead(202).end(); return; }
      calls.push(message.params); assert.equal(message.params.name, 'praesidia_managed_action');
      if (message.params.arguments.operation === 'checkpoint') {
        reply({ content: [{ type: 'text', text: JSON.stringify({ installationId: mode === 'foreign-readback' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111', approvalId: message.params.arguments.approvalId, status: 'CANCELLED' }) }] }); return;
      }
      if (message.params.arguments.operation === 'connection') {
        if (mode === 'disabled') { reply({ isError: true, content: [{ type: 'text', text: 'Installation disabled' }] }); return; }
        reply({ content: [{ type: 'text', text: JSON.stringify({ installationId: mode === 'foreign' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111', ecosystemId: 'nemoclaw', profileId: 'managed-mcp', status: 'CONNECTED', verifiedAt: '2026-09-07T00:00:00Z', liveAuthorityChecked: true }) }] }); return;
      }
      if (mode === 'lost') { req.socket.destroy(); return; }
      reply({ content: [{ type: 'text', text: 'EXACT_MANAGED_RESPONSE' }] });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `https://127.0.0.1:${server.address().port}/mcp`, configPath = join(root, 'mcporter.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: { praesidia: { baseUrl: url, headers: { Authorization: 'Bearer openshell:resolve:env:PRAESIDIA_MCP_TOKEN' } } } }));
    const run = (operation = 'resume') => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'managed-call-child.mjs'), url, configPath, operation], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_EXTRA_CA_CERTS: join(root, 'cert.pem') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000); child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    let result = await run(); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).content[0].text, 'EXACT_MANAGED_RESPONSE');
    assert.deepEqual(calls.map(c => c.arguments.operation), ['connection', 'resume']);
    mode = 'foreign'; calls.length = 0; result = await run(); assert.equal(result.code, 1); assert.deepEqual(calls.map(c => c.arguments.operation), ['connection']);
    mode = 'lost'; calls.length = 0; result = await run(); assert.equal(result.code, 1); assert.deepEqual(calls.map(c => c.arguments.operation), ['connection', 'resume']);
    mode = 'disabled'; calls.length = 0; result = await run(); assert.equal(result.code, 1); assert.deepEqual(calls.map(c => c.arguments.operation), ['connection']);
    calls.length = 0; result = await run('checkpoint'); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(JSON.parse(result.stdout).content[0].text).status, 'CANCELLED'); assert.deepEqual(calls.map(c => c.arguments.operation), ['checkpoint']);
    mode = 'foreign-readback'; calls.length = 0; result = await run('checkpoint'); assert.equal(result.code, 1); assert.deepEqual(calls.map(c => c.arguments.operation), ['checkpoint']);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
