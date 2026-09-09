import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/publish.yml"),
  "utf8",
);

describe("release workflow integrity", () => {
  it("publishes only a fully tested tag commit contained in main", () => {
    expect(workflow).toMatch(/fetch-depth:\s*0/);
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    );
    expect(workflow).toContain("npm run typecheck:spec");
  });
});
