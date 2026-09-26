# Managed Praesidia connections

This source package makes OpenCode, Claude Code, n8n, Dify and Langflow runnable clients of one approval-bound Praesidia target. Its single MCP tool is `praesidia_managed_action`. It supports explicit `connection`, `prepare`, `checkpoint`, `resume`, and `list_actions` operations. The default configuration is read-only. It never approves requests, forwards arbitrary tools or URLs, invokes a native shell, or automatically repeats a possible effect.

The same companion supports the separately supplied ZeroClaw and NemoClaw profiles. Use `zeroclaw/managed-mcp/zeroclaw` and `nemoclaw/managed-mcp/openclaw` for ecosystem/profile/checkpoint runtime respectively. Those profile adapters have their own native acceptance; this package does not attest an NVIDIA sandbox or enforce unrelated host tools.

## Install

```sh
npm install @praesidia/managed-mcp   # after publication; returns E404 until then
```

Until then, install reviewed local artifacts. This package lives in the
[`praesidia-ai/sdk`](https://github.com/praesidia-ai/sdk) repository at `plugins/managed-mcp`.
From a checkout of that repository, build `@praesidia/sdk` 0.4.0 and pack all three local
packages:

```sh
npm ci && npm run build
npm pack --pack-destination /absolute/path/to/artifacts
npm pack ./plugins/managed-mcp --pack-destination /absolute/path/to/artifacts
npm pack ./plugins/managed-mcp/clients/n8n --pack-destination /absolute/path/to/artifacts
npm install --ignore-scripts --prefix /absolute/path/to/operator-tools \
  /absolute/path/to/artifacts/praesidia-sdk-0.4.0.tgz \
  /absolute/path/to/artifacts/praesidia-managed-mcp-0.1.0.tgz \
  /absolute/path/to/artifacts/n8n-nodes-praesidia-managed-0.1.0.tgz
```

Use Node 24 and the installed `/absolute/path/to/operator-tools/node_modules/.bin/praesidia-managed-mcp`. Pin/review these artifacts and the independent target public key before enabling execution. Installing dependencies does not register a credential or approve any request.

## Bind the real installation

Create an installation in the Praesidia runtime workspace, using the desired ecosystem and `managed-mcp` profile. Generate its one-use 15-minute challenge. Start from `config.example.json`; replace public identifiers and use a private, absolute host-owned POSIX state directory. Preserve the directory across restarts. It contains original request bodies and approval identifiers; protect and erase it according to your host's retention policy. No credential or result body is stored there. Never delete an attempt marker to retry an uncertain effect; multi-host operation needs a shared durable compare-and-set store instead of this local package.

Supply secrets through the process environment or your host's secret manager, never through a model prompt or exported project configuration:

| Variable | Meaning |
|---|---|
| `PRAESIDIA_MANAGED_CONFIG` | Absolute public configuration JSON path |
| `PRAESIDIA_API_KEY` | Installation creator's personal `pk_` or user-backed delegated `pfa_` API credential |
| `PRAESIDIA_RUNTIME_INSTALLATION_ID` | Saved installation UUID |
| `PRAESIDIA_RUNTIME_INSTALLATION_CHALLENGE` | One-use challenge, used only by the explicit verify command |
| `PRAESIDIA_RUNTIME_THREAD_ID` | Operator-owned run/thread scope, never a model-supplied identity |
| `PRAESIDIA_MANAGED_MCP_TOKEN` | Separate random token of at least 32 characters for the optional incoming HTTP connection |
| `PRAESIDIA_MCP_TOKEN` | Optional separate upstream management-MCP resource credential for proof reads |

Run `praesidia-managed-mcp verify`. It authenticates POST `/organizations/{org}/runtime-installations/{id}/verify`, requires the exact installation, creator, ecosystem, profile, target and CONNECTED response, and saves only the stable binding. A fresh `connection` operation reads the installation again using the current credential. CONNECTED proves credential connection, not host attestation or target execution. Disabling an installation or revoking the API credential blocks its live connection and subsequent dispatch. An explicit owned checkpoint read remains available after installation disable; it still authenticates the current credential and validates the stored caller/installation binding. Revoked or erased credentials cannot read it.

The installation creator must have actual membership and permissions: verification needs `agents.update` plus `agents:invoke`; connection reads need `agents.view` plus `agents:read` or `agents:invoke`; protected execution needs `workflows.execute`, `agents:invoke`, and `proof.actions`. Normal plan and RBAC gates still apply. A model cannot supply another organization, user, installation, target URL, or API credential.

For stdio, run `praesidia-managed-mcp serve --stdio`. For HTTP, add an explicit `http` block to public config, for example loopback `{ "host": "127.0.0.1", "port": 4319, "allowedHosts": ["127.0.0.1:4319"] }`, then `serve --http`. The path is `/mcp`. Remote clients require an operator-owned HTTPS ingress; a private plaintext server is not a public TLS endpoint. If binding `0.0.0.0` behind that ingress, pin the exact forwarded Host names in `allowedHosts`. Browser Origin requests are rejected. Every MCP request authenticates; there is no cached HTTP authorization session. Rotating the incoming token requires restarting the companion. Stop/reconfigure on API credential expiry; no browser login or automatic refresh occurs in this package.

One companion is one creator/installation, even when a Dify or n8n workspace has many users. It does not infer end-user delegation from a workflow or chat ID. Deploy separate credential bindings where different identities are required.

## Explicit execution workflow

Targetless installations can check their connection and read authorized proof projections. To prepare or resume, bind the actual target ID in the installation, obtain its destination/key ID/Ed25519 public key independently from the target operator, and set `target` to `{targetId,destination,keyId,publicKeyPem}`. Do not take a key from the receipt you are verifying. Set `enablePrepare: true`; set `enableResume: true` only for an explicitly reviewed execution workflow.

1. Call `prepare` with a stable `operationKey` and exact JSON-object `body`. The companion fixes the host thread, checkpoint runtime, installation and target. It verifies the request commitment and persists the original request privately. Preparation always stops without dispatch. If local persistence fails, no resume occurs; the stable operation key can recover the same backend preparation after storage is repaired.
2. Keep the returned approval/action IDs and request commitment. A **different human** reviews the approval in Praesidia. Neither this tool nor the native adapters can approve it.
3. Call `checkpoint` with the owned approval ID to read fresh state. The companion accepts only records from its exact installation, creator, target and host scope.
4. Explicitly call `resume` with that approval ID, original `requestCommitment`, and `confirm: "RESUME <approvalId> <requestCommitment>"`. The companion checks fresh approval state, expiry and distinct approver, then durably claims the attempt before network I/O. The backend independently rechecks current authority, the exact stored request, installation and target before consuming approval and dispatching.
5. Inspect the actual closure. `targetReceiptIndependentlyVerified` verifies the versioned request/result commitments and Ed25519 receipt against the operator's independent key. `reportedEvidenceGrade` is only the server's label. `auditBundleIndependentlyVerified` stays false; a separate exported bundle and offline verifier are needed for that claim. Partial, unknown, unavailable, or unverified evidence is never reported as verified success. Lost responses trigger only checkpoint reads; repeated client/workflow invocation does not resend the effect.

`list_actions` calls only `list_protected_actions` on the configured `mcpUrl`. It uses the separate upstream `PRAESIDIA_MCP_TOKEN`, validates the returned organization, and retains the server's explicit no-independent-verification notice. Use an MCP-resource delegated credential with `mcp:invoke` and `audit:read`, or a permitted personal key; keep it separate from the API-audience credential.

## Native clients

| Client | Install/configuration | Supported boundary |
|---|---|---|
| OpenCode | `clients/opencode.json` for local stdio; `clients/opencode-http.json` for HTTP. Put the installed CLI on the client process PATH. | Asks before Praesidia tools; other native tools are unaffected. |
| Claude Code | Merge `clients/claude-code.mcp.json` into project `.mcp.json`, or its HTTP variant. Approve the project MCP connection through normal Claude UI. | Normal tool confirmations remain; no permission bypass configuration is supplied. |
| n8n | Install the reviewed local node tarball, set `N8N_CUSTOM_EXTENSIONS` to its installed package directory, restart your own instance, create its credential and add the node after a manual trigger. | One explicit workflow item; operation defaults to connection. Keep node retries disabled. |
| Dify | Package `clients/dify` with the official `dify plugin package` command, then install the local `.difypkg` under your deployment's signature policy. Its Python client is included. | Provider credential stays secret; operation and resume confirmation are operator form parameters. Other tools remain outside the boundary. |
| Langflow | Install `clients/python` into the **same Python environment as Langflow** using `python -m pip install /absolute/path/to/managed-mcp/clients/python`, then load `clients/langflow/praesidia-managed-action.py` as a custom component. | Actual component output calls the fixed tool; token uses SecretStrInput. Disable host retries. |

For HTTP variants, provide `PRAESIDIA_MANAGED_MCP_URL` and `PRAESIDIA_MANAGED_MCP_TOKEN` to the client, not the API key. These templates contain references, not credentials. A remote Dify/Langflow/n8n deployment must be able to reach your HTTPS companion; container `localhost` refers to that container. No fake public endpoint is supplied.

## Acceptance and its limits

`npm test` runs the self-contained suites (configuration, managed actions, stdio restarts) against a local fixture and needs no native client. `npm run test:native` requires explicit `PRAESIDIA_NATIVE_PYTHON`, `PRAESIDIA_DIFY_SDK_PATH`, `PRAESIDIA_OPENCODE_BINARY`, `PRAESIDIA_CLAUDE_BINARY`, and `PRAESIDIA_MCP_MODULE`, and `@praesidia/managed-mcp` resolvable from `clients/n8n` (the n8n node imports it by package name). Missing native artifacts fail it; nothing silently skips. The source tests use actual Dify Plugin SDK 0.10.2, lfx 1.12.0, n8n node methods, MCP TypeScript 1.29.0 and Python 1.29.1, and released OpenCode 1.18.29 / Claude Code 2.1.202. Native client configuration/discovery, native component invocation, and an actual Praesidia backend customer journey are distinct evidence. The local fixture's API models the backend contract and does not establish database/RBAC enforcement; run the same package with your actual installation for deployment acceptance. No marketplace or external account certification is claimed.

Official contracts checked 2026-09-07: [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), [OpenCode isolated configuration flags](https://opencode.ai/docs/cli/), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [n8n programmatic node](https://docs.n8n.io/integrations/creating-nodes/build/programmatic-style-node/), [Dify tool plugin](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/tool-plugin), [Dify CLI 0.6.10](https://github.com/langgenius/dify-plugin-daemon/releases/tag/0.6.10), [Langflow MCP client](https://docs.langflow.org/mcp-client).
