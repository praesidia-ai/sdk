# Publishing @praesidia/sdk to npm

This package has **never been published**. `npm view @praesidia/sdk` returns `404` as of
2026-09-11. This document is for the human who runs the publish — it is intentionally
self-contained; you should not need to read the rest of the repo first.

Publishing is a **tag push**, not a local `npm publish`. `.github/workflows/publish.yml` runs on
`push: tags: ['v*']`, re-verifies the release, and is the only place `NPM_TOKEN` is used. No
local machine ever holds the publish credential.

## Prerequisites (one-time)

1. npm organization access: you must be a maintainer/owner of the `@praesidia` npm org (or have
   someone add `@praesidia/sdk` and grant you publish rights) **before** the first tag push —
   `npm publish --access public` on a scoped package fails outright if the org doesn't exist yet
   or you aren't a member.
2. `NPM_TOKEN` repository secret set on `praesidia-ai/sdk` (GitHub → repo → Settings → Secrets and
   variables → Actions). Use an **Automation** token (bypasses 2FA-per-publish prompts, since this
   runs unattended in CI) scoped to publish, not admin.
3. npm 2FA: if your npm account has 2FA on "Authorization and writes", an Automation token still
   works for CI; a **Classic**/Granular token with only publish rights is the safer minimum scope
   — do not use your personal login token.
4. Confirm you actually want the org name: `@praesidia/sdk` is a **scoped** package, so the
   command below needs `--access public` (defaults to restricted/private for scoped packages,
   which would make it unpayable on npm's free tier or invisible to `npm install`).

## What ships (verified 2026-09-11, `npm pack --dry-run`)

116 files, 156.3 kB packed / 597.7 kB unpacked: `dist/**` (compiled `.js` + `.d.ts` + source maps
for every module), `README.md`, `LICENSE`, `package.json`, and four curated docs
(`docs/federated-identity.md`, `docs/interop-research.md`, `docs/protected-http.md`,
`docs/runtime-tools.md`) plus `examples/protected-http-target.mjs`. **No tests, no `.env`, no
internal-only docs, no `node_modules`, no `plugins/` (see below).** Controlled by `package.json`'s
`files` array — this is a curated allow-list, not `.gitignore`-derived, so a new top-level doc or
example must be added there explicitly or it silently will not ship.

## Steps

```bash
# 1. From a clean main, decide the version. First release: keep the manifest's current
#    version (see README/PUBLISHING rationale — do not reset to 0.1.0, see repo's ticket
#    report for why). For any release after the first, bump per semver (see policy below)
#    with `npm version <patch|minor|major>` — this also creates the git tag.
git checkout main && git pull
npm version <patch|minor|major>   # e.g. `npm version minor` -> bumps package.json + commits + tags

# 2. Push the commit AND the tag. This is the action that is otherwise irreversible below.
git push origin main
git push origin <the new tag, e.g. v0.3.1>

# 3. Watch the Actions run: https://github.com/praesidia-ai/sdk/actions/workflows/publish.yml
#    It re-runs build + typecheck:spec + vitest + `npm pack --dry-run` + `npm publish
#    --access public --provenance` — an artifact that fails the repo's own gates never reaches
#    the registry.
```

If you are cutting the very first release and the manifest's version was never pushed as a tag
before, `npm version` will complain about an existing local tag mismatch — in that case just tag
the current commit directly instead of bumping: `git tag v0.3.1 && git push origin v0.3.1`.

## After publishing — verify it actually landed

```bash
npm view @praesidia/sdk                     # should show the new version, not 404
npm view @praesidia/sdk versions --json      # confirm exactly the versions you expect
npm pack @praesidia/sdk@<version> --dry-run  # confirms the registry tarball matches what you tested
```

Also check the npm page renders correctly: `https://www.npmjs.com/package/@praesidia/sdk`
(README, license badge, repository link — note the `repository` field points to
`github.com/praesidia-ai/sdk`, which is **currently not publicly visible on GitHub**; npm will
still show the link, it just won't resolve for outside visitors until that repo is made public).

## If the first publish is wrong

npm does **not** allow republishing the same version even after unpublish (72-hour unpublish
window, then the version number is burned forever). Do not try to "fix and republish" the same
version number.

- **Wrong/broken content, version < 24h old, this is a genuinely fresh, unused package**: `npm
  unpublish @praesidia/sdk@<version>` is allowed within 72 hours of publish and *only* if that
  version has 0 downloads-dependent packages (true for a first release). Prefer this only for an
  outright broken/empty tarball.
- **Anything a consumer might already have installed, or past 72h**: `npm deprecate
  @praesidia/sdk@<version> "<reason, e.g. 'broken build — use >=0.3.2'>"` and publish a corrected
  version. This is the default path — deprecate, don't unpublish.
- **Wrong `repository`/`homepage`/`description` only (no code change)**: these can be corrected in
  a follow-up patch release; npm also lets you `npm publish` new metadata under a *new* version
  only — package.json metadata is not independently editable on an already-published version.

## Semver policy going forward

Standard SemVer, pre-1.0 (`0.x`): breaking changes are allowed but must land as a **minor** bump
(never a patch) and be called out in the commit/tag notes — patch is reserved for genuinely
backward-compatible fixes. Promotion to `1.0.0` is a deliberate decision (not automatic once
features feel "done") gated on: the contract-drift gate having stayed green for a real release
cycle, and a decision that the exported surface (`src/index.ts`) is one you're prepared to
support under full SemVer breaking-change discipline. Every exported symbol change is reviewed
against `be/openapi.json` via `npm run lint:api-contract` before any release, published or not.

## Plugins (`plugins/openclaw`, `plugins/openai-agents`, `plugins/nemoclaw-openclaw`) — out of scope here

These are separate npm packages (`@praesidia/openclaw`, `@praesidia/openai-agents`,
`@praesidia/nemoclaw-openclaw`) with their own `package.json`/version, tested by
`.github/workflows/runtime-compatibility.yml`, but **no publish workflow exists for them** — only
the root `@praesidia/sdk` package has a tag-triggered `publish.yml`. Publishing them is a
separate, unscoped follow-up (new CI job per plugin, or a matrix); do not assume pushing a `v*`
tag on the root repo publishes these too — it does not.
