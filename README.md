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
PRAESIDIA_API_KEY=pk_...    # org-scoped API key (agents:invoke scope)
PRAESIDIA_ORG_ID=org-uuid   # your organization ID
PRAESIDIA_AGENT_ID=ag-uuid  # the agent running the SDK (optional)
```

## API

### `new PraesidiaGuard(config?)`

```typescript
const guard = new PraesidiaGuard({
  apiKey:  'pk_...',                    // falls back to PRAESIDIA_API_KEY
  orgId:   'org-uuid',                 // falls back to PRAESIDIA_ORG_ID
  agentId: 'agent-uuid',              // falls back to PRAESIDIA_AGENT_ID
  baseUrl: 'https://api.praesidia.ai', // falls back to PRAESIDIA_BASE_URL
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
    taskType: 'chat',   // optional label in the audit log
  },
);
```

Throws `GuardrailBlockedError` if input is blocked. `fn` is **not** called in that case.

### `guard.checkInput(input, opts?)` → `Promise<CheckResult>`

Standalone input check without running a function.

### `guard.checkOutput(output, opts?)` → `Promise<CheckResult>`

Standalone output check.

### `guard.logTask(task)` → `Promise<string | undefined>`

Manually log a task to the audit trail. Returns the Praesidia `taskId`.

### `guard.trackToolCall(call)` → `Promise<void>`

Record a tool call. Best-effort — never throws.

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

## Agent client-secret rotation

`PraesidiaAgents` rotates an agent's A2A client secret and lets a long-lived
client adopt the new secret at runtime for a **zero-downtime** swap.

```typescript
import { PraesidiaAgents } from '@praesidia/sdk';

// Zero config: reads PRAESIDIA_API_KEY, PRAESIDIA_ORG_ID, PRAESIDIA_BASE_URL
const agents = new PraesidiaAgents();

// Rotate with a 1-hour grace overlap so the OLD secret keeps working while
// consumers roll over. Omit gracePeriodSeconds (or pass 0) for an instant,
// fail-closed rotation (the old secret dies immediately — the panic button).
const rotated = await agents.rotateClientSecret(agentId, {
  gracePeriodSeconds: 3600, // 0..604800 (MAX_CLIENT_SECRET_GRACE_SECONDS), clamped server-side
});

// rotated.clientSecret is the NEW plaintext secret — shown ONCE. Store it now
// (it is never recoverable) and NEVER log it.
// rotated.graceEndsAt — ISO-8601 until which the previous secret also works (or null).

// Adopt the rotated secret in-process without a restart:
agents.refreshCredential(rotated.clientSecret);
```

`refreshCredential(secret)` is also available on `PraesidiaGuard` — a
long-lived guard can swap in a rotated credential mid-flight; the server-side
grace overlap means in-flight guarded calls are never rejected during the swap.

### `new PraesidiaAgents(config?)`

Same config shape as `PraesidiaGuard` (only `apiKey`, `orgId`, `baseUrl` are
used). Like `PraesidiaCompliance` there is no local mode — a missing
`apiKey`/`orgId` throws `PraesidiaConfigError` at construction.

| Method | Returns | Endpoint |
|---|---|---|
| `rotateClientSecret(agentId, opts?)` | `Promise<RotateClientSecretResult>` | `POST .../agents/:agentId/client-secret/rotate` |
| `refreshCredential(secret)` | `void` | in-memory credential swap (no request) |

`RotateClientSecretResult`: `{ clientId, clientSecret, graceEndsAt: string | null, gracePeriodSeconds }`.
The `clientSecret` is returned **exactly once** — the SDK never logs it and
Praesidia stores only its hash.

**JIT-first orgs (Q4-05).** Organizations on the ephemeral/JIT-first default
have static client secrets disabled — there is no static secret to rotate. In
that case `rotateClientSecret` surfaces a `PraesidiaApiError` with `status: 403`
and a clear message (the org authenticates with ephemeral JIT capability tokens
instead), rather than crashing:

```typescript
try {
  await agents.rotateClientSecret(agentId);
} catch (err) {
  if (err instanceof PraesidiaApiError && err.status === 403) {
    // JIT-first org — nothing to rotate; use the JIT capability-token flow.
  }
}
```

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
| `rotateClientSecret` | `POST /organizations/:orgId/agents/:agentId/client-secret/rotate` | `AGENTS_CONFIGURE` |
| `requestReport` | `POST /organizations/:orgId/compliance/eu-ai-act/reports` | `COMPLIANCE_MANAGE` |
| `getReportStatus` / `getReportJson` / `getReportPdf` | `GET /organizations/:orgId/compliance/eu-ai-act/reports/:id[/json\|/pdf]` | `COMPLIANCE_VIEW` |

Authentication: `Authorization: Bearer <apiKey>` (org-scoped API key).

## License

Apache 2.0 — see [LICENSE](./LICENSE).
