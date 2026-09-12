# `@praesidia/sdk` — operations

Condensed build/test/publish reference. `PUBLISHING.md` at repo root is the authoritative,
step-by-step publish runbook — read that in full before ever pushing a release tag; this file
only summarizes the day-to-day build/test loop.

## Requirements

Node `>=18` (`package.json:34`). ESM-only package (`sdk/README.md:12-14`).

## Local development

```bash
cd core/sdk
npm install
npm run build            # tsc -> dist/
npm test                 # vitest run && npm run test:plugins
npm run test:plugins      # bash scripts/test-plugins.sh — exercises plugins/
npm run test:coverage
npm run typecheck:spec    # tsc --noEmit -p tsconfig.spec.json
```

(`package.json:24-32` — script list confirmed against the current manifest.)

## Contract-drift gate

```bash
npm run lint:api-contract   # node scripts/audit-api-contract.mjs, diffs src/index.ts exports
                             # against be/openapi.json (sdk/README.md:825-853)
```

## Building an unreleased feature locally (no publish)

Since the package has never been published (`PUBLISHING.md:3`), the only way to consume a source
feature not yet in a registry release is a local pack:

```bash
npm run build
npm pack                 # produces praesidia-sdk-<version>.tgz
npm install /path/to/praesidia-sdk-<version>.tgz   # in the consuming project
```

A successful local build/pack does **not** publish anything to the registry
(`sdk/README.md:19`).

## Publishing (summary — see `PUBLISHING.md` for the actual runbook)

Publishing is a **tag push**, not a local `npm publish`; `.github/workflows/publish.yml` on
`push: tags: ['v*']` is the only place `NPM_TOKEN` is used. As of this writing the package has
never been published — `npm view @praesidia/sdk` returns `404`
(`PUBLISHING.md:3`, re-verified live 2026-09-12 in `.claude/tickets/CLOSE/TRIAGE-rest.md`'s
`MKT-0002` row). Do not treat any install instruction implying a live registry package as current
until that changes.

## Failure modes — what to check first

| Symptom | Likely cause | Where to look |
|---|---|---|
| `require('@praesidia/sdk')` throws `ERR_REQUIRE_ESM` | Consumer is CommonJS; this package is ESM-only, no CJS export condition | `sdk/README.md:12-14` |
| `npm install @praesidia/sdk` fails / 404 | Package genuinely unpublished | `PUBLISHING.md:3`; use a local `.tgz` build instead |
| A documented method is missing at runtime | Consumer has an older/lagging registry release (once one exists) vs. this checkout | `sdk/README.md:16-19` |
| `lint:api-contract` fails | `be`'s OpenAPI spec moved without a matching SDK update | `scripts/audit-api-contract.mjs`; re-export `be/openapi.json` and re-run |
| Plugin tests fail independently of the root package | Plugins are separate packages with their own manifests/tests | `.github/workflows/runtime-compatibility.yml`; each `plugins/*/README.md` |

## Verification limits

Commands and script names verified directly against `package.json` and `PUBLISHING.md` this pass
(2026-09-12); the publish-status claim is corroborated by a same-day live `npm view` check already
on record elsewhere in this run, not independently re-run from this file.
