# `@praesidia/sdk` — architecture

Module map with `path:line` anchors, verified against the current tree 2026-09-12.

## `src/` — one resource class per file, exported from `src/index.ts`

```
src/client.ts           # PraesidiaClient, CHAIN_ID_HEADER — the shared HTTP client every
                         # resource class wraps (src/index.ts:37)
src/guard.ts             # PraesidiaGuard — checkInput/checkOutput/run/logTask/trackToolCall/
                         # protectAction (src/index.ts:16)
src/compliance.ts        # PraesidiaCompliance — EU AI Act report export (src/index.ts:17)
src/agents.ts            # PraesidiaAgents — agent CRUD + credential refresh (src/index.ts:18)
src/memory.ts            # PraesidiaMemory (src/index.ts:19)
src/telemetry.ts         # PraesidiaTelemetry, genAiSpan — OTLP GenAI export (src/index.ts:20)
src/trust.ts             # PraesidiaTrust — offline trust-passport verification (src/index.ts:21)
src/workflows.ts         # PraesidiaWorkflows (src/index.ts:24)
src/connections.ts       # PraesidiaConnections (src/index.ts:25)
src/audit.ts             # PraesidiaAudit (src/index.ts:26)
src/proof.ts             # PraesidiaProof (src/index.ts:29)
src/proof-types.ts       # PROTECTED_ACTION_CLOSURES (src/index.ts:30)
src/analytics.ts         # PraesidiaAnalytics (src/index.ts:36)
src/protected-http.ts    # PraesidiaProtectedHttp, verifyProtectedHttpResult,
                         # PROTECTED_HTTP_RUNTIMES (src/index.ts:185)
src/runtime-tool.ts      # PraesidiaRuntimeTool (src/index.ts:187)
src/runtime-attempt-store.ts # FileRuntimeAttemptStore (src/index.ts:188)
src/http-receipt.ts      # verifyHttpReceipt, httpRequestCommitment, httpTargetKeyFingerprint,
                         # HTTP_RECEIPT_VERSION (src/index.ts:191)
src/identity.ts          # PraesidiaIdentity (src/index.ts:194)
src/crypto.ts            # signing/verification primitives used by proof/identity/http-receipt
src/jcs-canonical.ts     # JSON Canonicalization Scheme (RFC 8785) used for signed payloads
src/local-rules.ts       # local (offline) guardrail rule evaluation — no API call
src/errors.ts            # PraesidiaApiError + the structured error envelope (FINDING/SCAN2-007)
src/retry.ts             # bounded, idempotency-safe retry wrapper (README "Retry (FINDING-4)")
src/pagination.ts        # listPage/listAll pagination helpers (SCAN2-011)
src/types.ts             # shared request/response TypeScript types
```

Every `*.spec.ts` file next to its module is that module's own unit test (vitest); there is no
separate `test/` tree for `src/`.

## Plugins (`plugins/`) — separate packages, packed and published independently

- `plugins/openclaw/` — `@praesidia/openclaw`, native OpenClaw integration.
- `plugins/openai-agents/` — `@praesidia/openai-agents`, OpenAI Agents TypeScript integration.
- `plugins/nemoclaw-openclaw/` — `@praesidia/nemoclaw-openclaw`.

Each has its own `package.json`/version and is tested by
`.github/workflows/runtime-compatibility.yml`, but **none has a publish workflow** — only the root
package's `publish.yml` exists (`sdk/PUBLISHING.md`'s final section). See each plugin's own
`README.md` for its narrower tested surface.

## Contract-drift gate

`scripts/audit-api-contract.mjs` (`npm run lint:api-contract`) diffs `src/index.ts`'s exported
symbols against `be/openapi.json` (`sdk/README.md:825-853`). `mcp` runs an independent copy of the
same scanner (`CD-0011`, tracked as duplication debt, not correctness debt).

## What ships to npm (when it is published)

Controlled by `package.json`'s `files` array (a curated allow-list, not `.gitignore`-derived):
`dist/**`, `README.md`, `LICENSE`, `package.json`, and exactly the four topic docs already
present under `docs/` before this triad (`docs/federated-identity.md`,
`docs/interop-research.md`, `docs/protected-http.md`, `docs/runtime-tools.md`) plus
`examples/protected-http-target.mjs` (`sdk/PUBLISHING.md`'s "What ships" section, verified via
`npm pack --dry-run` 2026-09-11). **This new triad (`docs/README.md`, `ARCHITECTURE.md`,
`OPERATIONS.md`) is not in that list** and will not ship in the npm tarball unless a maintainer
deliberately adds it — that is a decision for `sdk-dev`, not assumed here.
