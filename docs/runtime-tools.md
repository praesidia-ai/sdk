# Protected tools across runtimes

`PraesidiaRuntimeTool` in the candidate TypeScript SDK 0.3.1 adapts a registered protected HTTP target to a host runtime. The target, runtime and tool name come from operator configuration. The host supplies a stable session ID and actual logical tool-call ID. Arguments cannot supply a credential, target URL or approval verdict.

```ts
import { PraesidiaProtectedHttp, PraesidiaRuntimeTool, FileRuntimeAttemptStore } from '@praesidia/sdk';
const tool = new PraesidiaRuntimeTool(new PraesidiaProtectedHttp(), {
  runtime: 'custom', name: 'reviewed_write', targetId: 'registered-target',
  description: 'Review this exact write',
}, new FileRuntimeAttemptStore('/var/lib/my-agent/praesidia-attempts'));
const outcome = await tool.invoke({ message: 'hello' }, {
  threadId: hostSession.id, callId: hostToolCall.id,
});
```

`invoke` idempotently prepares the request, reads its current approval, and invokes the backend only when the unexpired checkpoint has an independent reviewer. `prepare` performs the same preparation/readback without dispatch and can be used in a framework approval callback. Restore the same session/call IDs **and attempt store** after restart: the backend holds the authoritative checkpoint and rejects request drift, while the host's durable marker prevents another ambiguous resume request. Give a new logical operation a new call ID. Never copy IDs from model-supplied arguments as the original host identity.

A `RuntimeAttemptStore` is required. `FileRuntimeAttemptStore` uses private mode-0600, create-only files, filesystem sync and an absolute host-owned mode-0700 directory. It stores only approval/action identifiers and the request commitment. It must live on a persistent POSIX volume outside model-controlled files. A multi-host deployment needs a shared durable store implementing the same atomic `claim` contract; separate local disks are not shared state. Persistence failures block dispatch. Preserve incomplete/unknown attempt markers and inspect the existing action; deleting one is not a recovery procedure.

Outcomes are `approval_required`, `ready` (prepare only), `denied`, `completed`, `failed_no_effect`, `partial` or `outcome_unknown`. Pending and denied calls have no dispatch. A lost resume response causes readback without an automatic resume retry, even if consumption has not yet appeared. Re-entry and fresh processes sharing the attempt store stay read-only for that attempt. A consumed checkpoint is observed, never dispatched again. Concurrent identical calls in one adapter share the same result; changed arguments for that call ID are rejected. Backend authority and atomic consumption remain authoritative across processes.

Results include actual approval/action IDs, request/result commitments, closure and available target receipt. An evidence grade is the backend's claim; use the existing independent receipt verifier and an out-of-band target key before accepting grade A. A null receipt does not prove an external business effect. Retain unknown outcomes until evidence resolves them.

The optional packages under `plugins/openclaw` and `plugins/openai-agents` use their actual native tool interfaces. Install local candidate artifacts as described in their READMEs. The base SDK has no OpenClaw/OpenAI dependency. Python framework adapters are maintained in `sdk-python` with separate version profiles.

These are protected-target integrations. Installing an SDK does not intercept arbitrary Python/JavaScript side effects, other MCP servers, local memory, shell or browser operations. OpenClaw's optional strict tool boundary deliberately blocks unrelated native tool names; it does not reroute them automatically. Host operators and trusted plugins remain part of the runtime trust boundary.

Native runtime identity discriminators are `openclaw`, `hermes`, `zeroclaw`, `langgraph`, `crewai`, `openai-agents`, `google-adk`, `microsoft-agent-framework`, `agno` and `custom`. They identify the committed checkpoint; they are not compatibility certifications. NemoClaw is a deployment profile of a chosen runtime.

## Organization runtime installations

Create the matching installation in the app's **Agent runtimes** setup and complete its one-use connection challenge from the host with your personal or delegated user credential. Set `PRAESIDIA_RUNTIME_INSTALLATION_ID`, or pass `runtimeInstallationId` to `PraesidiaProtectedHttp`. The SDK adds this ID to prepare/resume checkpoints and managed-tool durable state; a conflicting explicit checkpoint ID is rejected before HTTP.

The backend commits the ID into human approval and fences new bound dispatch when the installation is disabled. Connection state records credential possession, not native host attestation. Disabling this record does not revoke unrelated credentials or undo an already admitted effect. OpenClaw plugin configuration can set `installationId` explicitly.
