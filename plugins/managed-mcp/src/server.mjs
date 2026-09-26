import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOL_NAME, argumentSchema } from './managed.mjs';

export function mcpServer(actions) {
  const server = new McpServer({ name: 'praesidia-managed-actions', version: '0.1.0' });
  server.registerTool(TOOL_NAME, {
    description: 'Explicit Praesidia operations for one installed target. Default connection is read-only. Prepare stops for separate human approval. Resume is an explicit choice, requires the exact confirmation string, and is never retried. No native tool interception.',
    inputSchema: argumentSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await actions.execute(args)) }] }; }
    catch { return { isError: true, content: [{ type: 'text', text: 'Operation blocked or unavailable. Read the owned checkpoint; do not retry a possible effect. No credential or server response is included in this error.' }] }; }
  });
  return server;
}

export async function serveStdio(actions) {
  const server = mcpServer(actions);
  await server.connect(new StdioServerTransport());
  return server;
}

/** Stateless transport: every request authenticates; no reusable authorization cache. */
export async function serveHttp(actions) {
  const config = actions.config.http;
  const token = actions.config.httpToken;
  if (!config || typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw new Error('HTTP requires an independently provisioned secret of at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const received = Buffer.from(req.headers.authorization ?? '');
    if (!config.allowedHosts.includes(req.headers.host) || req.headers.origin) { res.writeHead(403).end(); return; }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="praesidia-managed"' }).end(); return;
    }
    if (req.headers['x-org-id'] && req.headers['x-org-id'] !== actions.config.organizationId) { res.writeHead(403).end(); return; }
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(); return; }
    let size = 0;
    const chunks = [];
    try {
      for await (const part of req) {
        size += part.length;
        if (size > 262144) { res.writeHead(413).end(); req.destroy(); return; }
        chunks.push(part);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = mcpServer(actions);
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(400).end(); else res.end(); }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  return server;
}
