#!/usr/bin/env bash
# No skipped/focused tests on main (docs/concepts/testing.mdx health rule 1): .skip/.todo
# rot the suite; .only silently shrinks CI coverage. Fix or delete-with-issue.
set -euo pipefail

# (\.\w+)* catches chained modifiers: test.concurrent.skip, it.sequential.only, ...
PATTERN='\b(it|test|describe)(\.\w+)*\.(skip|todo|only)\b'

if [[ "${1:-}" == "--self-test" ]]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  fail=0
  for form in 'it.skip(' 'test.todo(' 'describe.only(' 'it.only(' 'test.concurrent.skip(' 'it.sequential.only(' 'describe.concurrent.skip(' 'test.skip.each(' 'test.only.each(' 'describe.skip.each('; do
    echo "${form}[1])('x', () => {})" > "$tmp/f.ts"
    grep -qE "$PATTERN" "$tmp/f.ts" || { echo "SELF-TEST FAIL: missed $form" >&2; fail=1; }
  done
  echo "it('x', () => {})" > "$tmp/clean.ts"
  grep -qE "$PATTERN" "$tmp/clean.ts" && { echo "SELF-TEST FAIL: false positive" >&2; fail=1; }
  [[ $fail -eq 0 ]] && echo "no-skip self-test: OK"
  exit $fail
fi

violations=$(git ls-files '*.test.ts' '*.test.tsx' '*.int.test.ts' \
  | xargs -r grep -lnE "$PATTERN" || true)

if [[ -n "$violations" ]]; then
  echo "ERROR: skipped/focused tests are not allowed on main (docs/concepts/testing.mdx rule 1):" >&2
  echo "$violations" >&2
  exit 1
fi
echo "no-skip: OK"
