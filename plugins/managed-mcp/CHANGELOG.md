# Changelog

All notable changes to `@praesidia/managed-mcp`. Versions follow SemVer; while on `0.x`, a
breaking change bumps the minor version (see the repository's `PUBLISHING.md`, "Semver policy").

## 0.1.0 — 2026-10-08 (first registry release)

No earlier version reached npm. It needs `@praesidia/sdk` 0.4.0 on the registry first.

### INTEG-0052: moved into the sdk repository

- Source moved from the website repository, `integration-examples/managed-mcp/`. The last
  website commit touching it was `686d341` (website `HEAD` at copy time: `de61cb6`). Earlier
  history stays in that repository.
- `@praesidia/sdk` dependency `0.3.1` → `^0.4.0`. 0.3.1 was never on the registry.
- `npm test` now runs only the self-contained suites: config, managed actions, stdio. They need
  no native client. The native acceptance suites (Dify, Langflow, n8n node class, OpenCode,
  Claude Code, Praesidia MCP server) moved to `npm run test:native`. That script still fails,
  and never skips, when the native artifacts it needs are absent.
- Package metadata: `repository.directory`, `homepage`, `bugs`, `keywords`, `publishConfig`
  (`access: public`, `provenance: true`). `CHANGELOG.md` ships in the tarball.
