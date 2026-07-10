#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Public-surface gate.
#
# Fails if any tracked top-level entry is absent from the keep-public
# allowlist below. This array is the machine-readable keep-public inventory:
# adding a tracked top-level entry without classifying it here makes this gate
# fail — that is the point. Local-only paths (e.g. .claude/) are
# intentionally NOT listed: if one reappears in the tree, the gate fails.
#
# Scans the git index (`git ls-files`), not just HEAD, so a staged-but-
# uncommitted top-level addition is caught too.
set -euo pipefail

KEEP_PUBLIC=(
  # -- directories --
  .changeset
  .github
  apps
  cmd
  docs
  eval
  packages
  scripts
  # -- dotfiles / config --
  .dockerignore
  .env.example
  .env.selfhost.example
  .gitignore
  .gitleaks.toml
  .npmrc
  # -- community / legal --
  AGENTS.md
  CLAUDE.md
  CODE_OF_CONDUCT.md
  CONTRIBUTING.md
  LICENSE
  LICENSING.md
  MAINTAINERS.md
  NOTICE
  README.md
  SECURITY.md
  SUPPORT.md
  # -- root manifests / tooling --
  biome.json
  compose.selfhost.yml
  docker-compose.yml
  no-raw-db.grit
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  renovate.json
  tsconfig.base.json
  turbo.json
)

is_keep_public() {
  local candidate=$1
  local allowed
  for allowed in "${KEEP_PUBLIC[@]}"; do
    if [[ "$candidate" == "$allowed" ]]; then
      return 0
    fi
  done
  return 1
}

unclassified=""
while IFS= read -r entry; do
  if ! is_keep_public "$entry"; then
    unclassified+="  $entry"$'\n'
  fi
done < <(git ls-files | cut -d/ -f1 | sort -u)

if [[ -n "$unclassified" ]]; then
  echo "ERROR: tracked top-level entries with no keep-public disposition:" >&2
  printf '%s' "$unclassified" >&2
  echo "Classify each as keep-public and add it to KEEP_PUBLIC in" >&2
  echo "scripts/check-public-surface.sh — or remove it from the tree." >&2
  exit 1
fi
echo "public-surface: OK (every tracked top-level entry is classified keep-public)"
