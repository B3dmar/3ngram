#!/usr/bin/env bash
# Fail if any GitHub Actions workflow uses an action by tag/branch instead of a full commit SHA.
# Supply-chain rule: docs/contributing.mdx.
set -euo pipefail

violations=$(grep -RnE 'uses:\s*[^.#]\S+@' .github/workflows/ \
  | grep -vE '@[0-9a-f]{40}( |$|\s*#)' \
  | grep -vE '^\s*#' || true)

if [[ -n "$violations" ]]; then
  echo "ERROR: actions must be pinned by full 40-char commit SHA:" >&2
  echo "$violations" >&2
  exit 1
fi
echo "action-pins: OK"
