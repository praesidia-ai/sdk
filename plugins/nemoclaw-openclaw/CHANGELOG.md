# Changelog

All notable changes to `@praesidia/nemoclaw-openclaw`. Versions follow SemVer; while on `0.x`, a
breaking change bumps the minor version (see the repository's `PUBLISHING.md`, "Semver policy").

## 0.1.0 — unreleased (first registry release)

Never published to npm.

### INTEG-0051: release packaging

- Targets NemoClaw 0.0.120, OpenShell 0.0.106, OpenClaw 2026.7.1 and mcporter 0.7.3 (peers).
  No `@praesidia/sdk` dependency: the plugin talks only to the `@praesidia/managed-mcp` companion.
- README points at the companion's new home, `plugins/managed-mcp` in this repository.
- Package metadata: `repository.directory`, `homepage`, `bugs`, `keywords`, `publishConfig`
  (`access: public`, `provenance: true`). `CHANGELOG.md` ships in the tarball.
- Published from a `nemoclaw-openclaw-v<version>` tag by `.github/workflows/publish-plugins.yml`.
