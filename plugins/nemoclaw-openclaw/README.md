# Praesidia managed tools inside NemoClaw

This release-specific OpenClaw plugin targets **NemoClaw 0.0.120**, **OpenShell 0.0.106**, **OpenClaw 2026.7.1** and **mcporter 0.7.3**. It exposes only `praesidia_managed_action` and explicitly blocks other tools through the native `before_tool_call` hook. The matching image profile also pins `tools.allow` to that tool, so an absent plugin does not restore builtin capabilities.

The tool uses the existing NVIDIA-managed MCP registration named `praesidia`. It calls mcporter's public `createRuntime().callTool()` with one fixed tool name; it does not invoke the CLI's typo correction/retry path. URL, transport and native credential placeholder are rechecked before every invocation. The connection must report the same live `CONNECTED` `nemoclaw/managed-mcp` installation before preparation or execution proceeds. Explicit checkpoint readback remains authenticated and binds the exact installation and approval after execution is disabled. Runtime-verified owner context is required; `allowLocalCli` is an explicit operator opt-in. The OpenClaw session and tool-call IDs are observations. The companion's operator-owned thread ID and server-validated installation/credential bind execution authority.

## Install the companion and provision authority

Use the separate `@praesidia/managed-mcp` candidate in `website/integration-examples/managed-mcp`. Configure `ecosystemId: "nemoclaw"`, `profileId: "managed-mcp"`, `checkpointRuntime: "openclaw"`, one registered target with an independent public signing key, and a durable private state directory. `PRAESIDIA_RUNTIME_INSTALLATION_ID` and `PRAESIDIA_RUNTIME_THREAD_ID` are operator-owned. The companion keeps user-backed API credentials outside the sandbox; its dedicated HTTPS endpoint requires a separately provisioned `PRAESIDIA_MANAGED_MCP_TOKEN`. Preparation and resume are disabled until the operator enables them. Resume requires the exact stored approval, commitment and confirmation; ambiguous attempts remain blocked across restarts.

Register that HTTPS companion through the supported native route:

```sh
# Secret manager supplies PRAESIDIA_MCP_TOKEN with the companion's HTTP token.
nemoclaw YOUR_SANDBOX mcp add praesidia --url https://companion.example/mcp --env PRAESIDIA_MCP_TOKEN
nemoclaw YOUR_SANDBOX mcp status praesidia --json
```

NVIDIA writes `Bearer openshell:resolve:env:…PRAESIDIA_MCP_TOKEN` into its project config and performs credential replacement at its gateway. This plugin rejects real API keys, stdio commands and arbitrary OAuth helpers in that registration. Preserve the native provider policy and required HTTPS caller/binary restrictions. The companion's API audience stays distinct from its inbound MCP endpoint.

## Build the matching managed image

Use `infra/scripts/nemoclaw-managed-image.mjs` to stage the source layer against the exact upstream Dockerfile. It requires an immutable official base-image digest, writes a new output directory, copies only the six public package files and preserves the full managed bootstrap, healthcheck, entrypoint and final nonroot user. Follow `infra/NATIVE-MANAGED-RUNTIMES.md` for the full-context workflow. No package publication is required: dependencies are release-matched peers from NVIDIA's own image; the image links to those exact installed paths instead of introducing another runtime.

The generator installs this plugin at `/opt/praesidia-nemoclaw`, records that supported linked install, applies public configuration, enables it, inspects the native runtime and refreshes NVIDIA's config hash. Never replace the full managed runtime with a plain `sandbox-base` image or mix release pins. Do not disable the static allowlist when removing this plugin. Revoke/disable the backend installation and preserve companion attempt records before changing a live runtime.

## Evidence and limits

Tests exercise the actual 2026.7.1 modifying-hook runner (including sticky denial), the actual native plugin handler through mcporter HTTPS, fixed connection identity, changed registration, unknown/lost response, and exactly one failed transport call. Native hook and transport tests use an inert local model/companion and synthetic owner context. They do not attest remote message ingress, prove OpenShell credential replacement, or claim NVIDIA sandbox containment. The compound NVIDIA image and actual sandbox still require supported-host build, policy, restart, revocation and target acceptance. NemoClaw is upstream alpha. A cooperative plugin does not prevent a host administrator or trusted code from changing the runtime.

Primary contracts accessed 7 September 2026: [pinned managed image](https://github.com/NVIDIA/NemoClaw/blob/2444537f5a77c7b2789de4d59430e228328b8279/Dockerfile), [native MCP adapter](https://github.com/NVIDIA/NemoClaw/blob/2444537f5a77c7b2789de4d59430e228328b8279/src/lib/actions/sandbox/mcp-bridge-adapter-openclaw.ts), [supported plugin image workflow](https://github.com/NVIDIA/NemoClaw/blob/2444537f5a77c7b2789de4d59430e228328b8279/docs/deployment/install-openclaw-plugins.mdx), [OpenClaw 2026.7.1 package](https://www.npmjs.com/package/openclaw/v/2026.7.1), [mcporter 0.7.3](https://www.npmjs.com/package/mcporter/v/0.7.3).
