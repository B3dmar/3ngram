#!/usr/bin/env bash
# Path-aware DB access discipline:
# outside packages/db, nothing may construct a pool/drizzle handle or import a
# Postgres driver. Complements no-raw-db.grit (which catches $obj.query() calls
# but cannot do path-based scoping).
#
# --self-test: prove the pattern catches every forbidden form (run in CI so the
# gate can't silently rot as it evolves).
set -euo pipefail

PATTERN='new (pg\.)?Pool\(|new (pg\.)?Client\(|drizzle\(|from .(pg|postgres|drizzle-orm/node-postgres).|require\(.(pg|postgres|drizzle-orm/node-postgres).\)'

# Ephemeral-guard bypass (P0, 2026-06-12 prod-truncate incident): test files and
# setup must NOT silently default a missing DATABASE_URL / DATABASE_URL_UNPOOLED
# to a fallback connection string. A `process.env.DATABASE_URL || '...'` (or `??`)
# resolves to whatever the author hardcoded, sidestepping the ephemeral guard's
# host check. Tests must require the env (fail-closed) and let the guard decide.
EPHEMERAL_BYPASS_PATTERN='process\.env\.DATABASE_URL(_UNPOOLED)?[[:space:]]*(\|\||\?\?)[[:space:]]*([A-Za-z_$`]|"[^"]|'"'"'[^'"'"'])'

if [[ "${1:-}" == "--self-test" ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  declare -a forbidden=(
    'const p = new Pool({})'
    'const p = new pg.Pool({})'
    'const c = new Client({})'
    'const d = drizzle(pool)'
    "import pg from 'pg'"
    "import postgres from 'postgres'"
    "import { drizzle } from 'drizzle-orm/node-postgres'"
    "const pg = require('pg')"
    "const postgres = require('postgres')"
    "const d = require('drizzle-orm/node-postgres')"
  )
  fail=0
  for i in "${!forbidden[@]}"; do
    echo "${forbidden[$i]}" > "$tmp/f$i.ts"
    if ! grep -qE "$PATTERN" "$tmp/f$i.ts"; then
      echo "SELF-TEST FAIL — pattern missed: ${forbidden[$i]}" >&2
      fail=1
    fi
  done
  echo "import { withTenant } from '@3ngram/db'" > "$tmp/clean.ts"
  if grep -qE "$PATTERN" "$tmp/clean.ts"; then
    echo "SELF-TEST FAIL — false positive on withTenant import" >&2
    fail=1
  fi

  declare -a bypass=(
    "const url = process.env.DATABASE_URL || 'postgres://localhost/test'"
    'const url = process.env.DATABASE_URL ?? DEFAULT_URL'
    "const u = process.env.DATABASE_URL_UNPOOLED || 'postgres://localhost/test'"
    'const u = process.env.DATABASE_URL_UNPOOLED ?? OWNER_DEFAULT'
  )
  for i in "${!bypass[@]}"; do
    echo "${bypass[$i]}" > "$tmp/b$i.ts"
    if ! grep -qE "$EPHEMERAL_BYPASS_PATTERN" "$tmp/b$i.ts"; then
      echo "SELF-TEST FAIL — ephemeral-bypass pattern missed: ${bypass[$i]}" >&2
      fail=1
    fi
  done
  # Fail-closed forms must NOT trip the lint: a bare env read (helpers.ts
  # requireEnv) and an empty-string coercion (`?? ''` / `|| ""`), which yields no
  # working connection string and so cannot route a truncate at a hardcoded host.
  declare -a clean_env=(
    "const v = process.env.DATABASE_URL; if (!v) throw new Error('set it')"
    "const v = process.env.DATABASE_URL ?? ''"
    'const v = process.env.DATABASE_URL || ""'
    "const v = process.env.DATABASE_URL_UNPOOLED ?? ''"
  )
  for i in "${!clean_env[@]}"; do
    echo "${clean_env[$i]}" > "$tmp/clean-env$i.ts"
    if grep -qE "$EPHEMERAL_BYPASS_PATTERN" "$tmp/clean-env$i.ts"; then
      echo "SELF-TEST FAIL — false positive on fail-closed env read: ${clean_env[$i]}" >&2
      fail=1
    fi
  done

  [[ $fail -eq 0 ]] && echo "db-access self-test: OK (${#forbidden[@]} forbidden forms + ${#bypass[@]} ephemeral-bypass forms caught, clean forms pass)"
  exit $fail
fi

violations=$(git ls-files 'apps/**/*.ts' 'apps/**/*.tsx' 'packages/**/*.ts' 'eval/**/*.ts' \
  | grep -v '^packages/db/' \
  | xargs -r grep -lnE "$PATTERN" || true)

if [[ -n "$violations" ]]; then
  echo "ERROR: direct Postgres access outside packages/db — use withTenant() from @3ngram/db:" >&2
  echo "$violations" >&2
  exit 1
fi

# Ephemeral-guard bypass scan: applies repo-wide (test files live under
# packages/db and elsewhere). A DATABASE_URL fallback in test/setup code routes
# truncates around the guard's host allowlist — fail-closed instead.
bypass_violations=$(git ls-files 'apps/**/*.ts' 'packages/**/*.ts' 'eval/**/*.ts' \
  | xargs -r grep -lnE "$EPHEMERAL_BYPASS_PATTERN" || true)

if [[ -n "$bypass_violations" ]]; then
  echo "ERROR: DATABASE_URL fallback bypasses the ephemeral-DB guard (require the env, fail-closed):" >&2
  echo "$bypass_violations" >&2
  exit 1
fi

echo "db-access: OK"
