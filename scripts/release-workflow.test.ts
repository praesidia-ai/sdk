import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    for (const p of ["plugins/openclaw", "plugins/openai-agents", "plugins/managed-mcp", "examples/refund-authorization"]) {
      const pkg = JSON.parse(read(`${p}/package.json`));
      for (const deps of [pkg.dependencies, pkg.peerDependencies])
        if (deps?.["@praesidia/sdk"]) expect(deps["@praesidia/sdk"], p).toMatch(new RegExp(`^\\^${major}\\.${minor}\\.`));
    }
  });
});

// INTEG-0052 — each plugins/<name> publishes from its own `<name>-v<version>` tag,
// gated like the root release, and only once its @praesidia/sdk range is on npm.
describe("plugin release workflow", () => {
  const read = (p: string) => readFileSync(resolve(repositoryRoot, p), "utf8");
  const workflow = read(".github/workflows/publish-plugins.yml");

  it("has a tag for every plugin, and each plugin is @praesidia/<dir>", () => {
    const dirs = readdirSync(resolve(repositoryRoot, "plugins")).filter((d) =>
      existsSync(resolve(repositoryRoot, "plugins", d, "package.json")));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      expect(workflow, dir).toContain(`- '${dir}-v*'`);
      expect(JSON.parse(read(`plugins/${dir}/package.json`)).name).toBe(`@praesidia/${dir}`);
    }
  });

  it("publishes only a tested main commit whose SDK range is already on the registry", () => {
    const publish = workflow.indexOf("run: npm publish --access public --provenance");
    expect(publish).toBeGreaterThan(-1);
    for (const step of [
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
      'npm view "@praesidia/sdk@$RANGE" version',
      "run: npm run build",
      "run: npm test",
      "run: npm pack --dry-run",
    ]) {
      const at = workflow.indexOf(step);
      expect(at, step).toBeGreaterThan(-1);
      expect(at, step).toBeLessThan(publish);
    }
    expect(workflow).toMatch(/fetch-depth:\s*0/);
    expect(workflow).toMatch(/id-token:\s*write/);
    expect(workflow).not.toContain("tags: ['v*']");
  });
});
