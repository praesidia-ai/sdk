# @praesidia/sdk

Open-source agent governance SDK. Add guardrail checks, audit logging, and analytics to any AI agent in ~10 lines of code.

Apache 2.0 licensed. Free forever.

## Install

```bash
npm install @praesidia/sdk
```

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
// response.taskId  — Praesidia audit log entry ID
```

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
  requestTimeoutMs: 30_000, // falls back to PRAESIDIA_REQUEST_TIMEOUT_MS
  strict:  false, // true → throw on network errors (default: false = degrade gracefully)
  failOpen: false, // true → silently swallow network errors (default: false = warn + local fallback)
});
```

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

### `guard.trackToolCall(call)` → `Promise<void>`

Record a tool call as a `TOOL_CALL` task (`input: { tool, args, parentTaskId }`). Best-effort —
never throws, and is **skipped** (logged locally) when no `connectionId` is resolvable
(`call.connectionId` → config / `PRAESIDIA_CONNECTION_ID`).

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
| `beginTask(opts?)` | `TaskHandle` | `.complete(output, opts?)` / `.fail(error, opts?)` |

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

Client-side bounds mirror the server (fail-fast before the network): ≤100
resourceSpans, ≤2 MB body, 120 req/min. `genAiSpan(input)` is exported if you
want to build a span without sending it.

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
await memory.erase({ subjectId: 'user-42', reason: 'GDPR Art-17 request' });
await memory.delete(m.id);
```

| Method | Returns | Endpoint |
|---|---|---|
| `create(input)` | `Promise<MemoryRecord>` | `POST .../memories` |
| `list(query?)` | `Promise<{ data: MemoryRecord[]; total: number; meta: {page,limit,total,totalPages,hasNextPage,hasPrevPage} }>` | `GET .../memories` |
| `search(input)` | `Promise<MemoryRecord[]>` | `POST .../memories/search` |
| `erase(input)` | `Promise<EraseMemoryResult>` | `POST .../memories/erase` |
| `get(id)` | `Promise<MemoryRecord>` | `GET .../memories/:id` |
| `delete(id)` | `Promise<void>` | `DELETE .../memories/:id` |

## Agent CRUD (FINDING-2 parity with the Python SDK)

`PraesidiaAgents` also manages the agent's own lifecycle, not just credential
refresh:

```typescript
import { PraesidiaAgents } from '@praesidia/sdk';

const agents = new PraesidiaAgents();
const list = await agents.list({ page: 1, limit: 20 });
const agent = await agents.get(list[0].id as string);
const created = await agents.create({ name: 'Support Bot', type: 'chat' });
// created.credentialMode is 'jit' (default; clientSecret is null — the agent
// authenticates with ephemeral JIT tokens) or 'static' (legacy opt-in;
// clientSecret is the plaintext secret, shown ONCE — persist it immediately).
await agents.update(created.id as string, { name: 'Renamed Bot' });
await agents.delete(created.id as string);
```

Task submission (`run`), polling (`pollPendingTasks`), and task-scoped MCP tool
calls stay on `PraesidiaGuard` (`run` / `logTask` / `trackToolCall`) — this
mirrors the SDK's existing organization and is unchanged.

| Method | Returns | Endpoint |
|---|---|---|
| `list(query?)` | `Promise<AgentRecord[]>` | `GET .../agents` |
| `get(id)` | `Promise<AgentRecord>` | `GET .../agents/:id` |
| `create(data)` | `Promise<AgentRecord>` | `POST .../agents` |
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

const csv = await audit.export({ format: 'csv' });
```

> **No `resourceType` filter, by design.** The backend `FilterAuditDto`
> whitelists only `search`/`action`/`startDate`/`endDate` under
> `forbidNonWhitelisted` — a `resourceType` param 400s the whole request.
> `resourceType` is derived from the `action` prefix at read time, not a
> stored column. Filter by `action` instead (e.g. `action: 'agent.created'`).
>
> **`stream()` stops on an empty page, not a short one.** The backend
> hard-clamps `limit` to 100 server-side, so a caller asking for `limit: 500`
> still gets at most 100 rows per page — treating that first (full-but-clamped)
> page as the last would silently drop everything past row 100. This mirrors
> the Python SDK's `BUGHUNT-SDK-01` fix.

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

## Retry (FINDING-4) — bounded, idempotency-safe by default

Every SDK client retries **only** requests that are safe to repeat: GET,
DELETE, and any POST/PATCH the caller explicitly marks with an
`idempotencyKey`. **A bare POST (task submission, agent/workflow/connection
creation) is never retried** — retrying an already-applied create/charge is a
duplication bug, not a resilience feature.

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
`PraesidiaConnections`, `PraesidiaAudit`, `PraesidiaAnalytics`) accepts the same
`retry` config field.

> **Known gap:** only `PraesidiaClient.post`/`.patch` currently expose the
> `idempotencyKey` option directly. No resource method (e.g. `agents.create`,
> `workflows.trigger`) forwards one yet — to retry a specific write today you
> need to drop to the client-level API. Widening this to per-method
> `idempotencyKey` parameters is a natural follow-up, tracked as a known gap
> rather than silently left unstated.

## Trust passport — verify a peer agent's reputation offline (H3-02f)

`PraesidiaTrust` fetches an agent's signed trust passport from the **public**
trust routes and verifies the detached Ed25519 proof **locally** — the "verify a
peer's reputation without trusting Praesidia" client. Offline verification uses
the hand-written primitives in `crypto.ts` (`verifyEd25519`, `canonicalJson`,
`ed25519PublicKeyFromJwk`) — the same offline-verify pattern as
`@praesidia/audit-verifier`. No API key is needed.

```typescript
import { PraesidiaTrust } from '@praesidia/sdk';

const trust = new PraesidiaTrust(); // no auth — public routes

const { verified, passport, reason } = await trust.fetchAndVerify(peerAgentId);
if (verified && passport.credentialSubject.trustScore >= 70) {
  // The signed reputation is genuine and fresh — safe to trust the peer.
}

// Or verify a passport handed to you out-of-band:
const bundle = await trust.fetchVerifyBundle(peerAgentId);
const result = trust.verifyPassport(bundle.passport, bundle.publicKeyJwk);
// result.reason ∈ ok | missing-proof | malformed-public-key
//                  | signature-mismatch | invalid-expiration | expired
```

`verifyPassport` reconstructs the canonical JSON of the passport with its `proof`
member removed (RFC-8785-style), base64-decodes `proof.proofValue`, and verifies
the EdDSA signature over those exact bytes; it also checks `expirationDate`. It
never throws — a malformed passport / key yields `{ verified: false, reason }`.

## Fail-open / fail-closed

| Scenario | Default behaviour |
|---|---|
| Guardrail blocks content | Always throws `GuardrailBlockedError` (fail-closed) |
| Network error reaching Praesidia | Degrades to local rules, emits `console.warn` |
| `strict: true` + network error | Throws `PraesidiaApiError` |
| `failOpen: true` | Silently degrades (no `console.warn`) |

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

## Praesidia API endpoints used

| Operation | Endpoint | Required scope |
|---|---|---|
| `checkInput` / `checkOutput` | `POST /organizations/:orgId/guardrails/validate` | `agents:invoke` or `*` |
| `logTask` | `POST /organizations/:orgId/tasks` | `agents:invoke` or `*` |
| `requestReport` | `POST /organizations/:orgId/compliance/eu-ai-act/reports` | `COMPLIANCE_MANAGE` |
| `getReportStatus` / `getReportJson` / `getReportPdf` | `GET /organizations/:orgId/compliance/eu-ai-act/reports/:id[/json\|/pdf]` | `COMPLIANCE_VIEW` |
| `PraesidiaTelemetry.emit*` | `POST /telemetry/otlp/v1/traces` | organization API key |
| `PraesidiaMemory.*` | `POST/GET/DELETE /organizations/:orgId/memories[/…]` | `MEMORY_CREATE` / `MEMORY_VIEW` / `MEMORY_ERASE` / `MEMORY_DELETE` |
| `PraesidiaAgents.*` | `GET/POST/PATCH/DELETE /organizations/:orgId/agents[/…]` | agent management permissions |
| `PraesidiaWorkflows.*` | `GET/POST/PATCH/DELETE /organizations/:orgId/workflows[/…]` | `WORKFLOWS_*` (`APPROVAL_WORKFLOWS` feature) |
| `PraesidiaConnections.*` | `GET/POST/PATCH/DELETE /organizations/:orgId/connections[/…]` | `CONNECTIONS_*` (`A2A_COMMUNICATION` feature) |
| `PraesidiaAudit.*` | `GET /organizations/:orgId/audit-logs[/export]` | `AUDIT_VIEW` / `AUDIT_EXPORT` |
| `PraesidiaAnalytics.*` | `GET /organizations/:orgId/analytics[/…]` | `ANALYTICS_VIEW` / `ANALYTICS_EXPORT` (`advanced/*` needs `ADVANCED_ANALYTICS`) |
| `PraesidiaTrust.fetch*` | `GET /trust/passport/:agentId[/verify]` | public (no auth) |

Authentication: `Authorization: Bearer <apiKey>` (org-scoped API key). The trust
passport routes are public; `PraesidiaTrust` verifies signatures offline.

## Changelog

### Unreleased — PROD16 parity + resilience wave

- **Added** `PraesidiaWorkflows`, `PraesidiaConnections`, `PraesidiaAudit`,
  `PraesidiaAnalytics` — closes the TS↔Python SDK parity gap (FINDING-2) and
  makes the README's long-standing "analytics" claim true (FINDING-1). Purely
  additive — no existing export changed shape.
- **Added** `PraesidiaAgents.list/get/create/update/delete` (agent CRUD) —
  previously only `refreshCredential` existed. Additive.
- **Added** bounded, idempotency-safe retry (FINDING-4): GET/DELETE retry by
  default; POST/PATCH only retry when called with `{ idempotencyKey }`. New
  `retry` config field on every resource class, defaulting to an enabled
  policy (3 attempts, jittered backoff, 15s budget, honours `Retry-After`).
  **Behavioral, non-breaking** — no existing method signature changed; pass
  `retry: false` to opt out entirely.
- **Added** `PraesidiaClient.patch()` — internal transport addition backing
  the new resources' PATCH routes (`agents.update`, `workflows.update`,
  `connections.updateStatus`). Not previously exported/used.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
