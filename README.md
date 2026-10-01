# @praesidia/sdk

Open-source agent governance SDK. Add guardrail checks, audit logging, and analytics to any AI agent in ~10 lines of code.

Apache 2.0 licensed. Free forever.

## Install

`@praesidia/sdk` is not on the npm registry yet. 0.4.0 is ready to release, and
publishing is pending. After it is published, install it with:

```bash
npm install @praesidia/sdk   # after publication; returns E404 until then
```

Until then, build a tarball from this checkout and install that:

```bash
npm ci && npm run build && npm pack        # writes praesidia-sdk-0.4.0.tgz
npm install /path/to/praesidia-sdk-0.4.0.tgz   # run in your project
```

ESM only (`"type": "module"`, no CommonJS build/export condition) — `import` this
package; `require('@praesidia/sdk')` will fail with `ERR_REQUIRE_ESM`. Requires
Node.js >= 22.

This README describes the current source checkout. A registry release may not
contain every method shown here. [CHANGELOG.md](./CHANGELOG.md) lists what each
version adds.

## Managed runtime tools (source version 0.4.0)

`PraesidiaRuntimeTool` prepares an exact registered HTTP request, pauses for a
distinct Praesidia reviewer, and recovers its checkpoint using the host's stable
session and tool-call IDs. It preserves partial and unknown outcomes and never
treats a framework's approval flag as Praesidia authorization. See the
[runtime guide](docs/runtime-tools.md) for the API and installation boundaries.

Source packages for native [OpenClaw](plugins/openclaw/README.md) and
[OpenAI Agents TypeScript](plugins/openai-agents/README.md) live under `plugins/`
and are packed separately, as does the [managed MCP companion](plugins/managed-mcp/README.md)
(`@praesidia/managed-mcp`) for OpenCode, Claude Code, n8n, Dify and Langflow. Their exact framework versions and narrower tested
surfaces are documented there. Installing the base SDK does not intercept a
runtime's other tools or contain its process.

## Quick start (10 lines)

```typescript
import { PraesidiaGuard } from '@praesidia/sdk';

// Zero config: reads PRAESIDIA_API_KEY, PRAESIDIA_ORG_ID, PRAESIDIA_AGENT_ID from env
const guard = new PraesidiaGuard();

const response = await guard.run(
  async () => openai.chat.completions.create({ model: 'gpt-4o', messages }),
  { input: userMessage, context: { userId, sessionId } },
);
// response.output  — the LLM response (only reached if input passed guardrails)
// response.taskId  — Praesidia audit log entry ID (undefined in local mode; see Modes below)
```

## Inspect a protected action and export its evidence

After a managed MCP call returns an `actionId`, use a **separate personal,
user-backed management key** for evidence review. It needs the `audit:read`
scope, your user's `protected_actions.view` permission, and the workspace's
`proof.actions` feature. Organization, service-account, and application keys
are not accepted by these protected-action read routes. Runtime access to a
tool does not grant access to the organization's evidence.

```typescript
import { writeFile } from 'node:fs/promises';
import { PraesidiaProof, PraesidiaAudit } from '@praesidia/sdk';

const reviewKey = process.env.PRAESIDIA_REVIEW_API_KEY;
if (!reviewKey) throw new Error('Set a separate personal review key');
const reviewConfig = {
  apiKey: reviewKey, // personal pk_ key; do not fall back to a runtime key
  orgId: process.env.PRAESIDIA_ORG_ID,
};
const proof = new PraesidiaProof(reviewConfig);
// actionId comes from the governed call, or from proof.list().data.
const actionId = process.env.PRAESIDIA_ACTION_ID!;
const action = await proof.get(actionId);
const events = await proof.events(actionId);
console.log(action.closure, action.verificationStatus, events.length);

const scope = await proof.captureScope();
const coverage = await proof.coverageSummary();
const page = await proof.list({ closure: 'OUTCOME_UNKNOWN', limit: 20 });

// Bundle export additionally requires an owner/compliance-officer role and
// COMPLIANCE_VIEW permission. Select a range that covers the action's events.
const audit = new PraesidiaAudit(reviewConfig);
const bundle = await audit.exportBundle({
  from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z',
});
await writeFile('audit-bundle.zip', bundle);
```

`list` accepts `agentId`, `taskId`, `chainId`, `state`, `closure`, `from`, `to`,
`page`, and `limit` (1–100), returning the server's full `data`/`total`/`meta`
envelope. The list's `from` bound is inclusive and `to` is exclusive. Event
sequences remain decimal strings, including values beyond JavaScript's safe
integer range; signature fields and redacted `null` payloads remain unchanged.

`exportBundle` downloads the signed ZIP, while `audit.export()` remains the
ordinary JSON/CSV log export. Bundle windows must be greater than zero and at
most 90 days. Dates use `YYYY-MM-DD` (UTC) or an ISO timestamp with an explicit
timezone and up to three fractional-second digits. An invalid window makes
`exportBundle`/`downloadBundle` return a promise rejected with
`PraesidiaConfigError` before any request is sent. Downloads retain the
transport's 128 MiB cap and finite timeout; oversized exports raise an error.

Retrieval **does not verify** a projection, event stream, or bundle. A
`SUCCEEDED` closure can coexist with incomplete evidence, and the projection's
`evidenceGrade` is a declared value. Run your obtained verifier against the ZIP
with an independently trusted deployment platform key and review its component
results. Do not disable receipt verification to obtain a passing result. These
SDK resources implement Praesidia's evidence API; they do not claim SCITT,
MCP OAuth, or A2A protocol conformance. See the [integration gap analysis](docs/interop-research.md).

## Modes

### Local mode (no account needed)

When `PRAESIDIA_API_KEY` is not set, the SDK runs bundled rule-based patterns locally with zero API calls. This covers prompt injection, PII patterns, and common safety categories.

```typescript
const guard = new PraesidiaGuard(); // no env vars → local mode
```

### Connected mode (free Praesidia account)

Set three environment variables to enable remote guardrails, audit logging, and analytics:

```bash
PRAESIDIA_API_KEY=pk_...          # org-scoped API key (agents:invoke scope)
PRAESIDIA_ORG_ID=org-uuid         # your organization ID
PRAESIDIA_AGENT_ID=ag-uuid        # the agent running the SDK (optional)
PRAESIDIA_CONNECTION_ID=conn-uuid # default connection the audit task is routed through
PRAESIDIA_REQUEST_TIMEOUT_MS=30000 # per-request deadline (1..300000)
```

> **Audit-task persistence needs a `connectionId`.** `POST /organizations/:orgId/tasks`
> binds `CreateAgentTaskDto`, whose `connectionId` is a **required UUID**. Set
> `PRAESIDIA_CONNECTION_ID` (or pass `connectionId` in the config / per call) to have
> `run`/`logTask`/`beginTask`/`trackToolCall` persist their audit record. Without a
> resolvable connection id the audit submit is **skipped** (or throws in `strict` mode) —
> it never silently 400s.

## API

### `new PraesidiaGuard(config?)`

```typescript
const guard = new PraesidiaGuard({
  apiKey:  'pk_...',                    // falls back to PRAESIDIA_API_KEY
  orgId:   'org-uuid',                 // falls back to PRAESIDIA_ORG_ID
  agentId: 'agent-uuid',              // falls back to PRAESIDIA_AGENT_ID
  connectionId: 'conn-uuid',          // falls back to PRAESIDIA_CONNECTION_ID; required (UUID) to persist audit tasks
  baseUrl: 'https://api.praesidia.ai', // falls back to PRAESIDIA_BASE_URL
  allowInsecureHttp: false, // SDK-0339: http: is refused for non-loopback hosts unless true (or PRAESIDIA_ALLOW_INSECURE_HTTP=1)
  requestTimeoutMs: 30_000, // falls back to PRAESIDIA_REQUEST_TIMEOUT_MS
  strict:  false, // true → throw on network errors (default: false = degrade gracefully)
  failOpen: false, // true → silently swallow network errors (default: false = warn + local fallback)
  // SDK-0335 — explicit control-plane failure policy (see "Fail-open / fail-closed")
  failureMode: 'local_rules', // 'fail_closed' | 'local_rules' | 'fail_open'; unset = mapped from strict/failOpen
  maxDegradedMs: 300_000,     // optional bound: past it, degrading modes fail closed until a call succeeds
  onDegraded: ({ operation, since, mode }) => alert(operation, since, mode), // once per degraded episode
});
```

> **Plaintext HTTP (SDK-0339, behaviour change).** Every API client rejects an `http:` `baseUrl` /
> `PRAESIDIA_BASE_URL` with `PraesidiaConfigError` unless the host is loopback (`localhost`,
> `127.0.0.0/8`, `[::1]`) or you pass `allowInsecureHttp: true` (env `PRAESIDIA_ALLOW_INSECURE_HTTP=1`).
> Before, any `http:` host was accepted and the API key was sent in cleartext. `PraesidiaIdentity` keeps its stricter
> HTTPS-outside-loopback rule and has no opt-in.

### `guard.run(fn, opts)` → `Promise<GuardedResult<T>>`

Wraps any async function. Checks input, runs `fn`, checks output, records audit entry.

```typescript
const result = await guard.run(
  () => callMyLLM(prompt),
  {
    input: prompt,
    context: { userId: '123', sessionId: 'abc' },
    taskType: 'chat',        // optional free-form label carried inside the audit input
    connectionId: 'conn-uuid', // optional; falls back to config.connectionId (required to persist)
    type: 'MESSAGE',         // AgentTaskType for the submit DTO — 'MESSAGE' (default) | 'TOOL_CALL' | 'DELEGATION'
  },
);
```

Throws `GuardrailBlockedError` if input is blocked. `fn` is **not** called in that case.
With `strict: true`, a blocked output is recorded as a failed audit task and
then throws the same error instead of returning the output.
If `fn` throws, `run` records one failed audit task on a best-effort basis and
then rethrows the original error. Per-run `chainId` headers are request-scoped,
so concurrent runs on one guard do not overwrite each other's trace context.

### `guard.checkInput(input, opts?)` → `Promise<CheckResult>`

Standalone input check without running a function.

### `guard.checkOutput(output, opts?)` → `Promise<CheckResult>`

Standalone output check.

### `guard.logTask(task)` → `Promise<string | undefined>`

Manually log a task to the audit trail. Returns the created task's `id`. The task body
is a `CreateAgentTaskDto`: a `connectionId` (UUID, from `task.connectionId` or the config /
`PRAESIDIA_CONNECTION_ID`), a `type` (`AgentTaskType`, default `MESSAGE`), and a **non-empty
`input` object** — a string `input` is wrapped as `{ message }` and the SDK's
`output`/`usage`/`status`/`taskType` telemetry is nested under `input` (they are not top-level
DTO fields). When no `connectionId` is resolvable the submit is skipped (returns `undefined`),
or throws in `strict` mode.

Delegation (SDK-0332, BE-1597): `parentTaskId` makes the task a delegated sub-task, and
`delegationConstraints` (`DelegationConstraints`, every axis optional: `notAfter`, `actions`,
`resources`, `tools`, `models`, `environments`, `maxDataClass`, `maxAmount`, `maxDepth`,
`onExceed`) is sent verbatim. The server intersects it with the parent's envelope, so it can
only narrow. A widening is refused with a 403.

### `guard.trackToolCall(call)` → `Promise<void>`

**Evidence grade D (best-effort observation, NOT enforcement).** Record a tool call as a
`TOOL_CALL` task (`input: { tool, args, parentTaskId }`) — fires *after* the caller's tool call
already happened, and never throws, even on network failure. It is **skipped** (logged locally)
when no `connectionId` is resolvable (`call.connectionId` → config / `PRAESIDIA_CONNECTION_ID`).

If you need to actually *block* a dispatch and get a thrown error on denial, this is not that —
see [`guard.protectAction`](#guardprotectactionopts--promiseprotectactionresult-pa01-dx-001) below.
The two are deliberately different primitives; `trackToolCall` is not being repurposed.

When the tool call runs on behalf of a claimed task, thread the task-binding
fields so the backend's use-time capability-token gate can bind the call to the
live task (see [Chain trace + JIT capability tokens](#chain-trace--jit-capability-tokens-q3-02--q4-02)):

```typescript
import { toolCallContextFromTask } from '@praesidia/sdk';

await guard.trackToolCall({
  name: 'search',
  args: { q: 'quarterly filings' },
  ...toolCallContextFromTask(polledTask), // taskId, agentId, chainId, capabilityToken
});
```

### `guard.protectAction(opts)` → `Promise<ProtectActionResult>` (PA01 DX-001)

**Evidence grade C at best** — a **blocking, throwing** wrapper over the managed MCP path
(`POST /organizations/:orgId/mcp-servers/:id/tools/:toolName/call`), the one route where `be`'s
Proof Edge mints/binds/consumes a Permit and durably records dispatch evidence *before* the tool
call returns. Unlike every other method on `PraesidiaGuard`, `protectAction` ignores
`failOpen`/`strict` — there is no config knob that silently degrades it into best-effort telemetry.

```typescript
import { ProtectedActionDeniedError, UnsupportedProtectedActionTargetError } from '@praesidia/sdk';

try {
  const result = await guard.protectAction({
    target: { protocol: 'mcp', mcpServerId: 'srv-1', toolName: 'send_email', arguments: { to, subject } },
  });
  // result.success / result.content — the tool's own dispatch outcome.
  // result.actionId / .closure / .evidenceGrade are undefined when the Proof
  // Edge feature is off for the org; absence ≠ failure.
} catch (err) {
  if (err instanceof ProtectedActionDeniedError) {
    // Permit missing/expired/invalid/mismatched, or a confirmed replay
    // (which denies even under observe-mode). err.actionDenyReason is the
    // machine-readable reason ('PERMIT_MISSING' | 'PERMIT_INVALID' |
    // 'PERMIT_EXPIRED' | 'PERMIT_MISMATCH' | 'PERMIT_REPLAYED' |
    // 'POLICY_DENIED'); err.errorCode / .actionId / .closure are also set.
  } else if (err instanceof UnsupportedProtectedActionTargetError) {
    // target.protocol was not 'mcp' — the only destination this SDK version
    // can honestly protect. A customer-controlled Proof Edge for arbitrary
    // destinations (EDGE-003) is a later release; this NEVER silently falls
    // back to trackToolCall-style grade-D reporting.
  }
}
```

Only `target.protocol: 'mcp'` is supported today. A tool-level failure (the call dispatched and
the *tool itself* reported an error, OR the call failed downstream with a transport/tool exception)
does **not** throw — it comes back as `result.isError` with `result.success: false`; only a
*pre-dispatch* denial (RBAC/ABAC gate, or the Proof Edge's Permit deny/mismatch/replay) throws.

**PA-0026 — the discriminator is `actionDenyReason`, not `errorCode`.** `protectAction` throws
`ProtectedActionDeniedError` if and only if `be`'s response carries `actionDenyReason` — set on and
only on a genuine pre-dispatch denial. A downstream tool/transport exception returns `errorCode:
'BAD_REQUEST' | 'INTERNAL_ERROR'` (no `actionDenyReason`) and a successful call whose tool errored
carries no `errorCode` at all; neither throws. (An earlier version of this SDK keyed the decision on
`errorCode !== 'TOOL_ERROR'`, which is wrong — `'TOOL_ERROR'` is never present in this endpoint's
caller-visible response.)

The Permit (D3) rides `X-Praesidia-Permit` — a header kept strictly separate from the JIT
`X-Praesidia-Capability-Token` verify path; PA01 has no HTTP permit-issuance endpoint yet, so
`opts.permit` is forward-compatible plumbing, not something you can obtain today.

## Chain trace + JIT capability tokens (Q3-02 / Q4-02)

Praesidia correlates a multi-agent call chain with an **unsigned** chain-trace
id carried in the `X-Praesidia-Chain-Id` header, and gates task-scoped MCP tool
calls with a short-lived **JIT capability token**.

- **Forward the inbound chain id.** When your agent receives an inbound
  `X-Praesidia-Chain-Id` header, hand it to `guard.forwardChain(chainId)` (or
  pass `chainId` to `guard.run(...)`). Every subsequent outbound call then
  carries the same header so the chain stays joined across SDK-driven hops. The
  SDK **never mints** a chainId — it only propagates one it received. Pass
  `null` to stop.
- **Carry the capability context on tool calls.** A polled task row now includes
  `chainId`, `hopIndex`, and (when governance is active) an opaque
  `capabilityToken` (may be absent). `toolCallContextFromTask(task)` lifts the
  four task-binding fields — `taskId`, `agentId`, `chainId`, `capabilityToken` —
  and `trackToolCall` forwards them as `X-Praesidia-*` request headers. The
  capability token is treated as **opaque and is never logged** (not in headers
  echoed to stdout, not in the request body, not in local/offline mode).

```typescript
guard.forwardChain(inboundChainId); // propagate the inbound X-Praesidia-Chain-Id

const result = await guard.run(fn, { input, chainId: inboundChainId });
```

## Compliance report export (EU AI Act)

`PraesidiaCompliance` provides a programmatic export of the EU AI Act
auditor/DPO compliance report. Generation is asynchronous: request a report,
poll until it is ready, then download the structured JSON and/or rendered PDF.

```typescript
import { PraesidiaCompliance } from '@praesidia/sdk';
import { writeFileSync } from 'node:fs';

// Zero config: reads PRAESIDIA_API_KEY, PRAESIDIA_ORG_ID, PRAESIDIA_BASE_URL
const compliance = new PraesidiaCompliance();

// Request + wait (timeout + poll interval are configurable)
const status = await compliance.generateAndWait({
  timeoutMs: 120_000,   // default: 120000
  pollIntervalMs: 2000, // default: 2000
});

// Download artifacts once ready
const doc = await compliance.getReportJson(status.reportId); // AuditorReportDocument
const pdf = await compliance.getReportPdf(status.reportId);  // Uint8Array
writeFileSync('eu-ai-act-report.pdf', Buffer.from(pdf));
```

Unlike `PraesidiaGuard`, there is no local/offline mode — every call is a
connected, authenticated request, so a missing `apiKey`/`orgId` throws
`PraesidiaConfigError` at construction.

### `new PraesidiaCompliance(config?)`

Same config shape as `PraesidiaGuard` (only `apiKey`, `orgId`, `baseUrl` are used).

### Methods

| Method | Returns | Endpoint |
|---|---|---|
| `requestReport()` | `Promise<ReportRequestResult>` | `POST .../reports` |
| `getReportStatus(reportId)` | `Promise<AuditorReportStatus>` | `GET .../reports/:id` |
| `getReportJson(reportId)` | `Promise<AuditorReportDocument>` | `GET .../reports/:id/json` |
| `getReportPdf(reportId)` | `Promise<Uint8Array>` | `GET .../reports/:id/pdf` |
| `waitForReport(reportId, opts?)` | `Promise<AuditorReportStatus>` | polls status |
| `generateAndWait(opts?)` | `Promise<AuditorReportStatus>` | request + poll |

`waitForReport` / `generateAndWait` throw an `Error` if the report status
becomes `failed`, or if `timeoutMs` elapses before it is ready. The JSON/PDF
downloads throw `PraesidiaApiError` with status `409` if called before the
report is `completed`.

All response bodies are consumed through bounded streams: JSON responses are
limited to 16 MiB, error bodies to 64 KiB, and binary downloads to 128 MiB.
An upstream that exceeds a limit fails with `PraesidiaApiError` before the SDK
can buffer an unbounded body.

## Agent credential refresh

`PraesidiaAgents` lets a long-lived client adopt a newly provisioned agent
client secret at runtime for a **zero-downtime** swap — no restart, no
recreating the instance.

```typescript
import { PraesidiaAgents } from '@praesidia/sdk';

// Zero config: reads PRAESIDIA_API_KEY, PRAESIDIA_ORG_ID, PRAESIDIA_BASE_URL
const agents = new PraesidiaAgents();

// Adopt a newly provisioned secret in-process without a restart:
agents.refreshCredential(newClientSecret);
```

`refreshCredential(secret)` is also available on `PraesidiaGuard` — a
long-lived guard can swap in a new credential mid-flight so guarded calls keep
working across the swap.

### `new PraesidiaAgents(config?)`

Same config shape as `PraesidiaGuard` (only `apiKey`, `orgId`, `baseUrl` are
used). Like `PraesidiaCompliance` there is no local mode — a missing
`apiKey`/`orgId` throws `PraesidiaConfigError` at construction.

| Method | Returns | Endpoint |
|---|---|---|
| `refreshCredential(secret)` | `void` | in-memory credential swap (no request) |

## Agent identity + task lifecycle + guardrail hooks (H1-02a)

Beyond the all-in-one `run()`, the guard exposes lower-level primitives that
framework adapters (and your own code) can wire directly.

```typescript
// Who am I running as?
const id = guard.identity();
// { orgId, agentId, baseUrl, connected }

// Guardrail PRE hook — fail-CLOSED: throws GuardrailBlockedError on a block.
await guard.guardInput(userMessage);

// Guardrail POST hook — fail-OPEN by default: returns the CheckResult.
// Pass { throwOnBlock: true } (or construct with strict:true) to hard-block.
const out = await callMyLLM(userMessage);
const check = await guard.guardOutput(out, { throwOnBlock: false });

// Explicit task lifecycle — records EXACTLY ONE audit row per task.
const task = guard.beginTask({ input: userMessage, taskType: 'chat' });
try {
  const output = await callMyLLM(userMessage);
  await task.complete(output, { usage: { totalTokens: 128 } });
} catch (err) {
  await task.fail(err); // one 'failed' row, error message captured as output
  throw err;
}
```

| Method | Returns | Notes |
|---|---|---|
| `identity()` | `AgentIdentity` | sync; `{ orgId, agentId, baseUrl, connected }` |
| `guardInput(input, opts?)` | `Promise<CheckResult>` | throws `GuardrailBlockedError` on block |
| `guardOutput(output, opts?)` | `Promise<CheckResult>` | throws only when `throwOnBlock`/`strict` |
| `beginTask(opts?)` | `TaskHandle` | `.complete(output, opts?)` / `.fail(error, opts?)`; first terminal call wins and is written once |

## OTLP GenAI telemetry — become an OBSERVED agent (H1-02)

`PraesidiaTelemetry` pushes OTLP/HTTP GenAI-convention traces to
`POST /telemetry/otlp/v1/traces`. The backend buffers them and materialises the
emitting agent as an **observed** agent from the GenAI spans — no registration.

This is a **minimal, dependency-free emitter** — the SDK does not vendor an
OpenTelemetry SDK. If you already run the OTel SDK, point its OTLP/HTTP exporter
at `telemetry.tracesEndpoint` with `Authorization: Bearer <org pk_ key>` instead.

```typescript
import { PraesidiaTelemetry } from '@praesidia/sdk';

// Auth is an ORGANIZATION API key (pk_...); the endpoint takes the tenant
// solely from the key (there is no orgId in the path).
const telemetry = new PraesidiaTelemetry({ serviceName: 'support-bot' });

await telemetry.emitGenAiSpan({
  agentName: 'support-bot',
  system: 'openai',
  requestModel: 'gpt-4o',
  inputTokens: 812,
  outputTokens: 143,
});
// → { accepted: true, buffered: 1 }

// Already have raw OTLP resourceSpans (e.g. from the OTel SDK)? Send them:
await telemetry.emit(resourceSpans);
```

Client-side payload bounds mirror the server (fail-fast before the network):
≤100 resourceSpans and ≤2 MB per request. The backend separately enforces its
120 requests/minute rate limit, so batch spans where practical. `genAiSpan(input)`
is exported if you want to build a span without sending it.

Generated spans pin OpenTelemetry semantic conventions **1.37.0** and emit
`gen_ai.provider.name`. Pass a valid W3C `traceparent` to create a child span;
`taskId` and `actionId` preserve correlation. These trace attributes are
observations, never authorization or execution proof.

Prompt, response, document and tool content are omitted by default. Explicit
`captureContent: true` requires a `redactContent` callback; secret attributes
remain excluded. Raw `emit(resourceSpans)` is an explicit pass-through API, so
apply your exporter privacy policy before using it. Backend ingestion retains
only bounded metadata before publishing to its queue. The real collector
acceptance command is `node ../infra/scripts/verify-telemetry-interoperability.mjs`
after building this SDK and preparing the sibling Python environment.

## Gateway calls tagged with an MCP server id (SDK-0312)

The SDK has no OpenAI-wire client of its own. Point the OpenAI (or Anthropic) SDK at the
Praesidia gateway, then pass it `gatewayFetch` to name the MCP server each call is made for.
The gateway reports the egress it observes against that server, and be records it only when
your key's org owns that server. The gateway strips the header before forwarding upstream.

```typescript
import OpenAI from 'openai';
import { gatewayFetch, MCP_SERVER_ID_HEADER } from '@praesidia/sdk';

const openai = new OpenAI({
  baseURL: 'https://gateway.praesidia.ai/openai/v1',
  apiKey: process.env.PRAESIDIA_API_KEY, // your pra_ key
  fetch: gatewayFetch({ mcpServerId: '018f4f1a-6b1e-7c3a-9d2e-abcdef123456' }), // per client
});

// Per call: this header wins over the client's mcpServerId.
await openai.chat.completions.create(body, {
  headers: { [MCP_SERVER_ID_HEADER]: otherMcpServerId },
});
```

- The header is `x-praesidia-mcp-server-id`. With no id on the client or the call, no header
  is sent.
- An id must be one canonical hyphenated UUID (`8-4-4-4-12` hex, either case), the same
  shape rule the gateway applies. A bad client id throws `InvalidMcpServerIdError` from
  `gatewayFetch()`. A bad or duplicated per-call id rejects the call before it is sent. The
  gateway would otherwise answer 400 `invalid_mcp_server_id`.
- `gatewayFetch({ fetch })` wraps your own `fetch`. The default is the global one.

## Agent memory (H2-06e)

`PraesidiaMemory` wraps the org-scoped memory API. Writes are PII-redacted +
poisoning-scanned and encrypted per-org on the backend; reads are decrypted and
carry provenance + guardrail metadata.

```typescript
import { PraesidiaMemory } from '@praesidia/sdk';

const memory = new PraesidiaMemory(); // reads PRAESIDIA_API_KEY + PRAESIDIA_ORG_ID

const m = await memory.create({
  content: 'The customer prefers email.',
  subjectId: 'user-42',       // binds the memory for a later GDPR Art-17 erase
  tags: ['crm'],
});
const hits = await memory.search({ query: 'contact preference', topK: 5 });
const page = await memory.list({ limit: 20, tag: 'crm' });
// page.meta.page / page.meta.totalPages / page.meta.hasNextPage (nested, not top-level)
await memory.get(m.id);
// Requests an Art-17 erasure: returns a PENDING DATA_SUBJECT_ERASE approval (202).
// Nothing is destroyed until a different system admin confirms it.
const ticket = await memory.erase({ subjectId: 'user-42', reason: 'GDPR Art-17 request' });
await memory.delete(m.id);
```

| Method | Returns | Endpoint |
|---|---|---|
| `create(input)` | `Promise<MemoryRecord>` | `POST .../memories` |
| `list(query?)` | `Promise<{ data: MemoryRecord[]; total: number; meta: {page,limit,total,totalPages,hasNextPage,hasPrevPage} }>` | `GET .../memories` |
| `search(input)` | `Promise<MemoryRecord[]>` | `POST .../memories/search` |
| `erase(input)` | `Promise<EraseMemoryResult>` (202 `ApprovalRequest`, `status: 'PENDING'`) | `POST .../memories/erase` |
| `get(id)` | `Promise<MemoryRecord>` | `GET .../memories/:id` |
| `delete(id)` | `Promise<void>` | `DELETE .../memories/:id` |

`erase()` does not crypto-shred anything by itself. The DEK destroy and the erasure certificate
happen only at the system-admin confirm step (`POST /admin/organizations/:orgId/data-subjects/erase/confirm/:approvalId`).
`expectedSubjectHash` is optional: leave it out and the server derives it from `subjectId`. If you
pass one (lowercase 64-char hex), it must match or the API returns 400 `subject_hash_mismatch`. A
malformed value throws `PraesidiaConfigError` before any request is sent.

## Agent CRUD (FINDING-2 parity with the Python SDK)

`PraesidiaAgents` also manages the agent's own lifecycle, not just credential
refresh:

```typescript
import { PraesidiaAgents } from '@praesidia/sdk';

const agents = new PraesidiaAgents();
const list = await agents.list({ page: 1, limit: 20 });
const agent = await agents.get(list[0].id as string);
// type: 'AUTONOMOUS' (default) | 'SUPERVISED' | 'SERVICE' | 'ORCHESTRATOR'
const created = await agents.create({ name: 'Support Bot', type: 'AUTONOMOUS' });
// create() returns { agent, clientSecret, credentialMode, webhookSigningSecret }.
// credentialMode is 'jit' and clientSecret is null: the agent authenticates with
// ephemeral JIT tokens. webhookSigningSecret is shown ONCE — persist it now.
await agents.update(created.agent.id, { name: 'Renamed Bot' });
await agents.delete(created.agent.id);
```

Task submission (`run`), polling (`pollPendingTasks`), and task-scoped MCP tool
calls stay on `PraesidiaGuard` (`run` / `logTask` / `trackToolCall`) — this
mirrors the SDK's existing organization and is unchanged.

| Method | Returns | Endpoint |
|---|---|---|
| `list(query?)` | `Promise<AgentRecord[]>` | `GET .../agents` |
| `get(id)` | `Promise<AgentRecord>` | `GET .../agents/:id` |
| `create(data)` | `Promise<AgentCreateResult>` (`{ agent, clientSecret, credentialMode, webhookSigningSecret }`) | `POST .../agents` |
| `update(id, data)` | `Promise<AgentRecord>` | `PATCH .../agents/:id` |
| `delete(id)` | `Promise<void>` | `DELETE .../agents/:id` |
| `refreshCredential(secret)` | `void` | in-memory credential swap (no request) |

## Workflows (FINDING-2 parity with the Python SDK)

`PraesidiaWorkflows` manages approval workflows and their runs.

```typescript
import { PraesidiaWorkflows } from '@praesidia/sdk';

const workflows = new PraesidiaWorkflows();
const wf = await workflows.create({ name: 'Refund approval', nodes: [], edges: [] });
const run = await workflows.trigger(wf.id as string, {
  input: { message: 'Summarise this week audit report' },
  budgetLimitUsd: 1.5, // optional auto-pause threshold
});
const runs = await workflows.listRuns(wf.id as string);
const runDetail = await workflows.getRun(wf.id as string, run.id as string);
```

| Method | Returns | Endpoint |
|---|---|---|
| `list(query?)` | `Promise<WorkflowRecord[]>` | `GET .../workflows` |
| `get(id)` | `Promise<WorkflowRecord>` | `GET .../workflows/:id` |
| `create(data)` | `Promise<WorkflowRecord>` | `POST .../workflows` |
| `update(id, data)` | `Promise<WorkflowRecord>` | `PATCH .../workflows/:id` |
| `delete(id)` | `Promise<void>` | `DELETE .../workflows/:id` |
| `trigger(id, opts?)` | `Promise<WorkflowRunRecord>` | `POST .../workflows/:id/runs` |
| `listRuns(id, query?)` | `Promise<WorkflowRunRecord[]>` | `GET .../workflows/:id/runs` |
| `getRun(id, runId)` | `Promise<WorkflowRunRecord>` | `GET .../workflows/:id/runs/:runId` |

## Connections (FINDING-2 parity with the Python SDK)

`PraesidiaConnections` manages agent-to-agent and agent-to-MCP connections.

```typescript
import { PraesidiaConnections } from '@praesidia/sdk';

const connections = new PraesidiaConnections();
const conn = await connections.createAgent({ clientAgentId, serverAgentId });
await connections.test(conn.id as string);
await connections.updateStatus(conn.id as string, 'ACTIVE'); // ACTIVE|IDLE|ERROR|PENDING|DISCONNECTED
const health = await connections.health(conn.id as string);
```

| Method | Returns | Endpoint |
|---|---|---|
| `list(query?)` | `Promise<ConnectionRecord[]>` | `GET .../connections` |
| `get(id)` | `Promise<ConnectionRecord>` | `GET .../connections/:id` |
| `createAgent(data)` | `Promise<ConnectionRecord>` | `POST .../connections/agent` |
| `createMcp(data)` | `Promise<ConnectionRecord>` | `POST .../connections/mcp` |
| `create(data)` | `Promise<ConnectionRecord>` | alias for `createAgent` |
| `updateStatus(id, status)` | `Promise<ConnectionRecord>` | `PATCH .../connections/:id/status` |
| `delete(id)` | `Promise<void>` | `DELETE .../connections/:id` |
| `test(id)` | `Promise<ConnectionRecord>` | `POST .../connections/:id/test` |
| `health(id)` | `Promise<ConnectionRecord>` | `GET .../connections/:id/health` |

## AI Systems / assets / relationship graph (SDK-0001, parity with be's AISYS-0002)

`PraesidiaAiSystems` manages the AI System inventory, the AI Asset catalog
(agents, models, MCP servers, data sources, ...), the membership linking
assets to systems, and the relationship graph (edges) between assets.

```typescript
import { PraesidiaAiSystems } from '@praesidia/sdk';

const aiSystems = new PraesidiaAiSystems();
const system = await aiSystems.create({ name: 'Support triage bot', criticality: 'high' });
const asset = await aiSystems.adoptAsset({ entityType: 'agent', entityId, aiSystemId: system.id as string });
await aiSystems.attachAsset(system.id as string, { assetId: asset.id as string, role: 'primary' });
await aiSystems.createRelationship({
  sourceAssetId: asset.id as string,
  targetAssetId: otherAssetId,
  relationshipType: 'CALLS',
});
```

| Method | Returns | Endpoint |
|---|---|---|
| `list(query?)` | `Promise<AiSystemRecord[]>` | `GET .../ai-systems` |
| `get(id)` | `Promise<AiSystemRecord>` | `GET .../ai-systems/:id` |
| `getSummary(id)` | `Promise<AiSystemSummaryResponse>` | `GET .../ai-systems/:id/summary` |
| `create(data)` | `Promise<AiSystemRecord>` | `POST .../ai-systems` |
| `update(id, data)` | `Promise<AiSystemRecord>` | `PATCH .../ai-systems/:id` |
| `updateOwners(id, data)` | `Promise<AiSystemRecord>` | `PATCH .../ai-systems/:id/owners` |
| `transitionLifecycle(id, status)` | `Promise<AiSystemRecord>` | `PATCH .../ai-systems/:id/lifecycle` (ungated targets only; `production`/`retired` throw) |
| `requestLifecycleTransition(id, { toStatus, reason? })` | `Promise<AiSystemLifecycleTransitionRequest>` | `POST .../ai-systems/:id/lifecycle-requests` |
| `listLifecycleRequests(query?)` | `Promise<AiSystemLifecycleTransitionRequest[]>` | `GET .../ai-systems/lifecycle-requests` (default `status: 'PENDING'`) |
| `approveLifecycleTransition(requestId, { reason? }?)` | `Promise<AiSystemLifecycleTransitionRequest>` | `POST .../ai-systems/lifecycle-requests/:requestId/approve` |
| `rejectLifecycleTransition(requestId, { reason? }?)` | `Promise<AiSystemLifecycleTransitionRequest>` | `POST .../ai-systems/lifecycle-requests/:requestId/reject` |
| `retire(id, { retentionPolicy, reason, retentionUntil? })` | `Promise<RetireAiSystemResult>` | `POST .../ai-systems/:id/retire` (202) |
| `reapprove(id, { materialChangeId, reason? })` | `Promise<AiSystemRecord>` | `POST .../ai-systems/:id/reapprove` |
| `archive(id)` | `Promise<AiSystemRecord>` | `POST .../ai-systems/:id/archive` |
| `restore(id)` | `Promise<AiSystemRecord>` | `POST .../ai-systems/:id/restore` |
| `delete(id)` | `Promise<void>` | `DELETE .../ai-systems/:id` (soft-delete) |
| `listAssets(query?)` | `Promise<AiAssetRecord[]>` | `GET .../ai-assets` |
| `createAsset(data)` | `Promise<AiAssetRecord>` | `POST .../ai-assets` |
| `getAsset(id)` | `Promise<AiAssetRecord>` | `GET .../ai-assets/:id` |
| `updateAsset(id, data)` | `Promise<AiAssetRecord>` | `PATCH .../ai-assets/:id` |
| `archiveAsset(id)` | `Promise<AiAssetRecord>` | `POST .../ai-assets/:id/archive` |
| `restoreAsset(id)` | `Promise<AiAssetRecord>` | `POST .../ai-assets/:id/restore` |
| `adoptAsset(data)` | `Promise<AiAssetRecord>` | `POST .../ai-assets/adopt` (idempotent) |
| `attachAsset(aiSystemId, data)` | `Promise<AiSystemAssetRecord>` | `POST .../ai-systems/:id/assets` |
| `changeAssetRole(aiSystemId, assetId, data)` | `Promise<AiSystemAssetRecord>` | `PATCH .../ai-systems/:id/assets/:assetId/role` |
| `detachAsset(aiSystemId, assetId)` | `Promise<void>` | `DELETE .../ai-systems/:id/assets/:assetId` |
| `createRelationship(data)` | `Promise<AssetRelationshipRecord>` | `POST .../asset-relationships` |
| `listRelationships(query?)` | `Promise<AssetRelationshipRecord[]>` | `GET .../asset-relationships` |
| `getRelationship(id)` | `Promise<AssetRelationshipRecord>` | `GET .../asset-relationships/:id` |
| `updateRelationship(id, data)` | `Promise<AssetRelationshipRecord>` | `PATCH .../asset-relationships/:id` |
| `archiveRelationship(id)` | `Promise<AssetRelationshipRecord>` | `POST .../asset-relationships/:id/archive` |
| `restoreRelationship(id)` | `Promise<AssetRelationshipRecord>` | `POST .../asset-relationships/:id/restore` |
| `traverse(query)` | `Promise<AssetGraphTraversalResponse>` | `GET .../asset-relationships/graph/traverse` |
| `putSystemByExternalId(externalId, data)` | `Promise<AiSystemDesiredStateResult>` | `PUT .../ai-systems/by-external-id/:externalId` |
| `deleteSystemByExternalId(externalId)` | `Promise<AiSystemDesiredStateResult>` | `DELETE .../ai-systems/by-external-id/:externalId` (archives) |
| `putAssetByExternalId(externalId, data)` | `Promise<AiAssetDesiredStateResult>` | `PUT .../ai-assets/by-external-id/:externalId` |
| `deleteAssetByExternalId(externalId)` | `Promise<AiAssetDesiredStateResult>` | `DELETE .../ai-assets/by-external-id/:externalId` (archives) |
| `putRelationshipByExternalId(externalId, data)` | `Promise<AssetRelationshipDesiredStateResult>` | `PUT .../asset-relationships/by-external-id/:externalId` |
| `deleteRelationshipByExternalId(externalId)` | `Promise<AssetRelationshipDesiredStateResult>` | `DELETE .../asset-relationships/by-external-id/:externalId` (archives) |

**Approval-gated lifecycle (be AISYS-0018).** Moving into `production` or `retired`
needs an approved request; `transitionLifecycle(id, 'production' | 'retired')` throws
`PraesidiaConfigError` without sending. File the request with
`requestLifecycleTransition` (or `retire`, which also records the retention policy),
then an ORGANIZATION_OWNER approves it. Approval is what applies the move (and, for
`retired`, revokes attached agents' credentials and archives the system).

```typescript
// requester (ai_systems.update)
const req = await aiSystems.requestLifecycleTransition(systemId, { toStatus: 'production', reason: 'Assessment passed' });
// approver (ORGANIZATION_OWNER), e.g. from the pending queue
const [pending] = await aiSystems.listLifecycleRequests({ aiSystemId: systemId });
await aiSystems.approveLifecycleTransition(pending.id, { reason: 'Reviewed' }); // or rejectLifecycleTransition

// retirement (ai_systems.archive): 202 with the request id and blast-radius preview
const { requestId, preview } = await aiSystems.retire(systemId, {
  retentionPolicy: 'Audit evidence kept 7 years, then destroyed.',
  reason: 'Superseded by the v3 claims model.',
});
await aiSystems.approveLifecycleTransition(requestId);
```

Python parity: `sdk-python` ships the same request/approve/reject/retire/reapprove
methods; `listLifecycleRequests` is TS-only for now (documented gap).

`reapprove(id, { materialChangeId })` clears the re-approval flag a material change
leaves on a `production` system (ORGANIZATION_OWNER; 409 unless `materialChangeId` is
the change the flag names now).

`createAsset`/`putAssetByExternalId` accept only a client `source`
(`AI_ASSET_CLIENT_SOURCES`: `manual` (the default), `api`, `import`). The other
`AI_ASSET_SOURCES` (`runtime_observation`, `discovery_connector`,
`entitlement_projection`) are written only by the platform's own pipelines.
`listAssets({ source })` still filters on all of them (be BE-1529, SDK-0317).

Every `list*`/`listAssets`/`listRelationships` also has a `*Page` (full
pagination envelope) and `*All` (auto-paginating async generator) sibling,
matching the `listPage`/`listAll` convention above (SCAN2-011).

`traverse({ assetId, direction?, maxDepth?, assetTypes?, relationshipTypes?,
includeArchived? })` (be's AISYS-0003) walks the asset graph from an anchor
node and returns `{ nodes, edges, stats }` — the anchor's shortest-hop
reachability TREE (one inbound edge per non-anchor node), not the full
induced subgraph of every edge between reached nodes. `maxDepth` above
`AI_SYSTEM_GRAPH_MAX_DEPTH` (default 6) is clamped, not rejected
(`stats.depthClamped`); an oversized result 413s
(`AI_SYSTEM_GRAPH_MAX_NODES`, default 2000) rather than truncating.

`getSummary(id)` (be's AISYS-0004) returns `{ compliance, risk,
evaluations, cost, evidence, unlinkedAssets }` — each section
`{ available, reason?, counts?, updatedAt? }`. `available: false` means the
backing service cannot filter by this AI System's linked asset entity ids
at all (see `reason`); `cost` is always `available: false` today
(AISYS-0025 tracks the gap).

`put{System,Asset,Relationship}ByExternalId(externalId, data)` (be's
BE-0579, SDK-0302/PRAE-228/229) declaratively create-or-update a row keyed
by an externally-owned `externalId` — the shape IaC tooling (Terraform
provider, k8s operator) needs instead of a lookup-then-create/update round
trip. Each returns `DesiredStateOutcome<T>` —
`{ id, externalId, created, changed, updatedAt, resource }` — `changed` is
the plan-stability signal: the same body sent twice returns `changed: false`
the second time with an unchanged `updatedAt`; nothing was written.
`delete{System,Asset,Relationship}ByExternalId(externalId)` archives (never
a hard delete) and returns the same shape. Another tenant's `externalId`
404s on the `DELETE` rather than leaking existence; every lookup is
org-scoped.

## Audit log read-back (FINDING-2 parity with the Python SDK)

`PraesidiaAudit` reads back the org audit trail — before this, a TS caller had
no way to list/stream/export it (only the guardrail-trigger side effect of
`guard.run()` wrote entries).

```typescript
import { PraesidiaAudit } from '@praesidia/sdk';

const audit = new PraesidiaAudit();
const page = await audit.list({ action: 'agent.created', limit: 50 });

for await (const event of audit.stream({ fromDate: '2026-01-01' })) {
  console.log(event.action, event.createdAt);
}

const csv = await audit.export({ format: 'csv', action: 'agent.created' });
```

### Decision Receipts and audit packages

```typescript
// The Decision Record behind one decision (decisionId from an interaction decision),
// or behind one audit row.
const receipt = await audit.getDecisionReceipt(decisionId);
const same = await audit.getReceipt(receipt.rowId);

// Multi-artifact audit package: request (202), poll, download.
let job = await audit.requestPackage({ from: '2026-09-01T00:00:00Z', to: '2026-09-25T00:00:00Z' });
while (job.status === 'queued' || job.status === 'running') {
  await new Promise((r) => setTimeout(r, 5_000));
  job = await audit.getPackage(job.id);
}
if (job.status === 'failed') throw new Error(job.error ?? 'package failed');
await writeFile('audit-package.zip', await audit.downloadPackage(job.id));

// Signed bundle plus where the server actually cut the range.
const { bytes, effectiveTo, windowClamp } = await audit.downloadBundle({
  from: '2026-09-24T00:00:00Z', to: '2026-09-25T10:30:00Z',
});
```

Every id must be a UUID (`PraesidiaConfigError` otherwise, before any request).
`downloadPackage` throws `PraesidiaApiError` with status 409 until the job is
`done` and 410 after the 7-day retention. The bundle is cut at the end of the
last Merkle-rooted hour unless `includeUnrooted: true`; `downloadBundle` returns
the `X-Praesidia-Requested-To` / `-Effective-To` / `-Window-Clamp` headers as
`requestedTo` / `effectiveTo` / `windowClamp` (`null` if the server omits them).
`exportBundle` accepts the same `includeUnrooted` and still returns bare bytes.
**No download verifies anything**: run `praesidia-verify` on the bundle (or the
package's `evidence/audit-bundle.zip`).

> **No `resourceType` filter, by design.** The backend `FilterAuditDto`
> whitelists only `search`/`action`/`startDate`/`endDate` under
> `forbidNonWhitelisted` — a `resourceType` param 400s the whole request.
> `resourceType` is derived from the `action` prefix at read time, not a
> stored column. Filter by `action` instead (e.g. `action: 'agent.created'`).
>
> **`stream()` stops on an empty page, not a short one.** The SDK clamps a
> requested stream batch above the backend's validated maximum to 100 before
> sending it. Treating that first full-but-clamped page as the last would
> silently drop everything past row 100. This mirrors the Python SDK's
> `BUGHUNT-SDK-01` fix.

| Method | Returns | Endpoint |
|---|---|---|
| `list(query?)` | `Promise<AuditLogEntry[]>` | `GET .../audit-logs` |
| `stream(query?)` | `AsyncGenerator<AuditLogEntry>` | pages `GET .../audit-logs` until empty |
| `export(query?)` | `Promise<Uint8Array>` | `GET .../audit-logs/export` |

## Analytics (FINDING-1 — the README always claimed this; now it ships)

`PraesidiaAnalytics` queries usage/cost/performance data, matching the
Python SDK's `AnalyticsResource`.

```typescript
import { PraesidiaAnalytics } from '@praesidia/sdk';

const analytics = new PraesidiaAnalytics();
const usage = await analytics.usage({ days: 30 });
const trends = await analytics.costTrends({ days: 90 });
const top = await analytics.topAgents({ limit: 5 });
const csv = await analytics.export();
```

| Method | Returns | Endpoint |
|---|---|---|
| `usage(query?)` | `Promise<AnalyticsResult>` | `GET .../analytics` |
| `costTrends(query?)` | `Promise<AnalyticsResult>` | `GET .../analytics/advanced/cost-trends` (ADVANCED_ANALYTICS) |
| `agentPerformance(query?)` | `Promise<AnalyticsResult>` | `GET .../analytics/advanced/agent-performance` (ADVANCED_ANALYTICS) |
| `topAgents(query?)` | `Promise<AnalyticsResult>` | `GET .../analytics/advanced/top-agents` (ADVANCED_ANALYTICS) |
| `export(query?)` | `Promise<Uint8Array>` | `GET .../analytics/export` (ANALYTICS_EXPORT + ADVANCED_ANALYTICS) |
| `captureState()` | `Promise<AnalyticsCaptureState>` | `GET .../analytics/capture-state` |
| `agentAnalytics(agentId, query?)` | `Promise<AgentAnalyticsResult>` | `GET .../analytics/agents/:agentId` |
| `events(query?)` | `Promise<AnalyticsEvent[]>` | `GET .../analytics/events` (paginated) |
| `activityLog(query?)` | `Promise<AnalyticsEvent[]>` | `GET .../analytics/activity-log` (PRA-QA-261 alias of `events`) |
| `recordEvent(input)` | `Promise<AnalyticsEvent>` | `POST .../analytics/events` (`ANALYTICS_CREATE`, JWT-only — see below) |
| `securityMetrics(query?)` | `Promise<SecurityMetricsResult>` | `GET .../analytics/advanced/security` (ADVANCED_ANALYTICS) |
| `usageHeatmap(query?)` | `Promise<UsageHeatmapResult>` | `GET .../analytics/advanced/usage-heatmap` (ADVANCED_ANALYTICS) |
| `complianceMetrics(query?)` | `Promise<ComplianceMetricsResult>` | `GET .../analytics/advanced/compliance` (ADVANCED_ANALYTICS) |
| `anomalies(query?)` | `Promise<AnalyticsAnomaly[]>` | `GET .../analytics/advanced/anomalies` (ADVANCED_ANALYTICS, default 7-day window) |
| `costByTeam(query?)` | `Promise<CostByTeamEntry[]>` | `GET .../analytics/advanced/cost-by-team` (ADVANCED_ANALYTICS) |
| `modelComparison(query?)` | `Promise<ModelComparisonEntry[]>` | `GET .../analytics/advanced/model-comparison` (ADVANCED_ANALYTICS) |

> **AUD-0063 — full route parity.** `PraesidiaAnalytics` used to cover 5 of
> be-core's 15 `/organizations/:orgId/analytics*` paths; the 11 methods above
> close that gap (both SDKs — see the Python README). `recordEvent` is the
> only write on this resource: it needs `ANALYTICS_CREATE` (not the
> `ANALYTICS_VIEW` every read method here needs) and has no mintable API-key
> scope, so it must authenticate with a JWT bearer. It is also a bare,
> never-retried POST — this route is not in be-core's `Idempotency-Key`
> allowlist (see Retry below).

## Retry (FINDING-4) — bounded, idempotency-safe by default

Every SDK client retries **only** requests that are safe to repeat: GET,
DELETE, and any POST/PATCH the caller explicitly marks with an
`idempotencyKey`. **A bare POST (task submission, agent/workflow/connection
creation) is never retried** — retrying an already-applied create/charge is a
duplication bug, not a resilience feature.

**R-SDK-1 — `idempotencyKey` is allow-listed, not a blanket promise.**
be-core only deduplicates a request server-side on `Idempotency-Key` for
five routes today: `POST /organizations/:orgId/tasks`, `POST /a2a/tasks`,
`POST /a2a/tasks/:taskId/result`, and the interaction decision and outcome
POSTs (`POST /organizations/:orgId/interaction-decisions[/outcome]`, which
`PraesidiaInteractionHooks` keys automatically). Every other route — including every
PATCH — ignores the header entirely. Passing `idempotencyKey` to
`PraesidiaClient.post`/`.patch` for any other path throws
`PraesidiaConfigError` immediately (no request is sent) rather than silently
retrying a write the server can double-apply.

Retries use jittered exponential backoff, honour a `Retry-After` header on
`429`/`5xx`, and are bounded by both an attempt count and a wall-clock budget:

```typescript
const guard = new PraesidiaGuard({
  retry: {
    maxAttempts: 3,     // default: 3 (i.e. up to 2 retries)
    baseDelayMs: 250,   // default: 250
    maxDelayMs: 4000,   // default: 4000
    maxElapsedMs: 15000 // default: 15000 — total budget across all attempts
  },
});

// Disable retries entirely:
const noRetry = new PraesidiaGuard({ retry: false });
```

Every resource class (`PraesidiaGuard`, `PraesidiaAgents`, `PraesidiaCompliance`,
`PraesidiaMemory`, `PraesidiaTelemetry`, `PraesidiaWorkflows`,
`PraesidiaConnections`, `PraesidiaAudit`, `PraesidiaAnalytics`,
`PraesidiaInteractionHooks`) accepts the same
`retry` config field.

> **Known gap:** only `PraesidiaClient.post`/`.patch` currently expose the
> `idempotencyKey` option directly, and only for the three allow-listed
> routes above (in practice: `PraesidiaGuard.logTask`/`.trackToolCall`, the
> two callers of `POST /organizations/:orgId/tasks`). Apart from
> `PraesidiaInteractionHooks.decide`/`.reportOutcome` (SDK-2503), no resource
> method forwards `idempotencyKey` as a public parameter yet — to retry that write
> today you need to drop to the client-level API. Widening this to a
> per-method `idempotencyKey` parameter is a natural follow-up, tracked as a
> known gap rather than silently left unstated.

## Trust passport — verify a peer agent's reputation offline (H3-02f)

`PraesidiaTrust` fetches an agent's signed trust passport from the **public**
trust routes and verifies its detached Ed25519 or KMS-backed P-256/ES256 proof
**locally**, without an online verification call. Offline verification uses the
hand-written primitives in `crypto.ts`
(`verifyEd25519`, `verifyEs256`, `canonicalJson`, and the matching JWK decoders)
— the same offline-verify pattern as
`@praesidia/audit-verifier`. No API key is needed. `verifyEd25519` rejects
small-order and non-canonical public keys and signature `R` values itself
(RFC 8032 §5.1.3, libsodium's blocklist), so the result does not depend on how
strict the runtime's OpenSSL build is.

The supplied JWK is the verification trust anchor. Resolve it from a trusted
DID document or verification bundle; a signature can prove integrity relative
to that key, but cannot by itself prove that an arbitrary key belongs to the
passport's claimed issuer.

**`fetchAndVerify` requires a trust anchor.** The verify route is public and
unauthenticated and returns the passport *and* the key, so checking one against
the other proves nothing — anyone able to answer that request can mint both.
Pass the key (or its fingerprint) that you obtained some other way:

```typescript
import { PraesidiaTrust, jwkThumbprint } from '@praesidia/sdk';

const trust = new PraesidiaTrust(); // no auth — public routes

const { verified, passport, reason } = await trust.fetchAndVerify(peerAgentId, {
  trustedKeys: [issuerJwk],           // array, or a map keyed by kid/issuer
  // expectedFingerprint: 'sha256:…', // alternative: pin the RFC 7638 thumbprint
});
if (verified && passport.credentialSubject.trustScore >= 70) {
  // The signed reputation is genuine and fresh — safe to trust the peer.
}

// With NO anchor the signature is still checked, but the call refuses to
// call the outcome an assurance:
const unpinned = await trust.fetchAndVerify(peerAgentId);
// { verified: false, reason: 'unpinned_key', signatureValid: true }

// Print the thumbprint of a key you trust, to pin it elsewhere:
jwkThumbprint(issuerJwk); // base64url; jwkThumbprintHex() for hex

// Or verify a passport handed to you out-of-band:
const bundle = await trust.fetchVerifyBundle(peerAgentId);
const result = trust.verifyPassport(
  bundle.passport,
  myTrustedJwk,
  `did:web:praesidia.ai:agents:${peerAgentId}`, // optional expectedSubject
);
// result.reason ∈ ok | missing-proof | malformed-public-key
//                  | signature-mismatch | invalid-expiration | expired
//                  | unpinned_key | untrusted_key | fingerprint_mismatch
//                  | subject_mismatch
```

| `fetchAndVerify` anchor | Outcome |
|---|---|
| none | `verified: false`, `reason: 'unpinned_key'`, `signatureValid` truthful |
| `trustedKeys` contains the signing key | `verified: true` (subject to expiry) |
| `trustedKeys` without the signing key | `verified: false`, `reason: 'untrusted_key'` |
| `expectedFingerprint` matches the served key | verified normally against that key |
| `expectedFingerprint` differs | `verified: false`, `reason: 'fingerprint_mismatch'` |
| any anchor, passport is for another subject | `verified: false`, `reason: 'subject_mismatch'`, `signatureValid: true` |

`fetchAndVerify(agentId)` / `fetchAndVerifyAiSystem(aiSystemId)` bind the passport to
the id you asked for: `credentialSubject.id` must equal
`did:web:praesidia.ai:agents:<agentId>` / `did:web:praesidia.ai:ai-systems:<aiSystemId>`
(case-insensitive — the ids are UUIDs). A genuine passport for a different agent of
the same org therefore does not verify, even under a pinned key. `verifyPassport` /
`verifyAiSystemPassport` apply the same check when you pass `expectedSubject`.

`verifyPassport` reconstructs the canonical JSON of the passport with its `proof`
member removed (RFC-8785-style), base64-decodes `proof.proofValue`, and verifies
the substrate-selected signature over those exact bytes; it also checks
`expirationDate`. It
never throws — a malformed passport / key yields `{ verified: false, reason }`.

Signature formats (ADR-0004): `proof.signatureFormat` absent or `1` means the signature is
over the canonical JSON above; `2` means it is over
`"praesidia:trust-passport:v2\n" || canonical JSON` (agent and AI System passports alike).
Any other value is `malformed-passport`. A format-2 signature made for another purpose
(e.g. `governance-badge`) is `signature-mismatch`.

A human-readable PDF of an **AI System's** signed passport (signature
fingerprint + verification URL printed on it) is a public download too:

```ts
import { writeFileSync } from 'node:fs';

const pdf = await trust.fetchAiSystemPassportPdf(aiSystemId); // Uint8Array, starts with %PDF-
writeFileSync('trust-passport.pdf', pdf);
// Unpublished (passportVisibility PRIVATE, the default), unknown or
// soft-deleted AI System → PraesidiaApiError (status 404)
```

The rest of the **AI System** passport routes are public as well — `PraesidiaTrust`
never sends an API key on any of them:

```ts
const passport = await trust.fetchAiSystemPassport(aiSystemId);
// AiSystemTrustPassport: credentialSubject.{aiSystemName, frameworks, attestations,
// posture, redTeam, regulatoryClassification, aibom, dataCategories, incidents,
// models, permissions, evidenceRoot} — each section is { available, counts? }
// or { available: false, reason } (a gap is never reported as a zero count).

const bundle = await trust.fetchAiSystemVerifyBundle(aiSystemId);
// { passport, publicKeyJwk, verificationHint, embed: { badgeUrl, verifyUrl, html, markdown } }

const svg = await trust.fetchAiSystemBadgeSvg(aiSystemId); // string, `<svg …>`
// Unpublished (passportVisibility PRIVATE, the default), unknown or
// soft-deleted AI System → PraesidiaApiError (404); the verify bundle
// answers 503 (retryable) when be cannot load the org signing key.
```

These routes serve a passport only once its owner publishes it: every AI
System starts with `passportVisibility` `PRIVATE` (existing systems included),
and an unpublished one gets the same 404 as an id that does not exist. An org
member with `ai_systems.update` publishes or withdraws it with
`PATCH /organizations/:orgId/ai-systems/:id` — from this SDK, the API-keyed
`PraesidiaAiSystems.update(aiSystemId, { passportVisibility: 'PUBLIC' })`, not
`PraesidiaTrust`.

The bundle's `publicKeyJwk` comes from the same unauthenticated response as the
passport, so it is not a trust anchor on its own. Verify an AI System passport
offline with `verifyAiSystemPassport` / `fetchAndVerifyAiSystem` — same proof,
signature, expiry and trust-anchor rules as the agent methods above (be signs
both passports through one path):

```ts
const { verified, reason, passport } = await trust.fetchAndVerifyAiSystem(aiSystemId, {
  trustedKeys: [issuerJwkFromYourDidDocument], // or expectedFingerprint
});
// No anchor → verified: false, reason: 'unpinned_key' (signatureValid stays truthful)

const offline = trust.verifyAiSystemPassport(passportHandedToYou, myTrustedJwk);
```

The two envelopes are not interchangeable: `verifyPassport` returns
`malformed-passport` for an AI System passport and `verifyAiSystemPassport`
returns it for an agent passport. The AI System check also enforces be's section
contract — a gap (`available: false`) carries a `reason` and never `counts`.

## Interaction hooks — advisory in-runtime guard (SDK-0300)

Shell commands, code runs, file access, browser actions and tool calls run on **your** compute.
Praesidia does not operate or intercept that runtime. `PraesidiaInteractionHooks` is an
**advisory in-runtime guard**: before the action, your code asks Praesidia for a decision
and the SDK enforces that decision in your process. An agent that does not load the SDK, or
skips a hook, is not governed by it. For enforcement Praesidia sits in the path of, route the
action through a governed MCP server (`guard.protectAction`) instead.

```typescript
import { spawnSync } from 'node:child_process';
import { PraesidiaInteractionHooks } from '@praesidia/sdk';

const hooks = new PraesidiaInteractionHooks({
  apiKey: process.env.PRAESIDIA_API_KEY, // org key with agents:invoke
  orgId: process.env.PRAESIDIA_ORG_ID,
  agentId: process.env.PRAESIDIA_AGENT_ID, // required: the agent tool policies decide
  requestTimeoutMs: 5000, // how long a hook waits before its fail mode applies
});

await hooks.beforeExec({ command: 'git status', cwd: '/srv/repo' }); // throws on deny
spawnSync('git', ['status'], { cwd: '/srv/repo' });
```

| Hook | Asks as | Default on outage |
|---|---|---|
| `beforeToolCall({ toolName, arguments? })` | `model_to_tool.<toolName>` | fail-open |
| `beforeExec({ command, args?, cwd?, runtime? })` | `agent_to_shell.exec` (`runtime: 'code'` → `agent_to_code_execution.exec`) | **fail-closed** |
| `beforeFsAccess({ path, mode })` | `agent_to_filesystem.<mode>` | fail-open for `read` / `list`, **fail-closed** for `write` / `delete` |
| `beforeBrowserAction({ action, url?, arguments? })` | `agent_to_browser.<action>` | fail-open |
| `beforeInteraction(type, { name, arguments? }, { failMode? })` | `<type>.<name>`, any of `INTERACTION_TYPES` | **fail-closed** |

Every hook resolves to `{ decision }` on `allow`, throws `InteractionDeniedError` on `deny`,
and on `require_approval` blocks: it re-asks every `approvalPollIntervalMs` (default 2 s),
echoing `approvalId`, until a human approves (resolves) or rejects / the approval expires
(throws). After `approvalTimeoutMs` (default 10 min) it throws with
`reasonCode: 'approval_wait_timeout'`. `onApprovalRequired(decision)` fires once when the wait
starts, so you can tell someone which approval to act on.

**Task envelope (BE-1609).** Pass `taskId` (UUID) to the constructor, e.g.
`new PraesidiaInteractionHooks({ taskId: toolCallContextFromTask(task).taskId })`, and every
decision is also checked against that task's delegation envelope and the agent's assurance
policy. Use one hooks instance per task. `decision.constrainedBy` names the layer that denied
or asked for approval: `org_policy`, `delegation` or `assurance`. It is `null` when nothing
constrained the decision. If the server cannot read the task's delegation chain, the decision
is a deny with `delegation_chain_unavailable`; if it cannot evaluate assurance, a deny with
`assurance_evaluation_error`.

**Stale task (BE-2836).** Without a capability token, the server holds the agent to every live
delegated task it executes, whether or not you pass `taskId`. A `taskId` that is not a live task
this agent executes (completed, unknown, or another agent's) gets a 403, which the SDK throws as
`InteractionTaskNotLiveError` (a `PraesidiaApiError`, status 403, with `taskId`). Every decision
under that `taskId` fails the same way, so stop using it: build a new hooks instance with the
current task's id, or without `taskId`. It is never retried and a fail-open hook throws it. The
Decision Record (`audit.list()` row `details`) carries the keys typed as
`InteractionDecisionRecordDetails`: `delegationReason: 'delegation_implicit_live_task'` and
`constrainingTaskId` when the live tasks decided, `delegationBypass: 'owner'` when an owner-level
human decided without a token.

```ts
try {
  await hooks.beforeToolCall({ toolName: 'search.web' });
} catch (err) {
  if (err instanceof InteractionTaskNotLiveError) hooks = new PraesidiaInteractionHooks({ ...config, taskId: undefined });
  else throw err;
}
```

**Reporting the outcome.** After an `allow`, report what happened once. Pass exactly one key:
`approvalId` when the allow came from a consumed approval
(`decision.reasonCode === 'approval_consumed'`), otherwise `decisionId` (a plain allow, where
`decision.approvalId` is `null`). Neither or both throws `PraesidiaConfigError` before any
request.

```ts
const { decision } = await hooks.beforeInteraction('agent_to_email', { name: 'send' });
const sent = await mailer.send(msg);
await hooks.reportOutcome({
  ...(decision!.approvalId ? { approvalId: decision!.approvalId } : { decisionId: decision!.decisionId }),
  status: 'succeeded', // | 'failed_no_effect' | 'partial' | 'unknown'
  result: sent,        // hashed locally (sha256 of JCS); only resultCommitment is sent
  targetSystem: 'smtp',
  targetTransactionId: sent.messageId,
}); // → { approvalId, reportedDecisionId, decisionId }
```

The receipt echoes the key you sent (`approvalId` or `reportedDecisionId`; the other is
`null`). Its `decisionId` is the outcome's own Decision Record id, the key for
`GET /organizations/:orgId/audit/decisions/:decisionId/receipt`. `result` never leaves your
process. A second report, or one the server cannot match, is refused with a single
`PraesidiaApiError` (status 409); it is not retried. An unmatched report is an approval that
was not consumed, or a decisionId that is not a plain allow for this agent. A verdict reused
from the decision cache shares its `decisionId`, so only its first run can report. Only the
principal the allow was issued to may report it; anyone else gets a 403.

**Retries and `Idempotency-Key` (SDK-2503, needs be ≥ BE-1759).** Every decision and outcome
POST carries an `Idempotency-Key`: a fresh UUID v4 per logical call, reused on the SDK's own
retries of that call (network error, 429, 5xx; the `retry` config, default 3 attempts in 15 s,
`retry: false` for one attempt). A retry after a lost response replays the stored answer, so it
writes no second Decision Record or outcome. Each approval poll adds `approvalId`, a new body, so
it gets a new key. Pass your own key with `decide(type, action, approvalId, { idempotencyKey })`
or `reportOutcome({ ..., idempotencyKey })` (1-255 characters, no surrounding whitespace; it is
sent verbatim and never enters the body). The same key with a different body throws
`IdempotencyKeyReusedError` (a `PraesidiaApiError`, status 409, `code: 'IDEMPOTENCY_KEY_REUSED'`),
once, with no retry. A 409 without that code means the first request with the key is still
running: it is a plain `PraesidiaApiError`, not retried; repeat the call with the same key once
the first one has finished. A retry also lengthens how long a hook waits before its fail mode
applies (up to `maxAttempts` × `requestTimeoutMs`, bounded by `maxElapsedMs`).

**Fail mode.** An outage is a network error, a timeout, a 408 / 5xx, or a malformed
response. A fail-closed hook then throws `InteractionDecisionUnavailableError`; a fail-open
hook resolves to `{ decision: null, failOpenError }`. Any other 4xx (bad key, unknown agent,
feature not enabled, and 429) always throws `PraesidiaApiError`, on every hook (SDK-0352): an
end user can cause a 429 from a shared egress IP, so it must never open a fail-open hook. The defaults fail closed
where a skipped check can do irreversible local damage with no other Praesidia control in the
path (shell / code execution, filesystem writes), and fail open for read-only and
lower-impact checks so a Praesidia outage does not stop every agent. Override per class with
`failMode: { toolCall, exec, fsRead, fsWrite, browser }` (`'open' | 'closed'`). An outage while
waiting for an approval never turns into an allow: the hook keeps waiting, then times out.

**Cache.** A verdict is reused for its `ttlSeconds` for the identical request, in memory, per
hooks instance (at most 1000 entries). be sends 30, or 0 (never reused) when the answer came
from a rule that requires approval (including the `allow` of a consumed approval, and the `allow`
that `observe` mode gives in place of an approval), from a daily-limited rule's `allow`, or from
a failed policy evaluation (`reasonCode` `policy_service_error`, a deny in `enforce` mode). Cached
verdicts are valid only under the `policyFingerprint` that produced them: a response with a new
fingerprint evicts them all. A policy change therefore takes effect within `ttlSeconds`.

In `observe` governance mode be answers `allow` and records the would-be decision; in `off` it
answers `allow`. `decide(type, action, approvalId?, { idempotencyKey? })` is the raw call (no cache, no wait, no fail
mode). Action names must be dot-separated `[A-Za-z0-9_-]` segments (be's rule); anything else
throws `PraesidiaConfigError` before a request is sent.

Python parity: the `praesidia` Python SDK ships the same hooks (`PraesidiaInteractionHooks` and
`AsyncPraesidiaInteractionHooks`, SDK-0301) with the same fail-mode defaults, verdicts and fixture.
Python also has a `guarded()` tool-wrapping helper that this SDK does not have yet.

## GitHub Action: release gate (SDK-2502)

`actions/release-gate` is a composite action (bash + curl + jq; not part of the npm package) that
gates a job on the deployment quality gate, optionally importing a CycloneDX AIBOM first:

```yaml
- uses: praesidia-ai/sdk/actions/release-gate@v<tag>
  id: gate
  with:
    api-url: https://api.praesidia.ai        # your deployment's API host
    api-key: ${{ secrets.PRAESIDIA_API_KEY }} # scope ci:gate (+ aibom:write with aibom-path)
    org-id: ${{ vars.PRAESIDIA_ORG_ID }}
    ai-system-id: ${{ vars.PRAESIDIA_AI_SYSTEM_ID }}
    eval-run-id: ${{ env.EVAL_RUN_ID }}
    commit-sha: ${{ env.EVAL_COMMIT_SHA }}   # optional: the 40-hex SHA the run evaluated
    aibom-path: bom.cdx.json                 # optional
```

It calls `POST organizations/:orgId/ai-systems/:aiSystemId/aibom/import` (when `aibom-path` is
set), then `POST .../quality-gate/evaluate` with `{ evalRunId, commitSha? }`. It fails closed: the
step fails on `effectiveResult: "fail"`, a missing/unknown verdict, any non-2xx (401, 404, 409…),
an unreachable API or unparsable JSON. `advisory_fail` (only non-blocking thresholds failed) passes
with a warning. Outputs: `verdict` (the `effectiveResult`) and `report-url` (empty until the API
returns a `reportUrl`). The key is masked and sent to curl on stdin, never in argv. This is a
GitHub-only surface; the Python SDK has no equivalent because it is language-independent.

## Fail-open / fail-closed

| Scenario | Default behaviour |
|---|---|
| Input guardrail blocks content | Always throws `GuardrailBlockedError` before `fn` runs |
| Output guardrail blocks content | Returned for inspection by default; `strict: true` / `throwOnBlock` throws |
| Outage reaching Praesidia (network error, timeout, 408, 5xx, malformed 2xx) | Degrades to local rules, emits `console.warn` |
| Any other 4xx from Praesidia, including 429 | Always throws `PraesidiaApiError`, in every mode (SDK-0348) |
| Content over `MAX_GUARD_CONTENT_LENGTH` (100,000 code points) | Throws `GuardContentTooLargeError` before any request (SDK-0348) |
| `context` / body JSON cannot encode (BigInt, circular) | Throws `PraesidiaConfigError` (`cause` = the `TypeError`) before any request, in every mode (SDK-0357) |
| A header value with CR, LF, NUL or another character outside RFC 9110 field-value (e.g. an end-user-derived `chainId`) | Throws `PraesidiaConfigError` before any request, in every mode (SDK-0358) |
| Any other local (non-outage) error | Rethrown as-is. The Python SDK wraps a non-`PraesidiaError` in `PraesidiaError` (original as `__cause__`) |
| `strict: true` + outage | Throws `PraesidiaApiError` |
| `failOpen: true` | Silently degrades (no `console.warn`) |

### Control-plane failure mode (SDK-0335)

The failure mode applies only to an **outage** of `guardrails/validate` (and `logTask`):
unreachable host, timeout, 408 or 5xx. Any other 4xx (400, 401, 403, 404, 413, 422, and 429)
always throws `PraesidiaApiError` and never opens a degraded episode (SDK-0348). An end user can
cause those responses (oversized content, a rate limit on a shared egress IP), so degrading on them
would let that user switch the org's guardrails off. A local error is never an outage either: a body the SDK cannot
serialise, or any other exception raised before the request is sent, throws (SDK-0357).

| `failureMode` | On a control-plane error | Legacy flags that map to it (when `failureMode` is unset) |
|---|---|---|
| `fail_closed` | Rethrows (`PraesidiaApiError` for HTTP errors) | `strict: true` (and `failOpen` not set) |
| `local_rules` | Serves the bundled local rules, `console.warn` | neither flag (**today's default**) |
| `fail_open` | Serves the bundled local rules silently | `failOpen: true` (wins over `strict`) |

- Results served locally because the control plane failed carry `local: true, degraded: true`.
  Offline mode (no API key / org id) is `local: true` without `degraded`.
- `maxDegradedMs` bounds a degraded episode. Once the control plane has been failing for longer
  than this, `local_rules` and `fail_open` throw like `fail_closed` (with one `console.error`)
  until a call succeeds. **Unset = unbounded**: an outage of any length degrades to local rules.
- `onDegraded({ operation, since, mode })` fires once when an episode starts (`since` is epoch
  ms) and again only after a successful call has ended it. Errors it throws are swallowed.
- `strict` still controls output-block throwing and missing-config errors independently of
  `failureMode`. The default stays `local_rules`; switching it to `fail_closed` would be a
  breaking change and is not made here.
- Python parity: the `praesidia` Python SDK has the same options as `failure_mode`,
  `max_degraded_ms` and `on_degraded` (SDK-0336).

These rows are `PraesidiaGuard`'s. Interaction hooks have their own per-hook defaults: see
[Interaction hooks](#interaction-hooks--advisory-in-runtime-guard-sdk-0300).

## Error types

```typescript
import { GuardrailBlockedError, PraesidiaApiError, PraesidiaConfigError } from '@praesidia/sdk';

try {
  await guard.run(fn, { input });
} catch (err) {
  if (err instanceof GuardrailBlockedError) {
    // err.triggered — array of triggered guardrails with severity, category, reason
    console.log('Blocked by:', err.triggered.map(t => t.guardrailName));
  }
}
```

`ProtectedActionDeniedError` and `UnsupportedProtectedActionTargetError` (PA01 DX-001) are thrown
only by `guard.protectAction` — see [above](#guardprotectactionopts--promiseprotectactionresult-pa01-dx-001).

`InteractionDeniedError` (`interactionType`, `actionName`, `reasonCode`, `decision`) and
`InteractionDecisionUnavailableError` (`cause` = the outage) are thrown only by
`PraesidiaInteractionHooks`. `IdempotencyKeyReusedError` (a `PraesidiaApiError`, status 409,
`code: 'IDEMPOTENCY_KEY_REUSED'`) means an `Idempotency-Key` was reused with a different body; it
is never retried. `InteractionTaskNotLiveError` (a `PraesidiaApiError`, status 403, `taskId`)
means the hooks' `taskId` is not a live task this agent executes (BE-2836). See
[Interaction hooks](#interaction-hooks--advisory-in-runtime-guard-sdk-0300).

`GuardContentTooLargeError` (`code: 'CONTENT_TOO_LARGE'`, `length`, `maxLength`) is thrown by
`checkInput` / `checkOutput` / `run` / `guardInput` / `guardOutput` before any request when content
exceeds `MAX_GUARD_CONTENT_LENGTH` (100,000 Unicode code points, the API's limit). Offline mode
(no API key) does not check the length.

`InvalidMcpServerIdError` (a `PraesidiaConfigError`) is thrown only by `gatewayFetch` — see
[Gateway calls tagged with an MCP server id](#gateway-calls-tagged-with-an-mcp-server-id-sdk-0312).

## Praesidia API endpoints used

| Operation | Endpoint | Required scope |
|---|---|---|
| `checkInput` / `checkOutput` | `POST /organizations/:orgId/guardrails/validate` | `agents:invoke` or `*` |
| `logTask` | `POST /organizations/:orgId/tasks` | `agents:invoke` or `*` |
| `protectAction` (PA01 DX-001) | `POST /organizations/:orgId/mcp-servers/:id/tools/:toolName/call` | `MCP_SERVERS_UPDATE` (`mcp:manage` key scope) |
| `PraesidiaInteractionHooks.*` (SDK-0300) | `POST /organizations/:orgId/interaction-decisions` | `agents:invoke` (`AGENT_POLICIES` feature) |
| `requestReport` | `POST /organizations/:orgId/compliance/eu-ai-act/reports` | `COMPLIANCE_MANAGE` |
| `getReportStatus` / `getReportJson` / `getReportPdf` | `GET /organizations/:orgId/compliance/eu-ai-act/reports/:id[/json\|/pdf]` | `COMPLIANCE_VIEW` |
| `PraesidiaTelemetry.emit*` | `POST /telemetry/otlp/v1/traces` | `telemetry:ingest` or `*` |
| `PraesidiaMemory.*` | `POST/GET/DELETE /organizations/:orgId/memories[/…]` | `MEMORY_CREATE` / `MEMORY_VIEW` / `MEMORY_ERASE` / `MEMORY_DELETE` |
| `PraesidiaAgents.*` | `GET/POST/PATCH/DELETE /organizations/:orgId/agents[/…]` | agent management permissions |
| `PraesidiaWorkflows.*` | `GET/POST/PATCH/DELETE /organizations/:orgId/workflows[/…]` | `WORKFLOWS_*` (`APPROVAL_WORKFLOWS` feature) |
| `PraesidiaConnections.*` | `GET/POST/PATCH/DELETE /organizations/:orgId/connections[/…]` | `CONNECTIONS_*` (`A2A_COMMUNICATION` feature) |
| `PraesidiaAiSystems.*` | `GET/POST/PATCH/DELETE /organizations/:orgId/ai-systems\|ai-assets\|asset-relationships[/…]` | `AI_SYSTEMS_*` / `AI_ASSETS_*` (`AI_SYSTEMS` feature) |
| `PraesidiaAudit.*` | `GET /organizations/:orgId/audit-logs[/export]` | `AUDIT_VIEW` / `AUDIT_EXPORT` |
| `PraesidiaAudit.getReceipt` / `getDecisionReceipt` | `GET /organizations/:orgId/audit/:rowId/receipt`, `…/audit/decisions/:decisionId/receipt` | `AUDIT_VIEW` |
| `PraesidiaAudit.requestPackage` / `getPackage` / `downloadPackage` | `POST /organizations/:orgId/audit/packages`, `GET …/packages/:id[/download]` | owner/compliance officer + `COMPLIANCE_VIEW` |
| `PraesidiaAudit.exportBundle` / `downloadBundle` | `GET /organizations/:orgId/audit/bundle` | owner/compliance officer + `COMPLIANCE_VIEW` |
| `PraesidiaAnalytics.*` | `GET /organizations/:orgId/analytics[/…]` | `ANALYTICS_VIEW` / `ANALYTICS_EXPORT` (`advanced/*` needs `ADVANCED_ANALYTICS`) |
| `PraesidiaTrust.fetch*` | `GET /trust/passport/:agentId[/verify]` | public (no auth) |
| `PraesidiaTrust.fetchAiSystemPassportPdf` | `GET /trust/passport/ai-systems/:aiSystemId/passport.pdf` | public (no auth) |
| `PraesidiaTrust.fetchAiSystemPassport` | `GET /trust/passport/ai-systems/:aiSystemId` | public (no auth) |
| `PraesidiaTrust.fetchAiSystemVerifyBundle` | `GET /trust/passport/ai-systems/:aiSystemId/verify` | public (no auth) |
| `PraesidiaTrust.fetchAndVerifyAiSystem` | `GET /trust/passport/ai-systems/:aiSystemId/verify` + offline verify | public (no auth) |
| `PraesidiaTrust.fetchAiSystemBadgeSvg` | `GET /trust/passport/ai-systems/:aiSystemId/badge.svg` | public (no auth) |

Authentication: `Authorization: Bearer <apiKey>` (org-scoped API key). The trust
passport routes are public; `PraesidiaTrust` verifies signatures offline.

## Not covered by this SDK

The following `be` API surfaces have no client methods here, intentionally — they are
org-admin / dashboard configuration screens consumed by the Praesidia UI, not primitives an
agent-runtime caller needs:

- **`governance-controls`** (catalog/create/patch/review/runs) — the governance-policy admin
  catalog.
- **`mcp-servers/inventory`** (list/refresh/review/dependencies) — the MCP tool-inventory review
  surface.
- **`runtime-installations`** management (create/patch/challenge/disable/list/verify) — only the
  opaque, already-provisioned `runtimeInstallationId` is accepted (see `PraesidiaProtectedHttp`
  config); creating and verifying an installation is done once, in the app.
- **`identity`** provider/binding/consent/grant/revocation CRUD — only `PraesidiaIdentity`'s
  `exchange` / `downExchange` / `introspect` (token-exchange and introspection) are covered.
- **`agents/oauth/browser`** admin endpoints (authorize/approve/deny/browser-client CRUD) — only
  the token-exchange side effect is consumed, via `identity` above.

This matches `sdk-python`'s coverage exactly (no TS↔Python gap). If any of these should become
SDK-callable, treat it as a new feature request, not a bug in this list.

## Development

### API contract drift check (CD-0006)

`src/*.ts` hand-writes be-core's REST routes and request-body shapes (route
bases precomputed per resource class, e.g. `this.agentsBase`, then
interpolated or passed straight through to `this.client.get/post/put/patch/
del/getBytes`). Nothing else enforces that they still match be-core, so
`npm run lint:api-contract` (`scripts/audit-api-contract.mjs` — a generalized
copy of `mcp`'s CD-0001 scanner, see that file's header for why) diffs every
such call site against a be-core OpenAPI spec — failing on a route be-core no
longer has, or a request-body field its DTO doesn't declare (be-core's global
`forbidNonWhitelisted` `ValidationPipe` would 400 the whole request).

```bash
# Against this monorepo checkout's committed spec:
npm run lint:api-contract -- ../ui/swagger.json

# Or export a fresh spec straight from a be-core checkout:
#   (in be-core) npm run export:openapi
npm run lint:api-contract -- <path-to-swagger.json>
```

Wired as its own CI job (`.github/workflows/contract-drift.yml`), sibling-
checkout of `be-core`, mirroring `mcp`'s equivalent job. The **same script
instance** also audits the Python SDK's call sites (`--lang py`) via a
sibling checkout in `sdk-python`'s own `contract-drift.yml` — CD-0007 reuses
this repo's scanner rather than a third, Python-native re-derivation.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

Apache 2.0 — see [LICENSE](./LICENSE).

### Durable HTTP approval and target receipts

Use `PraesidiaProtectedHttp` for an exact-request approval checkpoint, single-use resume, caller acknowledgment and independently pinned target receipt verification. See [the lifecycle and receipt contract](docs/protected-http.md). The Python SDK includes a durable LangGraph adapter.
