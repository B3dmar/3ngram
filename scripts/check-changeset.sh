#!/usr/bin/env bash
# Fail if a diff touches apps/* or packages/* without adding a changeset
# (CI required check). Scope covers all of packages/*: the
# @3ngram/{config,core,db,llm,schema} libs are publishable, so their changes
# need release notes too. Docs/test-only changes satisfy it with an empty
# changeset (`pnpm exec changeset add --empty`).
set -euo pipefail

base="${1:-origin/staging}"

# Two-point diff on purpose: CI's PR checkout is a shallow merge commit, so a
# merge-base (three-dot) diff is unavailable; diffing the base tip against
# HEAD yields exactly the PR's effective changes.
changed=$(git diff --name-only "$base" HEAD)

needs=$(grep -E '^(apps/|packages/)' <<<"$changed" || true)
if [[ -z "$needs" ]]; then
  echo "changeset: not required (no apps/* or packages/* changes)"
  exit 0
fi

# Added files only: a PR editing or deleting an existing changeset must not
# satisfy the guard. The changesets release PR (changeset-release/* branch)
# legitimately deletes consumed changesets while bumping apps — the workflow
# step skips it by head-branch name.
added=$(git diff --name-only --diff-filter=A "$base" HEAD)
has=$(grep -E '^\.changeset/[^/]+\.md$' <<<"$added" | grep -v 'README\.md' || true)
if [[ -z "$has" ]]; then
  echo "ERROR: this change touches apps/* or packages/* but adds no changeset:" >&2
  sed 's/^/  /' <<<"$needs" >&2
  echo "Run 'pnpm exec changeset' (or 'pnpm exec changeset add --empty' for docs/test-only)." >&2
  exit 1
fi
echo "changeset: OK"
