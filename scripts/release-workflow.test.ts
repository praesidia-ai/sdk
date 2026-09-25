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

  // SDK-0343 — the tag publishes only what the full suite and the packed-install
  // smoke (SDK-0330) accepted, in this job, before `npm publish`.
  it("runs the test suite and the packed-install smoke before npm publish", () => {
    const publish = workflow.indexOf("run: npm publish");
    expect(publish).toBeGreaterThan(-1);
    for (const step of ["npm run build", "run: npm test", "run: npm run smoke:packed"]) {
      const at = workflow.indexOf(step);
      expect(at, step).toBeGreaterThan(-1);
      expect(at, step).toBeLessThan(publish);
    }
    expect(workflow).toContain("npm publish --access public --provenance");
    expect(workflow).toMatch(/id-token:\s*write/);
  });
});

describe("release version consistency", () => {
  const read = (p: string) => readFileSync(resolve(repositoryRoot, p), "utf8");
  const { version } = JSON.parse(read("package.json"));
  const [major, minor] = version.split(".");

  it("is the first public release, 0.4.0, everywhere the version is asserted", () => {
    expect(version).toBe("0.4.0");
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
    expect(read("src/telemetry.ts")).toContain(`const SDK_SCOPE_VERSION = '${version}';`);
    expect(read(".github/workflows/runtime-compatibility.yml")).toContain(`./praesidia-sdk-${version}.tgz`);
    expect(read("scripts/verify-runtime-adapters.mjs")).toContain(`.version, '${version}');`);
  });

  it("plugins and the example accept the current SDK minor", () => {
    for (const p of ["plugins/openclaw", "plugins/openai-agents", "examples/refund-authorization"]) {
      const pkg = JSON.parse(read(`${p}/package.json`));
      for (const deps of [pkg.dependencies, pkg.peerDependencies])
        if (deps?.["@praesidia/sdk"]) expect(deps["@praesidia/sdk"], p).toMatch(new RegExp(`^\\^${major}\\.${minor}\\.`));
    }
  });
});
