# Publishing @praesidia/sdk to npm

This package has **never been published**. `npm view @praesidia/sdk` returns `E404` (checked
2026-09-26). Version 0.4.0 is the first release. This document is for the person who runs the
publish. It is self-contained, so you should not need to read the rest of the repo first.

A publish is a **tag push**, not a local `npm publish`. `.github/workflows/publish.yml` runs on
`push: tags: ['v*']`. It checks that the tag matches `package.json`, that the tagged commit is on
`origin/main`, and runs build + `typecheck:spec` + `npm test` + `npm pack --dry-run` + the
packed-install smoke + SBOM. Then it runs `npm publish --access public --provenance`. The publish
credential is only ever used there; no local machine holds it.

## Prerequisites (one-time)

1. **npm account with 2FA.** Turn on two-factor authentication for "Authorization and writes" on
   the npm account that will own the package.
2. **`@praesidia` npm org.** The account must own the `@praesidia` org or be a member with
   publish rights. A scoped first publish fails if the org does not exist.
3. **Public source repo.** `--provenance` works only from a public GitHub repository.
   `praesidia-ai/sdk` was `PUBLIC` on 2026-09-26 (`gh repo view praesidia-ai/sdk --json visibility`).
   If it is private, the publish step fails.
4. **First-release token.** npm retired classic tokens, including "Automation" tokens. Create a
   **granular access token**: *Read and write* on packages in the `@praesidia` scope (the package
   does not exist yet, so it cannot be selected by name), *bypass 2FA* enabled so CI can use it,
   and the shortest expiry you can use (for example 7 days). Save it as the `NPM_TOKEN` Actions
   secret on `praesidia-ai/sdk` (Settings → Secrets and variables → Actions).

## What ships (verified 2026-09-26, `npm pack --dry-run`)

`dist/**` (compiled `.js` + `.d.ts`, no source maps), `README.md`, `LICENSE`, `CHANGELOG.md` and
`package.json`. Nothing else: no `src/`, tests, `.env`, `docs/`, `examples/` or `plugins/`.
`package.json` `files` is an allow-list, so a new file ships only if you add it there. Before
tagging, check:

```bash
npm run build && npm pack --dry-run 2>&1 | grep -E "/Users/|\.env|\.map$|src/|\.spec\." # must print nothing
```

## Steps

```bash
# 1. Push main first. The workflow rejects a tag whose commit is not on origin/main.
#    On 2026-09-26 local main was 40 commits ahead of origin/main.
git checkout main && git pull --ff-only
git push origin main

# 2. First release only: tag the commit that already says 0.4.0. Do not run `npm version`.
git tag -a v0.4.0 -m "@praesidia/sdk 0.4.0"
git push origin v0.4.0

#    Later releases: add a CHANGELOG.md section, then bump (this creates the commit and tag):
#    npm version <patch|minor> && git push origin main --follow-tags

# 3. Watch https://github.com/praesidia-ai/sdk/actions/workflows/publish.yml
#    A red gate stops the run before `npm publish`.
```

## After the first publish

```bash
npm view @praesidia/sdk                      # shows 0.4.0, not E404
npm view @praesidia/sdk dist.attestations    # provenance attestation is present
npm pack @praesidia/sdk@0.4.0 --dry-run      # registry tarball matches the list above
```

On `https://www.npmjs.com/package/@praesidia/sdk`, check that the README renders and that the
provenance badge links to the tagged workflow run.

Then switch off the token:

1. npmjs.com → `@praesidia/sdk` → Settings → **Trusted Publisher** → GitHub Actions: organization
   `praesidia-ai`, repository `sdk`, workflow `publish.yml`. The workflow already has
   `id-token: write`. Trusted publishing needs npm CLI ≥ 11.5.1, so check `npm --version` in the
   run log (Node 24 ships npm 11).
2. Under Publishing access, select "Require two-factor authentication and disallow tokens".
3. Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com.

## If the first publish is wrong

npm never lets you publish the same version number twice, even after an unpublish.

- **Broken tarball, less than 72 h old, nothing depends on it:** `npm unpublish
  @praesidia/sdk@<version>`, then release a new version.
- **Otherwise:** `npm deprecate @praesidia/sdk@<version> "<reason>"` and publish a fixed patch or
  minor. This is the default path.
- **Metadata only (description, repository):** fix it in the next release. Metadata of a
  published version cannot be edited.

## Semver policy

SemVer, pre-1.0 (`0.x`): a breaking change is a **minor** bump, never a patch, and is called out
in `CHANGELOG.md`. Patch is for backward-compatible fixes. `1.0.0` is a deliberate decision, not
automatic. It needs the contract-drift gate green for a real release cycle and a commitment to
support the exported surface (`src/index.ts`) under full SemVer. Before any release, run
`npm run lint:api-contract` to check exported symbols against `ui/swagger.json`.

## Plugins

`plugins/<dir>` holds a separate npm package named `@praesidia/<dir>`: `openclaw`,
`openai-agents`, `nemoclaw-openclaw` and `managed-mcp`. Each has its own version and
`CHANGELOG.md`. A `v*` tag publishes only the root package.
`.github/workflows/publish-plugins.yml` publishes one plugin from a `<dir>-v<version>` tag, for
example `managed-mcp-v0.1.0`. It uses the same `NPM_TOKEN` secret and runs the same checks: tag
matches `plugins/<dir>/package.json`, commit is on `origin/main`, then build + `npm test` + `npm
pack --dry-run` in the plugin directory. It also refuses to publish while the plugin's
`@praesidia/sdk` range has no registry release, so **publish the root `v0.4.0` first**.

```bash
# after v0.4.0 is live (npm view @praesidia/sdk shows 0.4.0)
(cd plugins/managed-mcp && npm pack --dry-run)   # check the file list
git tag -a managed-mcp-v0.1.0 -m "@praesidia/managed-mcp 0.1.0"
git push origin managed-mcp-v0.1.0
```

Trusted publishing is configured per package on npmjs.com. After each plugin's first publish, add
a Trusted Publisher for it with workflow `publish-plugins.yml`.
