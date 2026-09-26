#!/usr/bin/env bash
# Runs each plugins/* sub-package's OWN test script, in its own directory,
# with its own dependency graph (peerDependencies installed as devDependencies
# there — see plugins/nemoclaw-openclaw/package.json). These are separately
# versioned sub-packages (own package.json, some use `node --test` instead of
# vitest) that the root `vitest.config.ts` deliberately excludes
# (`plugins/**`); this script is how their tests still get exercised by the
# sdk gate (`npm test` -> this, after `vitest run`) instead of silently never
# running. A plugin with no "test" script in its package.json is skipped.
# A plugin that depends on @praesidia/sdk is tested against THIS checkout's
# build (linked in with `npm install --no-save <root>`), never a registry copy:
# the plugin must pass against the SDK it will ship with, and before the first
# publish the registry has no @praesidia/sdk at all (E404).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"

status=0
for dir in plugins/*/; do
  pkg="${dir}package.json"
  [ -f "$pkg" ] || continue
  has_test=$(node -e "const p=require('./${pkg}'); process.stdout.write(p.scripts && p.scripts.test ? '1' : '0')")
  [ "$has_test" = "1" ] || continue
  echo "== test-plugins: ${dir} =="
  uses_sdk=$(node -e "const p=require('./${pkg}'); process.stdout.write({...p.dependencies, ...p.peerDependencies}['@praesidia/sdk'] ? '1' : '0')")
  if [ "$uses_sdk" = "1" ]; then
    [ -f dist/index.js ] || npm run build
    [ -L "${dir}node_modules/@praesidia/sdk" ] || (cd "$dir" && npm install --no-audit --no-fund --no-save "$root")
  elif [ ! -d "${dir}node_modules" ]; then
    (cd "$dir" && npm install --no-audit --no-fund)
  fi
  if ! (cd "$dir" && npm test); then
    status=1
  fi
done
exit "$status"
