#!/usr/bin/env bash
# Concept docs describe SHIPPED behavior. This guard fails known stale claims
# and keeps the README tool count in lockstep with the generated MCP reference.
# Unbuilt designs in docs/concepts/ must declare `Status: design, not built.`
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

fail=0

forbid() {
  local f="$1" re="$2" why="$3"
  if [[ ! -f "$f" ]]; then
    echo "ERROR: missing $f ($why)" >&2
    fail=1
    return
  fi
  if grep -nE "$re" "$f"; then
    echo "ERROR: stale claim in $f: $why" >&2
    fail=1
  fi
}

require() {
  local f="$1" re="$2" why="$3"
  if [[ ! -f "$f" ]]; then
    echo "ERROR: missing $f ($why)" >&2
    fail=1
    return
  fi
  if ! grep -qE "$re" "$f"; then
    echo "ERROR: $f is missing required marker: $why" >&2
    fail=1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "Status: design, not built." >"$tmp/unbuilt.mdx"
  echo "Resources: still unbuilt" >"$tmp/lie.mdx"
  grep -qE 'Status: design, not built' "$tmp/unbuilt.mdx" \
    || { echo "SELF-TEST FAIL: unbuilt marker regex" >&2; exit 1; }
  grep -qE 'Resources: still unbuilt' "$tmp/lie.mdx" \
    || { echo "SELF-TEST FAIL: stale-resources regex" >&2; exit 1; }
  grep -qE 'Status: design, not built' "$tmp/lie.mdx" \
    && { echo "SELF-TEST FAIL: unbuilt marker false positive" >&2; exit 1; }
  echo "docs-truth self-test: OK"
  exit 0
fi

forbid README.md '10 MCP tools' 'README tool count is stale versus the generated MCP reference'
forbid docs/concepts/mcp-resources.mdx 'Status: design, not built' \
  'resources are shipped; this marker is for unbuilt designs only'
forbid docs/concepts/mcp-design.mdx 'Resources: still unbuilt' \
  'resources shipped in v1.3.0 (apps/server/src/mcp/resources.ts)'
forbid docs/concepts/architecture.mdx 'dependency-cruiser or Turborepo' \
  'CI does not run a dedicated dependency-direction linter'
forbid docs/concepts/architecture.mdx 'enforced by lint warning' \
  'size budget is review-only (AGENTS.md hard rule 5)'
forbid AGENTS.md 'ignore-scripts stays on' \
  'policy is strictDepBuilds; ignoreScripts is banned by check-no-lifecycle-scripts.sh'

require docs/concepts/mcp-resources.mdx 'Status: shipped' \
  'shipped concept pages must say so'
require docs/concepts/threads.mdx 'Status: design, not built' \
  'unbuilt designs must declare status so they cannot be read as shipped'

readme_n=$(grep -oE '[0-9]+ MCP tools' README.md | head -1 | grep -oE '[0-9]+' || true)
ref_n=$(grep -oE 'registers [0-9]+ tools' docs/reference/tools.mdx | head -1 | grep -oE '[0-9]+' || true)
if [[ -z "$readme_n" || -z "$ref_n" ]]; then
  echo "ERROR: could not extract tool counts (README='$readme_n' reference='$ref_n')" >&2
  fail=1
elif [[ "$readme_n" != "$ref_n" ]]; then
  echo "ERROR: README says $readme_n MCP tools; docs/reference/tools.mdx registers $ref_n" >&2
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  exit 1
fi
echo "docs-truth: OK"
