#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Closing keywords fire only when a PR merges into the default branch (main).
# Feature PRs here merge into staging, so a "Closes #N" in their body closes
# nothing, and the issue stays open after the promotion unless the promotion
# PR names it too (#269, #411 and #427 were each closed by hand).
#
# Given a staging -> main promotion PR, this reads the PRs it carries, collects
# the issues their bodies name with a closing keyword, keeps the ones that are
# still open issues in this repository and that the promotion body does not
# close already, and prints one "Closes #N" line per issue, in number order.
#
#   scripts/promotion-closes.sh 428            # print the missing lines
#   scripts/promotion-closes.sh --apply 428    # append them to #428's body
#   scripts/promotion-closes.sh --self-test    # offline check of the parsing
#
# Carried PRs come from the promotion's commits whose headline is GitHub's
# "Merge pull request #N from ...": PRs merge with merge commits only
# (AGENTS.md, Workflow). Keywords follow GitHub's syntax: close, closes,
# closed, fix, fixes, fixed, resolve, resolves or resolved, any case, an
# optional colon, spaces or tabs, then #N, OWNER/REPO#N or an issue URL. Each
# reference needs its own keyword, so "Closes #1, #2" names #1 only, as on
# GitHub. HTML comments (the PR template's example), fenced code and code
# spans are dropped first. A reference to another repository is reported on
# stderr and left alone. The parser leans towards missing a reference: a
# missed one stays open, as it would without this script, while a wrong one
# closes an issue nobody meant to close.
#
# Exit 0: the lines were printed (or appended), possibly none. Exit 2: usage,
# a failed API call, a PR that is not staging -> main, or (--apply) a body
# that changed while the script ran.
set -euo pipefail

# The closing references in one text, as {repo, number} with repo lowercased
# and null for a bare #N. Shared by the run and the self-test.
read -r -d '' JQ_REFS <<'JQ' || true
# An unclosed comment or fence runs to the end of the body, as GitHub renders
# it. Every line indented by four spaces or a tab is dropped, not only real
# indented code blocks: that also drops indented list text, which only adds
# misses. A code span is any run of backticks up to the next run of the same
# length (``fixes #1`` included), and <code> and <pre> elements are code too.
# Each strip leaves a word character, never a space, so it cannot join a
# keyword to a reference that code separated (fixes `a` #5).
def prose:
  gsub("<!--[\\s\\S]*?-->"; "x") | gsub("<!--[\\s\\S]*$"; "x")
  | gsub("```[\\s\\S]*?```"; "x") | gsub("```[\\s\\S]*$"; "x")
  | gsub("~~~[\\s\\S]*?~~~"; "x") | gsub("~~~[\\s\\S]*$"; "x")
  | gsub("(?:^|\\n)(?: {4}|\\t)[^\\n]*"; "\n")
  | gsub("(?i)<(?<el>code|pre)\\b[^>]*>[\\s\\S]*?</\\k<el>\\s*>"; "x")
  | gsub("(?<tick>`+)[\\s\\S]*?\\k<tick>"; "x");
def closing_refs:
  [ prose | match("(?i)(?:^|[^\\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \\t]+(?:https://github\\.com/(?<url>[\\w.-]+/[\\w.-]+)/issues/|(?<repo>[\\w.-]+/[\\w.-]+)#|#)(?<n>[0-9]+)(?![\\w#/-])"; "g")
    | (.captures | map({key: .name, value: .string}) | from_entries) as $c
    | {repo: (($c.url // $c.repo) | if . == null then null else ascii_downcase end),
       number: ($c.n | tonumber)} ];
JQ

# Partition references against $repo (OWNER/NAME): same-repo numbers, the
# other repositories' references as "OWNER/NAME#N" strings, and same-repo
# numbers no issue can have: 0, or too large for GraphQL's Int (either could
# fail the whole states call).
read -r -d '' JQ_SPLIT <<'JQ' || true
def split_refs($repo):
  ($repo | ascii_downcase) as $r
  | [ .[] | select(.repo == null or .repo == $r) | .number ] as $mine
  | { local: [ $mine[] | select(. >= 1 and . <= 2147483647) ] | unique,
      foreign: [ .[] | select(.repo != null and .repo != $r) | "\(.repo)#\(.number)" ] | unique,
      invalid: [ $mine[] | select(. < 1 or . > 2147483647) | "#\(.)" ] | unique };
JQ

# Carried PR numbers from commit headlines.
read -r -d '' JQ_CARRIED <<'JQ' || true
def carried:
  [ .[] | capture("^Merge pull request #(?<n>[0-9]+) from ") | .n | tonumber ] | unique;
JQ

# The states response as {"N": {type, state}}. A number that resolves to
# nothing is null under its alias, with a NOT_FOUND error naming the alias;
# any other error means the answer cannot be trusted, and the call fails.
read -r -d '' JQ_STATES <<'JQ' || true
def states:
  if (.data.repository | type) != "object" or ([.errors[]? | select(.type != "NOT_FOUND")] | length) > 0
  then error("issue states unreadable")
  else .data.repository | with_entries(select(.value != null)
         | {key: (.key | ltrimstr("i")), value: {type: .value.__typename, state: .value.state}})
  end;
def not_found: [.errors[]? | .path[-1] | ltrimstr("i") | "#\(.)"];
JQ

# The lines to add, from candidate numbers, their states ({"N": {type, state}})
# and the numbers the promotion body already closes.
read -r -d '' JQ_MISSING <<'JQ' || true
def missing($states; $already):
  [ .[] | select(IN($already[]) | not)
        | select($states[tostring].type == "Issue" and $states[tostring].state == "OPEN") ]
  | map("Closes #\(.)");
JQ

self_test() {
  local fail=0 got want
  check() { # name, got, want
    if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got $2, want $3" >&2; fail=1; fi
  }
  got=$(jq -cn --arg t 'Closes #427' "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'bare keyword' "$got" '[427]'
  got=$(jq -cn --arg t 'FIXES: #12 and resolved #13.' "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'case, colon, past tense' "$got" '[12,13]'
  got=$(jq -cn --arg t 'Closes #1, #2' "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'one keyword per reference' "$got" '[1]'
  got=$(jq -cn --arg t 'encloses #5, prefix-fixes #6, Closes#7, closes #8a, closes #9/x' "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'word boundaries and spacing' "$got" '[]'
  got=$(jq -cn --arg t '(closes #10), "fixes #11".' "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'punctuation around the reference' "$got" '[10,11]'
  got=$(jq -cn --arg t "$(printf '<!-- e.g. Closes #123 -->\n`fix #20`\n```\nCloses #21\n```\n~~~\nfixes #22\n~~~\nFixed\n#23\nCloses #24')" \
    "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'comments, code and line breaks' "$got" '[24]'
  got=$(jq -cn --arg t "$(printf 'Closes #30\n\n    Closes #31\n\tfixes #32\nCloses #33\n```\nCloses #34')" \
    "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'indented code and an unclosed fence' "$got" '[30,33]'
  got=$(jq -cn --arg t "$(printf 'Closes #40\n<!-- unclosed\nCloses #41')" "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'an unclosed comment' "$got" '[40]'
  got=$(jq -cn --arg t "$(printf '``fixes #50``, ``a `fix #51` b``, <code>closes #52</code>, <CODE class=x>fix #53</CODE>\n<pre>\nfixes #54\n</pre>\nCloses #55')" \
    "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'longer code spans and HTML code' "$got" '[55]'
  got=$(jq -cn --arg t 'fixes `a` #60, closes`x`#61, <code>x</code>fixes #62, text <!-- n --> Closes #63' \
    "$JQ_REFS"' $t | closing_refs | map(.number)')
  check 'a strip never joins a keyword to a reference' "$got" '[63]'
  got=$(jq -cn --arg t 'Resolves B3dmar/3ngram#14, closes https://github.com/b3dmar/3ngram/issues/15, closes B3dmar/3ngram-platform#718, closes #99999999999, closes #0' \
    "$JQ_REFS $JQ_SPLIT"' $t | closing_refs | split_refs("B3dmar/3ngram")')
  check 'same repository, others, impossible numbers' "$got" '{"local":[14,15],"foreign":["b3dmar/3ngram-platform#718"],"invalid":["#0","#99999999999"]}'
  got=$(jq -cn "$JQ_CARRIED"' ["Merge pull request #429 from B3dmar/fix/x", "fix(db): bind user_id", "Merge branch '"'"'main'"'"' into staging", "Merge pull request #433 from B3dmar/docs/y", "Merge pull request #429 from B3dmar/fix/x"] | carried')
  check 'carried PRs from merge headlines' "$got" '[429,433]'
  got=$(jq -cn "$JQ_MISSING"' [3,400,427,428,430] | missing({"3":{"type":"Issue","state":"CLOSED"},"400":{"type":"Issue","state":"OPEN"},"427":{"type":"Issue","state":"OPEN"},"428":{"type":"PullRequest","state":"MERGED"}}; [400])')
  check 'open issues not already closed' "$got" '["Closes #427"]'
  local partial='{"data":{"repository":{"i999999":null,"i427":{"__typename":"Issue","state":"OPEN"}}},"errors":[{"type":"NOT_FOUND","path":["repository","i999999"]}]}'
  got=$(jq -c "$JQ_STATES"' [states, not_found]' <<<"$partial")
  check 'a missing number is skipped' "$got" '[{"427":{"type":"Issue","state":"OPEN"}},["#999999"]]'
  if jq "$JQ_STATES"' states' <<<'{"data":{"repository":null},"errors":[{"type":"RATE_LIMITED"}]}' >/dev/null 2>&1; then
    echo "FAIL any other error must fail the run" >&2; fail=1
  else
    echo "ok   any other error fails the run"
  fi
  [[ $fail -eq 0 ]] || exit 1
  echo "self-test passed"
}

apply=0
case "${1:-}" in
  --self-test) self_test; exit 0 ;;
  --apply) apply=1; shift ;;
esac
if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 [--apply] <promotion-pr> | --self-test" >&2
  exit 2
fi
promo=$1

repo=${GH_REPO:-}
if [[ -z "$repo" ]]; then
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || { echo "gh repo view failed" >&2; exit 2; }
fi
# GH_REPO may carry a leading host (HOST/OWNER/REPO); keep it for gh api.
host=""
[[ "$repo" == */*/* ]] && { host=${repo%%/*}; repo=${repo#*/}; }
owner=${repo%/*}
name=${repo#*/}

graphql() {
  if [[ -n "$host" ]]; then gh api --hostname "$host" graphql "$@"; else gh api graphql "$@"; fi
}

meta=$(graphql -F n="$promo" -f owner="$owner" -f name="$name" -f query='
  query($owner: String!, $name: String!, $n: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $n) { baseRefName headRefName body } } }') ||
  { echo "could not read PR #$promo" >&2; exit 2; }
base=$(jq -r '.data.repository.pullRequest.baseRefName' <<<"$meta")
head=$(jq -r '.data.repository.pullRequest.headRefName' <<<"$meta")
if [[ "$base" != main || "$head" != staging ]]; then
  echo "#$promo is $head -> $base, not a staging -> main promotion" >&2
  exit 2
fi
promo_body=$(jq -r '.data.repository.pullRequest.body // ""' <<<"$meta")

# Every commit headline in the promotion, all pages.
headlines=$(graphql --paginate -F n="$promo" -f owner="$owner" -f name="$name" -f query='
  query($owner: String!, $name: String!, $n: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) { pullRequest(number: $n) {
      commits(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor } nodes { commit { messageHeadline } } } } } }' \
  --jq '.data.repository.pullRequest.commits.nodes[].commit.messageHeadline') ||
  { echo "could not read the commits of #$promo" >&2; exit 2; }
carried=$(jq -Rn "$JQ_CARRIED"' [inputs] | carried | .[]' <<<"$headlines")
if [[ -z "$carried" ]]; then
  echo "#$promo carries no merged PRs" >&2
  exit 0
fi

# One aliased field per carried PR: a single call for every body.
fields=""
for pr in $carried; do fields+=" p$pr: pullRequest(number: $pr) { body }"; done
bodies=$(graphql -f owner="$owner" -f name="$name" -f query="
  query(\$owner: String!, \$name: String!) { repository(owner: \$owner, name: \$name) { $fields } }") ||
  { echo "could not read the carried PRs' bodies" >&2; exit 2; }
refs=$(jq -c --arg repo "$owner/$name" "$JQ_REFS $JQ_SPLIT"'
  [.data.repository[] | .body // "" | closing_refs[]] | split_refs($repo)' <<<"$bodies")
jq -r '(.foreign[] | "skipped, another repository: \(.)"), (.invalid[] | "skipped, not an issue number: \(.)")' <<<"$refs" >&2
candidates=$(jq -r '.local[]' <<<"$refs")
if [[ -z "$candidates" ]]; then
  echo "no carried PR names an issue in $owner/$name" >&2
  exit 0
fi

fields=""
for n in $candidates; do
  fields+=" i$n: issueOrPullRequest(number: $n) { __typename ... on Issue { state } ... on PullRequest { state } }"
done
# gh exits 1 when any alias is NOT_FOUND (a typo in an old body) but still
# prints the response; the states filter decides whether it is usable. An
# empty response (network, auth) yields no states and fails the same way.
errfile=$(mktemp)
trap 'rm -f "$errfile"' EXIT
response=$(graphql -f owner="$owner" -f name="$name" -f query="
  query(\$owner: String!, \$name: String!) { repository(owner: \$owner, name: \$name) { $fields } }" 2>"$errfile") || true
states=$(jq -c "$JQ_STATES"' states' <<<"$response" 2>/dev/null) || states=""
if [[ -z "$states" ]]; then
  cat "$errfile" >&2
  echo "could not read the named issues" >&2
  exit 2
fi
jq -r "$JQ_STATES"' not_found[] | "skipped, no such issue or PR: \(.)"' <<<"$response" >&2
jq -r --argjson states "$states" '"named by carried PRs: " + ([.local[] | tostring as $n
  | "#\($n) (\(($states[$n].type // "missing") | ascii_downcase) \(($states[$n].state // "") | ascii_downcase))"] | join(" "))' \
  <<<"$refs" >&2
already=$(jq -cn --arg t "$promo_body" --arg repo "$owner/$name" "$JQ_REFS $JQ_SPLIT"' $t | closing_refs | split_refs($repo) | .local')
lines=$(jq -r --argjson states "$states" --argjson already "$already" "$JQ_MISSING"'
  .local | missing($states; $already)[]' <<<"$refs")

if [[ -z "$lines" ]]; then
  echo "nothing to add: each one is closed, not an issue, or already closed by #$promo's body" >&2
  exit 0
fi
echo "$lines"
if [[ $apply -eq 1 ]]; then
  # The body is written back whole, so an edit made since it was read would be
  # lost: re-read it first and stop if it changed.
  current=$(graphql -F n="$promo" -f owner="$owner" -f name="$name" -f query='
    query($owner: String!, $name: String!, $n: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $n) { body } } }' \
    --jq '.data.repository.pullRequest.body // ""') ||
    { echo "could not re-read the body of #$promo" >&2; exit 2; }
  if [[ "$current" != "$promo_body" ]]; then
    echo "the body of #$promo changed while this ran; nothing written, run it again" >&2
    exit 2
  fi
  printf '%s\n\n%s\n' "$promo_body" "$lines" | gh pr edit "$promo" --body-file - >/dev/null ||
    { echo "could not update the body of #$promo" >&2; exit 2; }
  echo "appended to #$promo" >&2
fi
