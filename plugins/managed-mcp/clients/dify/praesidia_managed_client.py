"""Authenticated fixed-tool client. No redirect, credential forwarding, effect retry or approval."""
import json
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

OPERATIONS = {"connection", "prepare", "checkpoint", "resume", "list_actions"}


async def invoke(endpoint, token, organization_id, installation_id, arguments):
    parsed = urlsplit(endpoint)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not (
        parsed.scheme == "https" or parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1", "localhost"}
    ):
        raise ValueError("HTTPS or loopback-only acceptance endpoint required")
    if not isinstance(token, str) or len(token) < 32 or "\r" in token or "\n" in token:
        raise ValueError("Companion secret required")
    UUID(organization_id)
    UUID(installation_id)
    if not isinstance(arguments, dict) or arguments.get("operation", "connection") not in OPERATIONS:
        raise ValueError("Unsupported managed operation")

    def client_factory(headers=None, timeout=None, auth=None):
        return httpx.AsyncClient(headers=headers, timeout=timeout or 30, auth=auth, follow_redirects=False)

    try:
        async with streamablehttp_client(endpoint, headers={"Authorization": "Bearer " + token, "X-Org-Id": organization_id},
                                         timeout=30, sse_read_timeout=30, httpx_client_factory=client_factory) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()

                async def call(params):
                    result = await session.call_tool("praesidia_managed_action", params)
                    if result.isError or len(result.content) != 1 or result.content[0].type != "text" or len(result.content[0].text) > 1048576:
                        raise ValueError("Invalid managed response")
                    value = json.loads(result.content[0].text)
                    if value.get("organizationId") != organization_id or value.get("installationId") != installation_id:
                        raise ValueError("Managed identity binding failed")
                    return value

                # Disabled installation still permits fresh, authenticated owned readback.
                if arguments.get("operation") == "checkpoint":
                    return await call(arguments)
                connection = await call({"operation": "connection"})
                if connection.get("status") != "CONNECTED" or connection.get("liveAuthorityChecked") is not True:
                    raise ValueError("Installation connection is not current")
                return connection if arguments.get("operation", "connection") == "connection" else await call(arguments)
    except Exception:
        # Host error renderers often expose nested HTTP exceptions: discard credential-bearing causes.
        raise RuntimeError("Praesidia operation blocked or unavailable; read the owned checkpoint before any further execution") from None
