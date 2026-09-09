# Praesidia for OpenClaw

This native plugin contributes `praesidia_protected_action`, backed by a registered Praesidia protected HTTP target. It requests independent approval, rechecks the exact request on recovery, and dispatches only through the backend. The backend keeps the checkpoint across process restarts. Arbitrary local commands are not routed to a target automatically.

The plugin also requires the public `api.runtime.state.resolveStateDir()` API in
the pinned host. It stores private attempt markers below that directory at
`plugins/praesidia/attempts`. Preserve this directory when restarting or moving
the runtime. Markers are atomic, fsynced and contain only approval/action IDs and
the request commitment, never credentials or argument/result contents. If a
resume response is lost and readback remains unconsumed, a new plugin/tool/store
instance inspects the checkpoint without sending resume again. Never delete a
marker to retry an ambiguous effect. This is a single-host POSIX state profile;
sharing one agent across hosts requires shared durable atomic storage.

The default `enforceManagedOnly: true` blocks other tool names at OpenClaw's native `before_tool_call` boundary. This affects the agent's available tools. Setting it to `false` leaves other tools outside Praesidia's protection. Neither mode prevents a host operator or trusted plugin from modifying the runtime or accessing credentials outside this plugin; stronger containment needs its own sandbox/egress profile. Only named, tested OpenClaw runners can carry an enforcement claim.

## Install a local candidate

Build and pack the SDK in this source checkout, then install its resulting tarball in this plugin directory together with OpenClaw **2026.9.2**. Use an operator-provided SDK artifact for a separate checkout. Registry publication is a separate release step.

```sh
cd sdk
npm ci
npm run build
npm pack
cd plugins/openclaw
npm install ../../praesidia-sdk-0.3.1.tgz openclaw@2026.9.2
openclaw plugins install --link . --force
openclaw plugins enable praesidia
```

Configure the `plugins.entries.praesidia.config` object through your usual OpenClaw configuration:

```json
{
  "orgId": "YOUR_ORGANIZATION_ID",
  "targetId": "YOUR_REGISTERED_TARGET_ID",
  "baseUrl": "https://api.praesidia.ai",
  "credentialEnv": "PRAESIDIA_API_KEY",
  "enforceManagedOnly": true,
  "allowLocalCli": false
}
```

Provide a user-backed credential through that environment variable using your secret manager. The plugin accepts runtime-verified owner messages only. Enable `allowLocalCli` explicitly for a trusted one-shot local CLI host; unproven channel requesters still fail. Missing session identity or credentials blocks execution. Do not share a personal credential as an unrestricted multi-user connector.

Invoke with `{"body":{"message":"hello"}}` against a harmless registered target. Inspect the returned approval in Praesidia. After a separate reviewer approves it, invoke the same body with the returned `resumeCallId`. Changed arguments, another conversation, a rejected request or revoked authority cannot authorize that prior action. A pending response is not a completed action. Inspect `closure` and the actual evidence grade after dispatch; verify grade-A receipts against an independently trusted target key.

Inspect loading with `openclaw plugins inspect praesidia --runtime --json`. Disable using `openclaw plugins disable praesidia`; separately revoke its Praesidia credential and pending approvals when uninstalling. Disabling a plugin changes the host boundary and is not a remote revocation mechanism.
