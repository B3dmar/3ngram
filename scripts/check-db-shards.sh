#!/usr/bin/env bash
# Every packages/db/test/integration/*.int.test.ts must be assigned to a DB
# shard in .github/workflows/ci.yml. Unassigned files are silently skipped by
# the matrix runner, so a new test that isn't listed never runs in CI.
set -euo pipefail

CI_YAML=".github/workflows/ci.yml"

if [[ "${1:-}" == "--self-test" ]]; then
  for shard in db-auth db-memory db-search db-structure; do
    grep -q "shard: $shard" "$CI_YAML" || { echo "SELF-TEST FAIL: shard '$shard' missing from $CI_YAML" >&2; exit 1; }
  done
  echo "check-db-shards self-test: OK"
  exit 0
fi

discovered=$(git ls-files 'packages/db/test/integration/*.int.test.ts' | xargs -I{} basename {} | sort)

if [[ -z "$discovered" ]]; then
  echo "ERROR: no integration test files found under packages/db/test/integration/" >&2
  exit 1
fi

assigned=$(grep -oE '[a-zA-Z0-9._-]+\.int\.test\.ts' "$CI_YAML" | sort -u)

unassigned=$(comm -23 <(echo "$discovered") <(echo "$assigned"))

if [[ -n "$unassigned" ]]; then
  echo "ERROR: DB integration tests not assigned to any shard in $CI_YAML:" >&2
  echo "$unassigned" | sed 's/^/  /' >&2
  echo "" >&2
  echo "Add each file to a shard's test_files list in the integration matrix." >&2
  exit 1
fi

count=$(echo "$discovered" | wc -l | tr -d ' ')
echo "check-db-shards: OK ($count files assigned across shards)"
