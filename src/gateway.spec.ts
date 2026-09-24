import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gatewayFetch, MCP_SERVER_ID_HEADER } from './gateway.js';
import { InvalidMcpServerIdError, PraesidiaConfigError } from './errors.js';

const A = '018f4f1a-6b1e-7c3a-9d2e-abcdef123456';
const B = '018F4F1A-6B1E-7C3A-9D2E-ABCDEF654321';
// The gateway's own is_uuid_shaped rejects (gateway-server proxy.rs), plus a duplicate.
const BAD = [
  '018f4f1a6b1e7c3a9d2eabcdef123456',
  '018f4f1a-6b1e-7c3a-9d2e-abcdef12345',
  '018f4f1a-6b1e-7c3a-9d2e-abcdef1234gg',
  '',
  `${A}, ${A}`,
];

// A real socket, so the assertions are on what actually reaches the wire.
let server: Server;
let url: string;
const seen: IncomingHttpHeaders[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.headers);
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1/chat/completions`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function wire(send: typeof fetch, input: string, headers?: RequestInit['headers']) {
  seen.length = 0;
  await send(input, { method: 'POST', headers, body: '{}' });
  return seen[0];
}

describe('gatewayFetch: x-praesidia-mcp-server-id (GW-0776)', () => {
  it('sends no header when no id is set, and keeps the caller headers', async () => {
    const h = await wire(gatewayFetch(), url, { authorization: 'Bearer pra_x' });
    expect(h[MCP_SERVER_ID_HEADER]).toBeUndefined();
    expect(h.authorization).toBe('Bearer pra_x');
  });

  it('sends the client id on every call', async () => {
    const send = gatewayFetch({ mcpServerId: A });
    expect((await wire(send, url))[MCP_SERVER_ID_HEADER]).toBe(A);
    expect((await wire(send, url))[MCP_SERVER_ID_HEADER]).toBe(A);
  });

  it('a per-call id wins over the client id', async () => {
    const h = await wire(gatewayFetch({ mcpServerId: A }), url, { [MCP_SERVER_ID_HEADER]: B });
    expect(h[MCP_SERVER_ID_HEADER]).toBe(B);
  });

  it('keeps the headers of a Request input', async () => {
    seen.length = 0;
    await gatewayFetch({ mcpServerId: A })(new Request(url, { headers: { authorization: 'Bearer pra_x' } }));
    expect(seen[0].authorization).toBe('Bearer pra_x');
    expect(seen[0][MCP_SERVER_ID_HEADER]).toBe(A);
  });

  it.each(BAD)('rejects client id %j when the client is built', (bad) => {
    expect(() => gatewayFetch({ mcpServerId: bad })).toThrow(InvalidMcpServerIdError);
  });

  it.each(BAD)('rejects per-call id %j before sending', async (bad) => {
    const inner = vi.fn<typeof fetch>();
    const send = gatewayFetch({ mcpServerId: A, fetch: inner });
    await expect(send(url, { headers: { [MCP_SERVER_ID_HEADER]: bad } })).rejects.toBeInstanceOf(
      PraesidiaConfigError,
    );
    await expect(
      send(url, { headers: [[MCP_SERVER_ID_HEADER, A], [MCP_SERVER_ID_HEADER, A]] }),
    ).rejects.toBeInstanceOf(InvalidMcpServerIdError);
    expect(inner).not.toHaveBeenCalled();
  });
});
