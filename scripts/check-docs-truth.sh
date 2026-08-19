#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Concept docs describe SHIPPED behavior. This guard fails known stale claims
# and keeps the README tool count in lockstep with the generated MCP reference.
# Unbuilt designs in docs/concepts/ must declare `Status: design, not built.`
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
fail=0

forbid() {
  local f="$1" re="$2" why="$3"
  local path="$ROOT/$f"
  if [[ ! -f "$path" ]]; then
    echo "ERROR: missing $f ($why)" >&2
    fail=1
    return
  fi
  if grep -nE "$re" "$path"; then
    echo "ERROR: stale claim in $f: $why" >&2
    fail=1
  fi
}

require() {
  local f="$1" re="$2" why="$3"
  local path="$ROOT/$f"
  if [[ ! -f "$path" ]]; then
    echo "ERROR: missing $f ($why)" >&2
    fail=1
    return
  fi
  if ! grep -qE "$re" "$path"; then
    echo "ERROR: $f is missing required marker: $why" >&2
    fail=1
  fi
}

check_tool_counts() {
  local readme="$ROOT/README.md"
  local ref="$ROOT/docs/reference/tools.mdx"
  local readme_n ref_n
  readme_n=$(grep -oE '[0-9]+ MCP tools' "$readme" | head -1 | grep -oE '[0-9]+' || true)
  ref_n=$(grep -oE 'registers [0-9]+ tools' "$ref" | head -1 | grep -oE '[0-9]+' || true)
  if [[ -z "$readme_n" || -z "$ref_n" ]]; then
    echo "ERROR: could not extract tool counts (README='$readme_n' reference='$ref_n')" >&2
    fail=1
  elif [[ "$readme_n" != "$ref_n" ]]; then
    echo "ERROR: README says $readme_n MCP tools; docs/reference/tools.mdx registers $ref_n" >&2
    fail=1
  fi
}

run_production_checks() {
  fail=0
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
  require docs/concepts/mcp-surface.mdx 'Status:.*design' \
    'mixed shipped/design pages must declare the design half'

  check_tool_counts
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/docs/concepts" "$tmp/docs/reference"
  # A tree that should PASS the production checks.
  printf '11 MCP tools\n' >"$tmp/README.md"
  printf 'The 3ngram MCP server registers 11 tools.\n' >"$tmp/docs/reference/tools.mdx"
  printf '**Status: shipped.**\n' >"$tmp/docs/concepts/mcp-resources.mdx"
  printf 'ok\n' >"$tmp/docs/concepts/mcp-design.mdx"
  printf 'ok\n' >"$tmp/docs/concepts/architecture.mdx"
  printf 'ok\n' >"$tmp/AGENTS.md"
  printf '**Status: design, not built.**\n' >"$tmp/docs/concepts/threads.mdx"
  printf '**Status: the cap is shipped; the proposals below are still design.**\n' \
    >"$tmp/docs/concepts/mcp-surface.mdx"
  ROOT="$tmp"
  run_production_checks
  [[ $fail -eq 0 ]] || { echo "SELF-TEST FAIL: clean tree should pass" >&2; exit 1; }

  # Stale resources line must fail the real forbid().
  printf '**Status: shipped.**\nResources: still unbuilt\n' >"$tmp/docs/concepts/mcp-design.mdx"
  run_production_checks
  [[ $fail -ne 0 ]] || { echo "SELF-TEST FAIL: stale resources line not caught" >&2; exit 1; }

  # Tool-count mismatch must fail check_tool_counts().
  printf '**Status: shipped.**\n' >"$tmp/docs/concepts/mcp-design.mdx"
  printf '10 MCP tools\n' >"$tmp/README.md"
  run_production_checks
  [[ $fail -ne 0 ]] || { echo "SELF-TEST FAIL: tool-count mismatch not caught" >&2; exit 1; }

  echo "docs-truth self-test: OK"
  exit 0
fi

cd "$ROOT"
run_production_checks
if [[ $fail -ne 0 ]]; then
  exit 1
fi
echo "docs-truth: OK"
