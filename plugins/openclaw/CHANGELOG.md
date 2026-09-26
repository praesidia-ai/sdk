# Changelog

All notable changes to `@praesidia/openclaw`. Versions follow SemVer; while on `0.x`, a breaking
change bumps the minor version (see the repository's `PUBLISHING.md`, "Semver policy").

## 0.1.1 — unreleased (first registry release)

Never published to npm; 0.1.0 existed only in source. Needs `@praesidia/sdk` 0.4.0 on the
registry first.

### INTEG-0051: release packaging

- Supports OpenClaw 2026.9.2 (plugin API and minimum gateway 2026.9.2) and `@praesidia/sdk`
  ^0.4.0, which is both a dependency and a peer dependency.
- Package metadata: `repository.directory`, `homepage`, `bugs`, `keywords`, `publishConfig`
  (`access: public`, `provenance: true`). `CHANGELOG.md` ships in the tarball.
- Published from a `openclaw-v<version>` tag by `.github/workflows/publish-plugins.yml`.
