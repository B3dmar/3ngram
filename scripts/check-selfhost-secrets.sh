#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Fail-closed preflight for self-host DB secrets.
#
# The self-host migrations service (compose.selfhost.yml, `init` profile) runs
# `pnpm db:migrate` + role provisioning with POSTGRES_PASSWORD (owner/superuser)
# and APP_USER_PASSWORD (runtime role) taken straight from .env.selfhost — it
# never loads packages/config (env.ts), so the schema-level guard there does not
# protect it. The compose `:?` guards only fail-closed on MISSING vars, not on an
# unchanged `.env.selfhost.example` placeholder. This preflight refuses to run
# migrations / provision roles when either secret is empty, still a known
# `change-me-*` placeholder, or obviously too short.
#
# Self-host only: docker-compose.yml (local dev) keeps its `3ngram-dev` /
# `app-user-dev` defaults and never invokes this script.
#
# Invoked two ways:
#   - compose.selfhost.yml migrations preflight: `sh ./scripts/check-selfhost-secrets.sh`
#   - CI hygiene lane self-test:                 `bash scripts/check-selfhost-secrets.sh --self-test`
#
# POSIX sh compatible (the migrations image runs it under `sh`).
set -eu

MIN_LENGTH=12

# Reason a secret value is unacceptable, or empty string when it is fine.
weak_reason() {
  value=$1
  if [ -z "$value" ]; then
    echo "is empty"
    return 0
  fi
  # Known PUBLIC credentials shipped in the repo: docker-compose.yml local-dev
  # defaults (`app-user-dev` is exactly 12 chars and would otherwise pass the
  # length check; `3ngram-dev`) and the .env.selfhost.example placeholders.
  # Public => unusable in self-host/prod. Compared lowercased; mirrors the
  # PUBLIC_DEV_PASSWORDS denylist in packages/config/src/env.ts.
  lower=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    app-user-dev | 3ngram-dev | change-me-postgres-owner | change-me-app-user)
      echo "is a known public dev/example default (never use a shipped default in production)"
      return 0
      ;;
  esac
  case "$lower" in
    change-me*)
      echo "still uses the .env.selfhost.example placeholder (change-me-*)"
      return 0
      ;;
  esac
  if [ "${#value}" -lt "$MIN_LENGTH" ]; then
    echo "is too short (minimum ${MIN_LENGTH} characters)"
    return 0
  fi
  echo ""
}

validate() {
  name=$1
  value=${2:-}
  reason=$(weak_reason "$value")
  if [ -n "$reason" ]; then
    # Never echo the value itself (it is a credential); the reason is enough.
    echo "ERROR: ${name} ${reason}. Set a strong, URL-safe password in .env.selfhost (e.g. openssl rand -hex 32)." >&2
    return 1
  fi
  return 0
}

run_preflight() {
  rc=0
  validate POSTGRES_PASSWORD "${POSTGRES_PASSWORD:-}" || rc=1
  validate APP_USER_PASSWORD "${APP_USER_PASSWORD:-}" || rc=1
  if [ "$rc" -ne 0 ]; then
    echo "self-host DB secret preflight FAILED — refusing to run migrations with weak/placeholder credentials (issue #452)." >&2
    exit 1
  fi
  echo "self-host DB secret preflight OK"
}

self_test() {
  pass=0
  fail=0
  strong="averylongrealpassword"
  check() {
    desc=$1
    want=$2 # accept | reject
    shift 2
    if env "$@" sh "$0" >/dev/null 2>&1; then
      got=accept
    else
      got=reject
    fi
    if [ "$got" = "$want" ]; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      echo "SELF-TEST FAIL: ${desc} (wanted ${want}, got ${got})" >&2
    fi
  }

  check "both strong accepted" accept "POSTGRES_PASSWORD=$strong" "APP_USER_PASSWORD=$strong"
  check "placeholder POSTGRES rejected" reject "POSTGRES_PASSWORD=change-me-postgres-owner" "APP_USER_PASSWORD=$strong"
  check "placeholder APP_USER rejected" reject "POSTGRES_PASSWORD=$strong" "APP_USER_PASSWORD=change-me-app-user"
  check "empty POSTGRES rejected" reject "POSTGRES_PASSWORD=" "APP_USER_PASSWORD=$strong"
  check "empty APP_USER rejected" reject "POSTGRES_PASSWORD=$strong" "APP_USER_PASSWORD="
  check "short POSTGRES rejected" reject "POSTGRES_PASSWORD=short" "APP_USER_PASSWORD=$strong"
  check "both placeholder rejected" reject "POSTGRES_PASSWORD=change-me-postgres-owner" "APP_USER_PASSWORD=change-me-app-user"
  # Public dev defaults must fail closed in self-host even though app-user-dev is
  # exactly 12 chars and neither is a change-me-* value.
  check "dev default app-user-dev rejected" reject "POSTGRES_PASSWORD=$strong" "APP_USER_PASSWORD=app-user-dev"
  check "dev default 3ngram-dev rejected" reject "POSTGRES_PASSWORD=3ngram-dev" "APP_USER_PASSWORD=$strong"
  check "dev defaults rejected case-insensitively" reject "POSTGRES_PASSWORD=APP-USER-DEV" "APP_USER_PASSWORD=$strong"

  echo "check-selfhost-secrets self-test: ${pass} passed, ${fail} failed"
  [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_preflight
fi
