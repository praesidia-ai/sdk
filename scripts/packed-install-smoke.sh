#!/usr/bin/env bash
# Packed-install smoke: proves the tarball users will get installs and resolves
# in a clean project outside this checkout (files, exports map, ESM resolution).
# Packs into a fresh temp dir so a stale .tgz is never tested. Never publishes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/praesidia-sdk-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
NPM_FLAGS=(--prefer-offline --no-audit --no-fund --loglevel=error)

cd "$ROOT"
npm run build
TGZ="$WORK/$(npm pack --silent --pack-destination "$WORK" | tail -n 1)"
echo "packed: $(basename "$TGZ")"

mkdir "$WORK/app" && cd "$WORK/app"
npm init -y >/dev/null
npm pkg set type=module
npm install "${NPM_FLAGS[@]}" "$TGZ"

node -e '
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = join(process.cwd(), "node_modules/@praesidia/sdk");
const { exports } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
(async () => {
  for (const [key, target] of Object.entries(exports)) {
    for (const file of Object.values(target))
      if (!existsSync(join(dir, file))) throw new Error(`exports["${key}"] -> ${file} missing from tarball`);
    const mod = await import("@praesidia/sdk" + key.slice(1));
    console.log(`import @praesidia/sdk${key.slice(1)}: ${Object.keys(mod).length} exports`);
    if (key === ".")
      for (const sym of ["PraesidiaClient", "PraesidiaInteractionHooks", "jcsCommitment"])
        if (typeof mod[sym] !== "function") throw new Error(`${sym} is not exported`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
'

# The example declares engines node >=20.6; on older Node only the package itself is smoked.
if node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 6) ? 0 : 1)'; then
  cp -R "$ROOT/examples/refund-authorization" "$WORK/example" && cd "$WORK/example"
  npm pkg set "dependencies.@praesidia/sdk=file:$TGZ"
  npm install "${NPM_FLAGS[@]}"
  node selfcheck.mjs
else
  echo "skip examples/refund-authorization selfcheck: Node $(node -v) < 20.6 (example engines)"
fi
echo "packed-install smoke OK on Node $(node -v)"
