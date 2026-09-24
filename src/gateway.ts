import { InvalidMcpServerIdError } from './errors.js';

/**
 * GW-0776: names the MCP server a gateway call is made for, so the gateway can report the
 * egress it observes against that server. Optional and untrusted: be records it only for a
 * server the calling key's org owns. The gateway strips it before forwarding upstream.
 */
export const MCP_SERVER_ID_HEADER = 'x-praesidia-mcp-server-id';

// The gateway's `is_uuid_shaped` (gateway-server proxy.rs): canonical hyphenated 8-4-4-4-12
// hex in either case, version/variant nibbles unconstrained.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checked(id: string): string {
  if (!UUID_SHAPE.test(id)) throw new InvalidMcpServerIdError();
  return id;
}

export interface GatewayFetchOptions {
  /** MCP server id sent on every call. A per-call `x-praesidia-mcp-server-id` header wins. */
  mcpServerId?: string;
  /** The fetch to wrap. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * SDK-0312: a `fetch` for any OpenAI-wire (or Anthropic) SDK pointed at the Praesidia gateway,
 * e.g. `new OpenAI({ baseURL: 'https://gateway.praesidia.ai/openai/v1', fetch: gatewayFetch({
 * mcpServerId }) })`. Sends no header when neither the client nor the call names a server.
 * Throws `InvalidMcpServerIdError` (a `PraesidiaConfigError`) before anything is sent when an id,
 * or a duplicated per-call header, is not one UUID.
 */
export function gatewayFetch(options: GatewayFetchOptions = {}): typeof fetch {
  const clientId = options.mcpServerId === undefined ? undefined : checked(options.mcpServerId);
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const id = headers.get(MCP_SERVER_ID_HEADER) ?? clientId;
    if (id !== undefined) headers.set(MCP_SERVER_ID_HEADER, checked(id));
    return (options.fetch ?? fetch)(input, { ...init, headers });
  };
}
