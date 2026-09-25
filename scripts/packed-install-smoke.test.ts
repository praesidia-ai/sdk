import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("packed-install smoke wiring", () => {
  it("exposes the script as npm run smoke:packed", () => {
    expect(existsSync(resolve(root, "scripts/packed-install-smoke.sh"))).toBe(true);
    expect(JSON.parse(read("package.json")).scripts["smoke:packed"]).toBe(
      "bash scripts/packed-install-smoke.sh",
    );
  });

  it("installs the tarball from a temp dir outside the checkout and cleans up", () => {
    const sh = read("scripts/packed-install-smoke.sh");
    expect(sh).toContain("mktemp -d");
    expect(sh).toContain("--pack-destination");
    expect(sh).toMatch(/trap .*rm -rf/);
    expect(sh).toContain("selfcheck.mjs");
  });

  it("runs the smoke in CI on Node 22 and Node 18, after the pack dry run", () => {
    const ci = read(".github/workflows/ci.yml");
    const dryRun = ci.indexOf("npm pack --dry-run");
    const node22 = ci.indexOf("Packed-install smoke on Node 22");
    const node18 = ci.indexOf("Packed-install smoke on Node 18");
    expect(dryRun).toBeGreaterThan(-1);
    expect(node22).toBeGreaterThan(dryRun);
    expect(node18).toBeGreaterThan(node22);
    expect(ci.match(/npm run smoke:packed/g)).toHaveLength(2);
  });
});
