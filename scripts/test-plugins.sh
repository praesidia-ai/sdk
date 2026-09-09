#!/usr/bin/env bash
# Runs each plugins/* sub-package's OWN test script, in its own directory,
# with its own dependency graph (peerDependencies installed as devDependencies
# there — see plugins/nemoclaw-openclaw/package.json). These are separately
# versioned sub-packages (own package.json, some use `node --test` instead of
# vitest) that the root `vitest.config.ts` deliberately excludes
# (`plugins/**`); this script is how their tests still get exercised by the
# sdk gate (`npm test` -> this, after `vitest run`) instead of silently never
# running. A plugin with no "test" script in its package.json is skipped.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
for dir in plugins/*/; do
  pkg="${dir}package.json"
  [ -f "$pkg" ] || continue
  has_test=$(node -e "const p=require('./${pkg}'); process.stdout.write(p.scripts && p.scripts.test ? '1' : '0')")
  [ "$has_test" = "1" ] || continue
  echo "== test-plugins: ${dir} =="
  if [ ! -d "${dir}node_modules" ]; then
    (cd "$dir" && npm install --no-audit --no-fund)
  fi
  if ! (cd "$dir" && npm test); then
    status=1
  fi
done
exit "$status"
