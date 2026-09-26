# Praesidia managed actions for Dify

This local plugin uses Dify Plugin SDK 0.10.2 and MCP Python SDK 1.29.1. It includes its fixed-tool MCP client module; no unpublished Python package is required. Install the reviewed `.difypkg` through Dify's **Plugins → Install from local package** workflow under your deployment's signature policy. Marketplace publication, a remote Dify workspace, and a plugin-daemon deployment are separate steps.

Set the companion HTTPS endpoint, organization UUID, installation UUID, and companion token in provider credentials. The token uses a secret input. It is distinct from the API caller and upstream management-MCP credentials held by the companion process. One provider credential is one installation creator: it is not automatic per-chat end-user delegation.

The operation is an operator-configured form field, defaulting to `connection`. A workflow may explicitly select `prepare`, retain the approval and request commitment, stop for separate human review, and later run `resume` with the exact confirmation. Resume is never automatic. Leave Dify retries disabled for this node. The companion's durable attempt marker also prevents repeat dispatch after lost responses or workflow replays.

The package does not intercept other Dify tools. For a constrained agent, expose only this provider's managed tool and separately review every other enabled capability.

Build locally with the official Dify CLI:

```sh
dify plugin package /absolute/path/to/managed-mcp/clients/dify -o /absolute/path/to/praesidia-managed.difypkg
```

The source acceptance uses the real SDK provider loader and tool invocation against owned synthetic MCP/API/target servers. No Dify account or remote daemon is required for that narrower gate.
