#!/usr/bin/env bash
# Supply-chain guard: verify pnpm's EFFECTIVE lifecycle-script policy at runtime, not by
# grepping a config string. Replaces the v11-false-green `grep ignore-scripts=true .npmrc`
# (docs/contributing.mdx).
#
# pnpm 11 fails closed by default (an undeclared build-script dependency errors the install),
# and the real `pnpm install --frozen-lockfile` in CI install lanes already enforces that. This
# guard covers the residual regression class that lane cannot: a config change that *permits*
# dependency build scripts to run, or policy stranded in a file pnpm 11 ignores. It reads the
# EFFECTIVE config via `pnpm config get`, so it reflects what pnpm will actually do.
set -euo pipefail

PNPM="${PNPM:-pnpm}"

# pnpm policy keys that v11 IGNORES in .npmrc — present there = false sense of security.
NPMRC_FORBIDDEN='^[[:space:]]*(ignore-scripts|strict-dep-builds|save-exact|engine-strict|only-built-dependencies|allow-builds)\b'

# Evaluate the effective pnpm build-script policy for the project in $1.
# Echoes "OK", or one "FAIL: <reason>" line per problem. Never exits.
eval_policy() {
  local dir="$1"
  local strict dangerous ignore allow reasons=()
  strict=$( (cd "$dir" && "$PNPM" config get strictDepBuilds) 2>/dev/null | head -1 | tr -d '[:space:]' )
  dangerous=$( (cd "$dir" && "$PNPM" config get dangerouslyAllowAllBuilds) 2>/dev/null | head -1 | tr -d '[:space:]' )
  ignore=$( (cd "$dir" && "$PNPM" config get ignoreScripts) 2>/dev/null | head -1 | tr -d '[:space:]' )
  allow=$( (cd "$dir" && "$PNPM" config get allowBuilds) 2>/dev/null || true )

  [[ "$strict" == "true" ]] || reasons+=("strictDepBuilds is not true (got '${strict:-unset}') — guard is not fail-closed")
  [[ "$dangerous" == "true" ]] && reasons+=("dangerouslyAllowAllBuilds is true — every dependency build would run")
  # ignoreScripts: true disables ALL scripts AND suppresses the strictDepBuilds error, so a new
  # undeclared build-script dep would be SILENTLY skipped instead of failing closed — defeating
  # the chosen tripwire posture (use allowBuilds deny-decisions, not ignoreScripts).
  [[ "$ignore" == "true" ]] && reasons+=("ignoreScripts is true — it suppresses the strictDepBuilds tripwire; new build-script deps would be silently skipped instead of failing closed")
  if grep -Eq ':[[:space:]]*true\b' <<<"$allow"; then
    reasons+=("allowBuilds permits a dependency build (value true): $(grep -E ':[[:space:]]*true' <<<"$allow" | tr -d ' ' | paste -sd, -) — each must be 'false' unless the dep genuinely needs its build (written justification required)")
  fi
  if [[ -f "$dir/.npmrc" ]] && grep -Eq "$NPMRC_FORBIDDEN" "$dir/.npmrc"; then
    reasons+=(".npmrc contains a pnpm policy key that v11 ignores — move it to pnpm-workspace.yaml")
  fi

  if [[ ${#reasons[@]} -eq 0 ]]; then echo "OK"; else printf 'FAIL: %s\n' "${reasons[@]}"; fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  # Prove the checker is not a no-op: feed it synthetic configs and assert the verdicts.
  # Isolate from any global pnpm config so the synthetic fixtures are authoritative.
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  export XDG_CONFIG_HOME="$tmp/xdg"; mkdir -p "$XDG_CONFIG_HOME"
  fail=0
  mk() { # $1=name $2=yaml -> prints dir
    local d="$tmp/$1"; mkdir -p "$d"
    echo '{"name":"st","private":true,"version":"0.0.0"}' > "$d/package.json"
    printf '%s' "$2" > "$d/pnpm-workspace.yaml"
    echo "$d"
  }
  expect() { # $1=dir $2=ok|fail $3=label
    local out; out=$(eval_policy "$1")
    if { [[ "$2" == ok ]] && [[ "$out" == OK ]]; } || { [[ "$2" == fail ]] && [[ "$out" == FAIL* ]]; }; then
      echo "  self-test OK: $3"
    else
      echo "  SELF-TEST FAILED: $3 — expected $2, got: $out" >&2; fail=1
    fi
  }
  expect "$(mk clean  $'packages: []\nstrictDepBuilds: true\nallowBuilds:\n  x: false\n')"        ok   "clean deny-map passes"
  expect "$(mk permit $'packages: []\nstrictDepBuilds: true\nallowBuilds:\n  evil: true\n')"      fail "allowBuilds:{evil:true} is flagged"
  expect "$(mk danger $'packages: []\nstrictDepBuilds: true\ndangerouslyAllowAllBuilds: true\n')" fail "dangerouslyAllowAllBuilds is flagged"
  expect "$(mk ignore $'packages: []\nstrictDepBuilds: true\nignoreScripts: true\n')"             fail "ignoreScripts:true (suppresses the tripwire) is flagged"
  expect "$(mk lax    $'packages: []\n')"                                                          fail "missing strictDepBuilds is flagged"
  npmrc=$(mk npmrc $'packages: []\nstrictDepBuilds: true\nallowBuilds:\n  x: false\n'); printf 'ignore-scripts=true\n' > "$npmrc/.npmrc"
  expect "$npmrc" fail "policy stranded in .npmrc is flagged"
  [[ $fail -eq 0 ]] && echo "check-no-lifecycle-scripts self-test: OK"
  exit $fail
fi

root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
result=$(eval_policy "$root")
if [[ "$result" == "OK" ]]; then
  echo "no-lifecycle-scripts: OK (pnpm policy is fail-closed; no dependency build is permitted)"
  exit 0
fi
echo "ERROR: pnpm lifecycle-script guard regressed (pnpm 11 supply-chain policy):" >&2
echo "$result" >&2
exit 1
