# Changelog

All notable changes to `@praesidia/sdk`. Versions follow SemVer; while on `0.x`, a breaking
change bumps the minor version (see `PUBLISHING.md`, "Semver policy").

## Unreleased

### SDK-2503: interaction hooks send an `Idempotency-Key`, and retry (needs be ≥ BE-1759)

- `PraesidiaInteractionHooks` sends `Idempotency-Key` on every decision and outcome POST: a fresh
  UUID v4 per logical call, reused on the SDK's own retries of that call. An approval poll (new
  `approvalId` in the body) gets a new key.
- **Behaviour change:** these POSTs are now retried on network error / 429 / 5xx under the
  standard `retry` policy (new `retry` config field on `InteractionHooksConfig`; `retry: false`
  restores one attempt). A hook can therefore wait longer before its fail mode applies.
- New optional `idempotencyKey`: 4th argument of `decide(type, action, approvalId?, opts?)` and
  field of `reportOutcome(report)`. Sent verbatim; 1-255 characters, else `PraesidiaConfigError`.
- New `IdempotencyKeyReusedError` (subclass of `PraesidiaApiError`, 409
  `IDEMPOTENCY_KEY_REUSED`): same key, different body. Never retried.
- `PraesidiaClient.post` allows `idempotencyKey` on the two interaction-decision routes, and every
  `idempotencyKey` is now capped at 255 characters (be's limit).

### SDK-0361: `reportOutcome` accepts `decisionId` for plain ALLOW decisions (needs be ≥ BE-1808)

- `reportOutcome` takes exactly one of `approvalId` | `decisionId`, as a discriminated union
  (`InteractionApprovalOutcomeReport` | `InteractionDecisionOutcomeReport`). Neither or both
  throws `PraesidiaConfigError`. Existing `{ approvalId, ... }` calls compile unchanged.
- **Type change (breaking for code that reads these types directly):** `InteractionOutcomeReport` is
  now a union, so `report.approvalId` is `string | undefined`. `InteractionOutcomeReceipt.approvalId`
  is `string | null`, and the receipt has a new `reportedDecisionId: string | null`. Calls that
  pass an `approvalId` still get a receipt typed with `approvalId: string` through an overload.

### SDK-0363: trust passports accept tenant signature format 2

- **Added** `verifyPassport` / `verifyAiSystemPassport` / `fetchAndVerify*` read
  `proof.signatureFormat` (absent = 1). Format 2 verifies over
  `"praesidia:trust-passport:v2\n" || canonical JSON` (ADR-0004); format 1 passports verify
  unchanged. A signature for another purpose (e.g. `governance-badge`) does not verify.
- **Changed** A `signatureFormat` other than absent, `1` or `2` (including `null` or `"2"`) is
  `malformed-passport`. `TrustPassportProof` gains the optional `signatureFormat?: 1 | 2`
  (additive type change). Minor bump under the 0.x policy.

## 0.4.0 — 2026-09-26 (first registry release)

No earlier version reached npm (0.2.x and 0.3.x existed only in source), so 0.4.0 carries every
change below. It is the first version intended for the npm registry.

### INTEG-0050: release packaging

- The tarball ships only `dist/` (compiled `.js` + `.d.ts`), `README.md`, `LICENSE` and this
  `CHANGELOG.md`. The topic guides under `docs/` and `examples/` are no longer packed; the
  README links to them in the repository.
- No source maps ship. The maps pointed at `src/`, which was never in the tarball.
- `exports["."]` lists `types` before `import`. `publishConfig` sets `access: public` and
  `provenance: true`.

### SDK-0357: guard never degrades on a local error (security fix)

- **Fixed (security, behavior change)** `isOutage` counted every non-API error as an outage, so a
  `context` that `JSON.stringify` cannot encode (a BigInt or a circular object) made the guard
  serve local rules under `local_rules` / `fail_open`. If that context is end-user influenced, the
  user could skip the org's guardrails. `isOutage` is now an allowlist, like python `_is_outage`:
  a `fetch` rejection, a body-read failure, a malformed 2xx, 408 and 5xx. Every other error throws.
- **Changed** A POST/PATCH/PUT body that cannot be serialised throws `PraesidiaConfigError`
  (`cause` = the original `TypeError`) instead of a bare `TypeError`, for every client call.
  `PraesidiaConfigError` accepts an optional `ErrorOptions` second argument (additive).
- A `guardrails/validate` 2xx without a boolean `passed` is treated as a malformed 2xx (degrades).

### SDK-0348: guard fails closed on caller-triggerable 4xx (security fix)

- **Fixed (security, behavior change)** `PraesidiaGuard` served local rules (`passed: true`) for
  *any* control-plane error under the default `local_rules` mode and under `fail_open`. An end
  user could trigger a 400 (content over 100,000 chars) or a 429 (rate limit on the customer's
  shared egress IP) and skip the org's guardrails. The guard now degrades only on an outage
  (network error, timeout, 408, 5xx). Other 4xx, including 429, throw `PraesidiaApiError` in every
  `failureMode`, for `checkInput` / `checkOutput` / `run` and `logTask`.
- **Added** `MAX_GUARD_CONTENT_LENGTH` (100,000) and `GuardContentTooLargeError`
  (`code: 'CONTENT_TOO_LARGE'`). Longer content is rejected before any request.
- Signatures are unchanged. Code that relied on a 4xx degrading to local rules now sees a
  thrown error. Semver minor (security fix).

### SDK-0332: delegation envelope + task-scoped interaction decisions (BE-1597, BE-1609)

- **Added** optional `parentTaskId` and `delegationConstraints` on `TaskRecord` (`logTask`);
  the `DelegationConstraints` type; optional `taskId` on `InteractionHooksConfig`, and
  optional nullable `constrainedBy` on `InteractionDecision`. If you omit them, the request
  bodies are unchanged. Additive, minor bump.

### SDK-0326: Decision Receipts + audit packages (BE-1581, BE-1629)

- **Added** `PraesidiaAudit.getReceipt(rowId)`, `getDecisionReceipt(decisionId)`,
  `requestPackage(options)`, `getPackage(id)`, `downloadPackage(id)`, and
  `downloadBundle(query)` (bundle bytes + window headers); `PraesidiaClient.getBytesResponse(path)`.
- **Added** optional `includeUnrooted` on `exportBundle`. Existing signatures unchanged:
  additive, minor bump.

### SDK-0322: approval-gated lifecycle routes (AISYS-0018)

- **Added** `requestLifecycleTransition`, `listLifecycleRequests`, `approveLifecycleTransition`,
  `rejectLifecycleTransition`, `retire` and `reapprove` on `PraesidiaAiSystems`, plus their
  input/response types and `APPROVAL_GATED_LIFECYCLE_TARGETS` / `AI_SYSTEM_LIFECYCLE_REQUEST_STATUSES`.
  Until now the SDK had no way to reach `production` or `retired`.
- **Changed** `transitionLifecycle(id, 'production' | 'retired')` now throws `PraesidiaConfigError`
  (naming the method to use) before sending, instead of the `PraesidiaApiError` 400 the API has
  returned for those targets since AISYS-0018. The call could never succeed. Code that catches the
  400 by error class sees a different class now (behavior change, semver minor; the signature is unchanged).
- **Fixed** `lint:api-contract` resolves a route base built from another base, so it now checks
  every `PraesidiaAiSystems` route (110 call sites, up from 77).

### SDK-0320: `memory.erase()` returns the 202 approval request (BE-1565)

- **Changed** `PraesidiaMemory.erase()` now resolves to the 202 `ApprovalRequest` the API has
  returned since the erase became approval-gated: `{ id, status: 'PENDING', operationType:
  'DATA_SUBJECT_ERASE', description, expiresAt, ... }`. **Breaking at the type level:**
  `EraseMemoryResult` no longer has `subjectExternalIdHash`, `memoriesErased`, `dekDestroyed` or
  `certificateId`. At runtime those fields were already `undefined`, because nothing is destroyed until a
  system admin confirms the request (semver major).
- **Added** `EraseMemoryInput.expectedSubjectHash?` (optional; the server derives it when omitted,
  and a mismatch returns 400 `subject_hash_mismatch`) and `acknowledgeCrossOrg?`. A malformed hash throws
  `PraesidiaConfigError` before any request is sent.

### SDK-0317: asset create/put accept only client sources (BE-1529)

- **Changed** `createAsset`/`putAssetByExternalId` now reject `runtime_observation`,
  `discovery_connector` and `entitlement_projection` with a `PraesidiaConfigError` before
  sending the request. be 400s all three since BE-1529. `CreateAiAssetInput.source` narrows
  from `AiAssetSource` to the new `AiAssetClientSource` (`AI_ASSET_CLIENT_SOURCES`:
  `manual | api | import`). **Breaking at the type level:** code that passed one of those three
  literals no longer compiles. At runtime it already failed with a 400.
- **Fixed** `AI_ASSET_SOURCES` adds `entitlement_projection` (5 → 6), matching `ui/swagger.json`'s
  `AiAsset.source` enum, so `listAssets({ source: 'entitlement_projection' })` is no longer
  rejected client-side. The Python SDK gets the same change (SDK-0318).

### SDK-0300: interaction hooks, an advisory in-runtime guard (BE-1486)

- **Added** `PraesidiaInteractionHooks` (`beforeToolCall`, `beforeExec`, `beforeFsAccess`,
  `beforeBrowserAction`, `beforeInteraction`, `decide`), `INTERACTION_TYPES`,
  `INTERACTION_VERDICTS`, `DEFAULT_FAIL_MODES` and their types (`src/interaction-hooks.ts`), plus
  `InteractionDeniedError` / `InteractionDecisionUnavailableError` (`src/errors.ts`). Calls be's
  `POST /organizations/:orgId/interaction-decisions`; replays be's recorded fixture
  `test-fixtures/interaction-decision-v1.json`. Additive only, no breaking change (semver minor).
  The Python SDK ships the same hooks (SDK-0301).

### SDK-0314: `AI_ASSET_TYPES` adds `GUARDRAIL`

- **Fixed** `AI_ASSET_TYPES` (`types.ts`, 23 → 24: adds `GUARDRAIL`) to match `ui/swagger.json`'s
  `AiAsset.assetType` enum (be BE-0338). Before this, `listAssets`/`createAsset`/
  `putAssetByExternalId`/`traverse` rejected `'GUARDRAIL'` with a `PraesidiaConfigError` before
  sending the request. `ASSET_RELATIONSHIP_TYPES` re-checked against the same swagger: already in
  sync (13 values). No breaking changes — widened valid-value set only.

### SDK-0312: tag gateway calls with an MCP server id (GW-0776)

- **Added** `gatewayFetch(options?)`, `MCP_SERVER_ID_HEADER`, `GatewayFetchOptions`
  (`src/gateway.ts`) and `InvalidMcpServerIdError` (`src/errors.ts`). `gatewayFetch` is a
  `fetch` for OpenAI-wire SDKs pointed at the gateway. It sends `x-praesidia-mcp-server-id`
  from `mcpServerId` or from a per-call header, which wins. No breaking changes: additive only.
  Python parity is tracked as SDK-0313.

### SDK-0307: public AI System passport routes (BE-0540)

- **Added** to `PraesidiaTrust` (`src/trust.ts`): `fetchAiSystemPassport`,
  `fetchAiSystemVerifyBundle` and `fetchAiSystemBadgeSvg` (SVG as a string) for
  `GET /trust/passport/ai-systems/:aiSystemId[/verify|/badge.svg]` — public,
  sent without an `Authorization` header, like `fetchAiSystemPassportPdf`.
  New exported types (`types.ts`): `AiSystemTrustPassport`,
  `AiSystemTrustPassportCredentialSubject`, `AiSystemTrustPassportSection`,
  `AiSystemTrustPassportAibomSection`, `AiSystemTrustPassportEmbed`,
  `AiSystemTrustPassportVerifyBundle`, typed from be's
  `ai-system-trust-passport.dto.ts`. No breaking changes — additive only.
  Python parity: `client.trust.fetch_ai_system_passport` /
  `fetch_ai_system_verify_bundle` / `fetch_ai_system_badge_svg` (SDK-0310).

### SDK-0302: `by-external-id` desired-state methods (PRAE-228/229)

- **Added** to `PraesidiaAiSystems` (`src/ai-systems.ts`): `putSystemByExternalId`/
  `deleteSystemByExternalId`, `putAssetByExternalId`/`deleteAssetByExternalId`,
  `putRelationshipByExternalId`/`deleteRelationshipByExternalId` (be's BE-0579
  desired-state API) — the shape IaC tooling (Terraform provider PRAE-228,
  k8s operator PRAE-229) needs. Each returns the new `DesiredStateOutcome<T>`
  (`types.ts`) — `{ id, externalId, created, changed, updatedAt, resource }`;
  `changed` is the plan-stability signal, surfaced not swallowed. New
  `PraesidiaClient.put`/`delReturning` methods (`client.ts`) back them — `put`
  is retried like `get`/`del` (PUT is naturally idempotent, no
  `Idempotency-Key` needed) and `delReturning` is `del`'s sibling for a
  DELETE route that answers with a JSON body instead of 204. No breaking
  changes — additive only.

### SDK-0304: `ASSET_RELATIONSHIP_TYPES` adds `WRITES`

- **Fixed** `ASSET_RELATIONSHIP_TYPES` (`types.ts`, 12 → 13: adds `WRITES`) to match
  `ui/swagger.json`'s `AssetRelationship.relationshipType` enum (DB-0502, the write half of the
  PRAE-161 lineage chain). No breaking changes — widened valid-value set only.

### SDK-0007: `AI_ASSET_TYPES`/`ASSET_RELATIONSHIP_TYPES` contract sync

- **Fixed** `AI_ASSET_TYPES` (`types.ts`, 20 → 23: adds `TOOL`, `API_ENDPOINT`, `DATA_SCOPE`) and
  `ASSET_RELATIONSHIP_TYPES` (9 → 12: adds `CAN_INVOKE`, `GRANTS_SCOPE`, `CAN_ASSUME`) to match
  `ui/swagger.json`'s `AiAsset.assetType`/`AssetRelationship.relationshipType` enums (DB-0300).
  The stale tuples meant `traverse`'s existing client-side `assetTypes`/`relationshipTypes`
  validation would incorrectly reject valid new values with a `PraesidiaConfigError` before ever
  sending the request. New test in
  `ai-systems.spec.ts` reads the sibling `ui/swagger.json` and fails if the tuples drift again.
  No breaking changes — widened valid-value sets only.

### SDK-0005: `traverse` + `summary`, closing the AISYS-0003/0004 gap

- **Added** to `PraesidiaAiSystems` (`src/ai-systems.ts`): `traverse(query)`
  (`GET .../asset-relationships/graph/traverse`, be's AISYS-0003) and
  `getSummary(id)` (`GET .../ai-systems/:id/summary`, be's AISYS-0004,
  landed on the same contract batch — added together rather than filing a
  second ticket for a one-line addition). New methods + new `types.ts`
  exports (`TraverseAssetGraphQuery`, `AssetGraphTraversalResponse`,
  `AssetGraphNode`, `AssetGraphEdge`, `AssetGraphStats`,
  `AiSystemSummaryResponse`, `AiSystemSummarySection`,
  `ASSET_GRAPH_DIRECTIONS`/`AssetGraphDirection`) only — no existing
  signature touched, not a breaking change.

### SDK-0003: full CONTRACT parity for the AI System / asset graph

- **Added** to `PraesidiaAiSystems` (`src/ai-systems.ts`): systems
  `updateOwners`/`transitionLifecycle`/`delete`; assets
  `createAsset`/`getAsset`/`updateAsset`/`archiveAsset`/`restoreAsset`;
  membership `changeAssetRole`; relationships
  `getRelationship`/`updateRelationship`/`archiveRelationship`/
  `restoreRelationship` — closing every be AISYS-0002 route SDK-0001 left
  out. New methods only, no existing signature touched — not a breaking
  change. Multi-hop traversal (be's AISYS-0003) was still deferred at that
  point; SDK-0005 adds it.

### SDK-0001: AI System / asset / relationship graph resource

- **Added** `PraesidiaAiSystems` (`src/ai-systems.ts`), parity with be-core's
  AISYS-0002 module: AI System CRUD (`list`/`get`/`create`/`update`) +
  lifecycle (`archive`/`restore`), the AI Asset catalog
  (`listAssets`/`adoptAsset`), AI System ↔ Asset membership
  (`attachAsset`/`detachAsset`), and the asset relationship graph
  (`createRelationship`/`listRelationships`) — each `list*` family also gets
  `*Page`/`*All` siblings (SCAN2-011 convention). New export, no existing
  signature changed. Multi-hop traversal (be's AISYS-0003) is deferred —
  `ui/swagger.json` did not have that route at release time.

### AUD-0063: close the analytics resource coverage gap

- **Added** 11 `PraesidiaAnalytics` methods closing be-core's remaining
  `/organizations/:orgId/analytics*` routes: `captureState`,
  `agentAnalytics`, `events`, `activityLog`, `recordEvent`,
  `securityMetrics`, `usageHeatmap`, `complianceMetrics`, `anomalies`,
  `costByTeam`, `modelComparison`, plus their response/query types
  (`AnalyticsCaptureState`, `AgentAnalyticsResult`, `AnalyticsEvent`,
  `AnalyticsEventsQuery`, `RecordAnalyticsEventInput`, `AnalyticsAnomaly`,
  `CostByTeamEntry`, `ModelComparisonEntry`, `SecurityMetricsResult`,
  `UsageHeatmapResult`, `ComplianceMetricsResult`). `PraesidiaAnalytics`
  previously covered 5 of be-core's 15 analytics paths; it now covers all of
  them. Purely additive — no existing method signature changed.
- **Added** a swagger.json-derived coverage test
  (`src/analytics.coverage.spec.ts`, mirrored in the Python SDK) that fails
  on any `/organizations/:orgId/analytics*` operation this resource does not
  implement, so a future be-added route is caught here instead of silently
  missing the SDK.
- `recordEvent` is a bare, never-retried POST (not in be-core's
  `Idempotency-Key` allowlist) and requires `ANALYTICS_CREATE` — no mintable
  API-key scope exists for it, so it needs a JWT bearer. Every other new
  method is an idempotent GET, retried per the existing policy.

### PA-0026: fix `protectAction`'s deny discriminator (defect in PA01 DX-001)

- **Fixed** `guard.protectAction` misclassifying a downstream tool/transport error as a pre-dispatch
  policy denial. The shipped heuristic (`errorCode !== 'TOOL_ERROR'`) was broken: `'TOOL_ERROR'` is
  never present in this endpoint's caller-visible response, so both a real tool exception
  (`errorCode: 'BAD_REQUEST' | 'INTERNAL_ERROR'`) and a successful call whose tool errored (no
  `errorCode` at all) satisfied the old "throw" condition. Switched the discriminator to presence of
  the response's `actionDenyReason` field, which `be` sets on and only on genuine pre-dispatch
  denials.
- **Added** `ActionDenyReason` exported type (`'PERMIT_MISSING' | 'PERMIT_INVALID' |
  'PERMIT_EXPIRED' | 'PERMIT_MISMATCH' | 'PERMIT_REPLAYED' | 'POLICY_DENIED'`) and
  `ProtectedActionDeniedError.actionDenyReason`.
- No breaking change to `ProtectActionResult`'s shape; `ProtectedActionDeniedError` gained an
  additive readonly field.

### PA01 DX-001: `guard.protectAction` (blocking/throwing Proof Edge wrapper)

- **Added** `guard.protectAction(opts)` — a blocking, throwing wrapper over the managed MCP Proof
  Edge (`POST /organizations/:orgId/mcp-servers/:id/tools/:toolName/call`). Throws
  `ProtectedActionDeniedError` on a pre-dispatch denial (missing/expired/invalid/mismatched
  Permit, or a confirmed replay) and `UnsupportedProtectedActionTargetError` for any
  `target.protocol` other than `'mcp'` — never silently downgrades to `trackToolCall`-style
  best-effort telemetry.
- **Added** `jcsCanonicalize`/`jcsCommitment`/`JcsCanonicalizationError` (RFC 8785 JCS) —
  byte-compared against the shared `be`/`sdk-python`/`audit-verifier` golden fixtures.
- `guard.trackToolCall`'s docstring now explicitly states it is evidence grade **D** (observation,
  not enforcement) and points to `protectAction`. Behavior is unchanged.

## Earlier source versions (never published to npm)

### 0.2.1 — R-SDK-1: allow-list the routes `idempotencyKey` may retry

- **Fixed** `idempotencyKey` retry is now allow-listed to the routes
  be-core actually deduplicates (`POST /organizations/:orgId/tasks`,
  `POST /a2a/tasks`, `POST /a2a/tasks/:taskId/result`); every other path
  throws `PraesidiaConfigError` instead of retrying a write the server can
  double-apply. Previously any path accepted the option. **Behavioral,
  non-breaking for existing callers** — no shipped resource method passed
  `idempotencyKey` before this fix, so no caller's request shape changes;
  the client-level escape hatch is simply narrower/safer than before.

### 0.2.0 — PROD16 parity + resilience wave

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
- **Fixed (R-SDK-1):** `idempotencyKey` retry is now allow-listed to the
  routes be-core actually deduplicates (`POST /organizations/:orgId/tasks`,
  `POST /a2a/tasks`, `POST /a2a/tasks/:taskId/result`); every other path
  throws `PraesidiaConfigError` instead of retrying a write the server can
  double-apply. Previously any path accepted the option. **Behavioral,
  non-breaking for existing callers** — no shipped resource method passed
  `idempotencyKey` before this fix, so no caller's request shape changes;
  the client-level escape hatch is simply narrower/safer than before.
