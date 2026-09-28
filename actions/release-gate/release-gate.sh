#!/usr/bin/env bash
# Praesidia release gate (SDK-2502). Fails closed: any non-2xx, unparsable
# JSON, missing verdict or `effectiveResult: "fail"` exits non-zero.
# Inputs arrive as env vars (see action.yml); the API key is sent on stdin to
# curl (`-H @-`) so it never appears in argv / the process list.
set -euo pipefail

die() { echo "::error::release-gate: $*" >&2; exit 1; }

: "${PRAESIDIA_API_URL:?api-url is required}"
: "${PRAESIDIA_API_KEY:?api-key is required}"
: "${PRAESIDIA_ORG_ID:?org-id is required}"
: "${PRAESIDIA_AI_SYSTEM_ID:?ai-system-id is required}"
: "${PRAESIDIA_EVAL_RUN_ID:?eval-run-id is required}"
echo "::add-mask::${PRAESIDIA_API_KEY}"

base="${PRAESIDIA_API_URL%/}/organizations/${PRAESIDIA_ORG_ID}/ai-systems/${PRAESIDIA_AI_SYSTEM_ID}"
out="${GITHUB_OUTPUT:-/dev/null}"
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

# post <url> <curl data arg>; prints the HTTP status, response body in $body_file.
post() {
  printf 'Authorization: Bearer %s\n' "$PRAESIDIA_API_KEY" |
    curl -sS --max-time "${PRAESIDIA_TIMEOUT:-60}" -X POST "$1" \
      -H @- -H 'Content-Type: application/json' -H 'Accept: application/json' \
      --data-binary "$2" -o "$body_file" -w '%{http_code}' || true
}

# check <label> <status>: non-2xx or non-JSON body fails the step.
check() {
  [[ "$2" =~ ^2[0-9][0-9]$ ]] || die "$1 returned HTTP $2: $(head -c 500 "$body_file")"
  jq -e 'type == "object"' "$body_file" >/dev/null 2>&1 || die "$1 returned unparsable JSON"
}

if [[ -n "${PRAESIDIA_AIBOM_PATH:-}" ]]; then
  [[ -f "$PRAESIDIA_AIBOM_PATH" ]] || die "aibom-path not found: $PRAESIDIA_AIBOM_PATH"
  check "AIBOM import" "$(post "$base/aibom/import" "@$PRAESIDIA_AIBOM_PATH")"
  echo "AIBOM imported from $PRAESIDIA_AIBOM_PATH"
fi

payload="$(jq -cn --arg r "$PRAESIDIA_EVAL_RUN_ID" --arg c "${PRAESIDIA_COMMIT_SHA:-}" \
  '{evalRunId: $r} + (if $c == "" then {} else {commitSha: $c} end)')"
check "Quality gate" "$(post "$base/quality-gate/evaluate" "$payload")"

verdict="$(jq -r '.effectiveResult // empty' "$body_file")"
report_url="$(jq -r '.reportUrl // empty' "$body_file")"
echo "verdict=${verdict}" >>"$out"
echo "report-url=${report_url}" >>"$out"
jq -c '{id, result, effectiveResult, failingThresholds}' "$body_file" || true

case "$verdict" in
  pass) echo "Quality gate passed" ;;
  advisory_fail) echo "::warning::Quality gate: advisory (non-blocking) thresholds failed" ;;
  fail) die "quality gate failed (effectiveResult=fail)" ;;
  *) die "response carried no recognised effectiveResult ('${verdict}')" ;;
esac
