#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Release-gate guard: every apps/server version must have curated release notes.
#
# release-publish.yml's validate job refuses to publish a vX.Y.Z tag when
# .github/release-notes/X.Y.Z.md is missing. That check runs AFTER the tag
# exists, and `immutable-v-tags` forbids moving or deleting a v* tag — so a
# version PR that forgets the notes burns the version number outright. v1.2.5
# died exactly this way (run 31007491439, "missing curated release notes for
# 1.2.5"); no 1.2.5 artifact exists for any package.
#
# Running the same assertion in CI moves the failure to the changeset-release
# PR, where the fix is to add a file rather than to abandon a version. The
# invariant is repo-wide, not release-only: on any protected-branch commit the
# server version is either an already-released version (notes present) or a
# version being prepared (notes must ride in the same PR), so this needs no
# branch-name conditioning.
set -euo pipefail

# Assert that $1 (a repo root) has release notes for its apps/server version.
# Echoes "OK" or one "FAIL: <reason>" line. Never exits — the callers below do.
check_root() {
  local root=$1 manifest notes version
  manifest="$root/apps/server/package.json"

  if [[ ! -f "$manifest" ]]; then
    echo "FAIL: $manifest not found"
    return
  fi

  version=$(jq --raw-output '.version' "$manifest")
  if [[ -z "$version" || "$version" == 'null' ]]; then
    echo "FAIL: $manifest has no .version"
    return
  fi

  notes="$root/.github/release-notes/${version}.md"
  if [[ ! -f "$notes" ]]; then
    echo "FAIL: apps/server is version $version but .github/release-notes/${version}.md is missing"
    return
  fi
  if [[ ! -s "$notes" ]]; then
    echo "FAIL: .github/release-notes/${version}.md is empty"
    return
  fi

  echo "OK"
}

self_test() {
  local tmp status failures=0
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  # Fixture: version with notes -> OK.
  mkdir -p "$tmp/good/apps/server" "$tmp/good/.github/release-notes"
  echo '{"version":"9.9.9"}' >"$tmp/good/apps/server/package.json"
  echo 'notes' >"$tmp/good/.github/release-notes/9.9.9.md"
  status=$(check_root "$tmp/good")
  if [[ "$status" != 'OK' ]]; then
    echo "self-test: expected OK for a version with notes, got '$status'" >&2
    failures=$((failures + 1))
  fi

  # Fixture: version WITHOUT notes -> FAIL (the v1.2.5 regression).
  mkdir -p "$tmp/missing/apps/server" "$tmp/missing/.github/release-notes"
  echo '{"version":"9.9.9"}' >"$tmp/missing/apps/server/package.json"
  status=$(check_root "$tmp/missing")
  if [[ "$status" != FAIL:* ]]; then
    echo "self-test: expected FAIL for a version with no notes, got '$status'" >&2
    failures=$((failures + 1))
  fi

  # Fixture: notes present but empty -> FAIL (a placeholder must not pass).
  mkdir -p "$tmp/empty/apps/server" "$tmp/empty/.github/release-notes"
  echo '{"version":"9.9.9"}' >"$tmp/empty/apps/server/package.json"
  : >"$tmp/empty/.github/release-notes/9.9.9.md"
  status=$(check_root "$tmp/empty")
  if [[ "$status" != FAIL:* ]]; then
    echo "self-test: expected FAIL for empty notes, got '$status'" >&2
    failures=$((failures + 1))
  fi

  if ((failures > 0)); then
    echo "check-release-notes.sh: $failures self-test failure(s)" >&2
    exit 1
  fi
  echo "check-release-notes.sh: self-test OK"
}

if [[ "${1:-}" == '--self-test' ]]; then
  self_test
  exit 0
fi

root=$(git rev-parse --show-toplevel)
result=$(check_root "$root")
if [[ "$result" != 'OK' ]]; then
  echo "ERROR: ${result#FAIL: }" >&2
  echo "Add the curated notes before this merges — release-publish.yml rejects the tag without them," >&2
  echo "and v* tags are immutable, so a missing file costs the version number." >&2
  exit 1
fi
echo "release notes: OK"
