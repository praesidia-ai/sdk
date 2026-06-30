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

Authentication: `Authorization: Bearer <apiKey>` (org-scoped API key).

## License

Apache 2.0 — see [LICENSE](./LICENSE).
