# Changelog

All notable changes to `@praesidia/openai-agents`. Versions follow SemVer; while on `0.x`, a
breaking change bumps the minor version (see the repository's `PUBLISHING.md`, "Semver policy").

## 0.1.0 — 2026-10-08 (first registry release)

No earlier version reached npm. Needs `@praesidia/sdk` 0.4.0 on the registry first.

### INTEG-0051: release packaging

- Supports `@openai/agents` 0.17.0 (peer). `@praesidia/sdk` ^0.4.0 is now a peer dependency as
  well as a dependency, so the host's own `@praesidia/sdk` import must be a compatible copy.
- Package metadata: `repository.directory`, `homepage`, `bugs`, `keywords`, `publishConfig`
  (`access: public`, `provenance: true`). `CHANGELOG.md` ships in the tarball.
- Published from a `openai-agents-v<version>` tag by `.github/workflows/publish-plugins.yml`.
