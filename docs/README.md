# `@praesidia/sdk` — docs

Dated 2026-09-12. Owner (per `core/.claude/POLICY.md:101`): `sdk-dev`. Written for
`DOCS-0001-sdk`.

This `docs/` directory holds four existing topic files (`federated-identity.md`,
`interop-research.md`, `protected-http.md`, `runtime-tools.md`) plus the DOCS-0001 triad added
here. The root `sdk/README.md` is the primary reference (install, API, changelog); read that
first. This triad adds a platform-fit statement, a module map with `path:line` anchors, and a
condensed build/test/publish reference.

## What it is

`@praesidia/sdk` is an **open-source** (Apache 2.0), zero-license-cost TypeScript SDK for
instrumenting an AI agent with Praesidia governance: guardrail checks, audit logging, analytics,
agent identity/trust, workflows, connections, and OTLP GenAI telemetry
(`sdk/README.md:1-5,386-422`). It is ESM-only (`sdk/README.md:12-14`) and targets Node `>=18`
(`package.json:33-35`).

## Publishing status — read this before writing install instructions anywhere

**`@praesidia/sdk` has never been published to npm.** `sdk/PUBLISHING.md:3` states `npm view
@praesidia/sdk` returned `404` as of 2026-09-11 — re-verified live during a same-day triage pass,
still `404` (`.claude/tickets/CLOSE/TRIAGE-rest.md`, `MKT-0002` row). `sdk/PUBLISHING.md` describes
the **intended** publish flow (a tag push runs `.github/workflows/publish.yml`, which builds,
tests, and `npm publish --access public --provenance`s) — that is a documented plan, not a
completed action. Do not write or imply `npm install @praesidia/sdk` works today outside this
repo's own README, which already carries the correct disclaimer (`sdk/README.md:16-19`): it
"describes the current source checkout" and a registry release may lag; for unreleased features,
build locally with `npm run build && npm pack` and install the resulting `.tgz`.

## Where it sits in the platform

- **Upstream dependency**: `be`'s REST API, via `PraesidiaClient` (`src/client.ts`). Every
  resource class (`PraesidiaGuard`, `PraesidiaAgents`, `PraesidiaCompliance`, etc.) is a typed
  wrapper over `be` endpoints (`sdk/README.md:783-803` lists them).
- **Parity partner**: `sdk-python` — several features are explicitly built "FINDING-2 parity with
  the Python SDK" (`sdk/README.md:503,535,563,589`); a change to one should be checked against the
  other.
- **Plugins**: `plugins/openclaw`, `plugins/openai-agents`, `plugins/nemoclaw-openclaw` are
  separate npm packages with their own manifests, tested by
  `.github/workflows/runtime-compatibility.yml` but with **no publish workflow of their own**
  (`sdk/PUBLISHING.md`'s final section) — publishing the root package does not publish these.
- **Contract verification**: `npm run lint:api-contract` diffs exported symbols against
  `be/openapi.json` (`sdk/README.md:825-853`); `mcp` runs an independent copy of the same scanner
  (`CD-0011`, tracked as duplication debt).

## Verification limits

Source-verified this pass: module list via `src/index.ts` exports, script names via
`package.json`, publish status via `sdk/PUBLISHING.md` plus the live `npm view` re-check already
on record in this run's triage. Not independently re-derived from a fresh `npm pack`/publish dry
run in this pass — see `ARCHITECTURE.md`/`OPERATIONS.md` for what each claim is grounded in.
Public-facing note: this package is genuinely open-source, so this triad states capabilities
(what the SDK does) rather than internal mechanism detail that would matter to a competitor
building a rival SDK — consistent with the parent ticket's instruction.

See also: `ARCHITECTURE.md`, `OPERATIONS.md`, `PUBLISHING.md` (the authoritative publish runbook,
already existing at repo root), and the four existing topic docs.
