# OpenAI Agents with Praesidia

This separately packaged adapter supports `@openai/agents` **0.17.0** and the candidate `@praesidia/sdk` **0.3.1**. Install locally built/operator-provided artifacts until their registry release is verified. Build/pack the SDK, install its tarball and the pinned framework in this directory, then pack this adapter.

```js
import { Agent, run } from '@openai/agents';
import { FileRuntimeAttemptStore, PraesidiaProtectedHttp } from '@praesidia/sdk';
import { createPraesidiaTool } from '@praesidia/openai-agents';

const protectedWrite = createPraesidiaTool({
  resource: new PraesidiaProtectedHttp(), // user-backed credential and org from environment
  attemptStore: new FileRuntimeAttemptStore('/absolute/host-owned/private/praesidia-attempts'),
  name: 'reviewed_write', targetId: 'registered-write-target',
  description: 'Submit a write for independent approval',
  parameters: { type: 'object', properties: { message: { type: 'string' } },
    required: ['message'], additionalProperties: false },
});
const agent = new Agent({ name: 'Reviewed assistant', tools: [protectedWrite] });
const result = await run(agent, 'Submit the prepared write', {
  context: { praesidiaThreadId: 'HOST_OWNED_STABLE_SESSION_ID' },
});
```

The approval callback prepares a durable backend checkpoint **without dispatching**. Read its actual ID from the host context's `praesidiaApproval`. Have the independent reviewer approve the request in Praesidia. Persist the SDK run state, then use its native interruption/resume API with the same host context and tool call. A native SDK approval boolean alone cannot authorize backend execution. The execution callback checks current authority again.

Do not put session IDs, credentials or the context object in model-supplied tool arguments. The adapter takes the call ID from the SDK's actual `ToolCallDetails`. No arbitrary native function or hosted MCP tool is wrapped. Only this registered HTTP target is governed; unrelated tools need separate integration. After a lost response, the adapter reads the existing checkpoint and exposes an unknown outcome if unresolved, without automatically retrying dispatch.

`attemptStore` is required and must survive process restarts alongside the SDK run
state. The file implementation atomically claims and fsyncs a private marker
before resume; it stores only approval/action IDs and the request commitment.
When an attempted request still has unconsumed readback, fresh tool/store
instances stay inspection-only. Never delete its marker to retry an ambiguous
effect. The local POSIX directory must be absolute, private and runtime-owned;
multi-host deployments must supply a shared durable atomic `RuntimeAttemptStore`
implementation. Model arguments and native approval flags cannot replace this
host-owned store.
