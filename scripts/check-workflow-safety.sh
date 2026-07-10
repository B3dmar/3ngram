#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Fail if any GitHub Actions workflow combines `pull_request_target` with a
# reference to `secrets.` — the classic fork-PR secret-exfiltration footgun.
# `pull_request_target` runs in the BASE-repo context
# with read/write tokens and secrets available, but checks out the UNTRUSTED
# fork head; mixing it with secret usage lets a malicious fork PR steal secrets.
# Untrusted contributions must use `pull_request` (no secrets) instead.
#
# Grep-based and robust: a workflow is flagged only if it references BOTH
# `pull_request_target` AND the GitHub Actions `secrets` context in ANY form:
#   - property: `secrets.MY_TOKEN`
#   - index:    `secrets['MY_TOKEN']` / `secrets["MY_TOKEN"]`
#   - bare:     `toJSON(secrets)` / `(secrets)` / `${{ secrets }}` — bare object
#               use that dumps ALL secret values.
# The `GITHUB_TOKEN`/`github.token` default is not in scope — only explicit
# `secrets` access is dangerous here. The leading boundary `(^|[^-_A-Za-z0-9])`
# excludes identifiers that merely contain the word (e.g. the
# `check-selfhost-secrets.sh` script name), and the trailing context char
# `[.[)},]` (after optional whitespace) keeps prose like "secrets preflight"
# from matching.
#
# Usage:
#   scripts/check-workflow-safety.sh            # scan .github/workflows/
#   scripts/check-workflow-safety.sh --self-test
set -euo pipefail

WORKFLOW_DIR=".github/workflows"

# ERE for the `secrets` context in property, index, and bare forms.
SECRETS_CONTEXT_RE='(^|[^-_A-Za-z0-9])secrets[[:space:]]*[.[)},]'

scan() {
  local dir="$1"
  local offenders=""
  # Only .yml/.yaml files; tolerate an empty dir.
  shopt -s nullglob
  local files=("$dir"/*.yml "$dir"/*.yaml)
  shopt -u nullglob
  local f
  for f in "${files[@]}"; do
    # Strip comment-only lines (leading-whitespace `#`) so a doc/comment mention
    # of the dangerous combination is not itself flagged. Inline trailing
    # comments on real config lines are retained (the config part still counts).
    local body
    body="$(grep -vE '^[[:space:]]*#' "$f" || true)"
    # Match property, index, AND bare `secrets` context (SECRETS_CONTEXT_RE).
    if printf '%s' "$body" | grep -qE 'pull_request_target' \
      && printf '%s' "$body" | grep -qE "$SECRETS_CONTEXT_RE"; then
      offenders+="  $f"$'\n'
    fi
  done
  printf '%s' "$offenders"
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # Negative fixture: safe workflow (pull_request, no secrets) — must pass.
  cat >"$tmp/safe.yml" <<'YAML'
on: pull_request
jobs: { x: { steps: [{ run: "echo ok" }] } }
YAML
  if [[ -n "$(scan "$tmp")" ]]; then
    echo "SELF-TEST FAIL: safe workflow flagged" >&2
    exit 1
  fi
  # Positive fixture A: pull_request_target + property-form secret — must flag.
  cat >"$tmp/danger.yml" <<'YAML'
on: pull_request_target
jobs: { x: { steps: [{ run: "echo ${{ secrets.MY_TOKEN }}" }] } }
YAML
  if [[ -z "$(scan "$tmp")" ]]; then
    echo "SELF-TEST FAIL: property-form dangerous workflow not flagged" >&2
    exit 1
  fi
  rm -f "$tmp/danger.yml"
  # Positive fixture B: pull_request_target + index-form secret — must flag.
  cat >"$tmp/danger-bracket.yml" <<'YAML'
on: pull_request_target
jobs: { x: { steps: [{ run: "echo ${{ secrets['MY_TOKEN'] }}" }] } }
YAML
  if [[ -z "$(scan "$tmp")" ]]; then
    echo "SELF-TEST FAIL: index-form (bracket) dangerous workflow not flagged" >&2
    exit 1
  fi
  rm -f "$tmp/danger-bracket.yml"
  # Positive fixture C: pull_request_target + BARE secrets object — must flag.
  cat >"$tmp/danger-bare.yml" <<'YAML'
on: pull_request_target
jobs:
  x:
    env:
      ALL: ${{ toJSON(secrets) }}
    steps: [{ run: "echo done" }]
YAML
  if [[ -z "$(scan "$tmp")" ]]; then
    echo "SELF-TEST FAIL: bare-form (toJSON(secrets)) dangerous workflow not flagged" >&2
    exit 1
  fi
  rm -f "$tmp/danger-bare.yml"
  # Negative fixture: pull_request_target + a script name containing 'secrets'
  # but NO secrets context — must NOT flag (boundary precision).
  cat >"$tmp/safe-name.yml" <<'YAML'
on: pull_request_target
jobs: { x: { steps: [{ run: "bash scripts/check-selfhost-secrets.sh" }] } }
YAML
  if [[ -n "$(scan "$tmp")" ]]; then
    echo "SELF-TEST FAIL: false positive on 'check-selfhost-secrets.sh' name" >&2
    exit 1
  fi
  echo "workflow-safety: self-test OK"
  exit 0
fi

offenders="$(scan "$WORKFLOW_DIR")"
if [[ -n "$offenders" ]]; then
  echo "ERROR: workflow combines pull_request_target with secrets. (fork-PR secret-leak vector):" >&2
  printf '%s' "$offenders" >&2
  echo "Use 'pull_request' for untrusted contributions, or remove secret access from the pull_request_target workflow." >&2
  exit 1
fi
echo "workflow-safety: OK (no pull_request_target + secrets combination)"
