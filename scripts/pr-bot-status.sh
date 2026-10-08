#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Lists the reviewer-bot review threads (Codex, CodeQL, any bot author) that
# nobody has answered yet, for one or more PRs, in ONE GraphQL call. A thread
# counts as answered once a comment by a non-bot author follows the bot's, or
# once it is resolved.
#
# Run it after the last push, right before merging: the bots review every
# push, so a count taken earlier goes stale (AGENTS.md, Workflow).
#
#   scripts/pr-bot-status.sh 257 258      # one line per open thread
#   scripts/pr-bot-status.sh --json 257   # the open threads as JSON
#
# Exit 0: nothing open. Exit 1: threads open. Exit 2: usage, a failed API call
# (auth, network, a PR that does not exist), or a PR with more than 100 review
# threads, whose newest ones were not checked.
#
# Scope: inline review threads, which is where Codex and CodeQL put their
# findings. A bot's plain PR comment, a review body or a check annotation
# outside the diff is not seen. The repository is the current one, or
# GH_REPO=owner/name.
set -euo pipefail

json=0
if [[ "${1:-}" == "--json" ]]; then
  json=1
  shift
fi
if [[ $# -eq 0 ]]; then
  echo "usage: $0 [--json] <pr-number>..." >&2
  exit 2
fi
for pr in "$@"; do
  [[ "$pr" =~ ^[0-9]+$ ]] || { echo "not a PR number: $pr" >&2; exit 2; }
done

repo=${GH_REPO:-}
if [[ -z "$repo" ]]; then
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || { echo "gh repo view failed" >&2; exit 2; }
fi
owner=${repo%/*}
name=${repo#*/}

# One aliased field per PR, so the whole check is a single API call.
fields=""
for pr in "$@"; do
  fields+=" pr$pr: pullRequest(number: $pr) { number reviewThreads(first: 100) {"
  fields+=" pageInfo { hasNextPage } nodes { isResolved path line originalLine"
  fields+=" comments(first: 100) { nodes { url author { __typename login } body } } } } }"
done
query="query(\$owner: String!, \$name: String!) { repository(owner: \$owner, name: \$name) {$fields } }"

result=$(gh api graphql -f query="$query" -f owner="$owner" -f name="$name") || {
  echo "gh api graphql failed (auth, network, or a PR that does not exist)" >&2
  exit 2
}

# A thread is open when it is unresolved, a bot wrote its first comment, and
# no comment after that one is by a non-bot author.
open=$(jq '
  def bot: .author.__typename == "Bot" or ((.author.login // "") | test("\\[bot\\]$"));
  def title: (.body | split("\n")[0]
    | gsub("\\*\\*<sub><sub>!\\[(?<p>P[0-9]) Badge\\]\\([^)]*\\)</sub></sub>\\s*"; "[\(.p)] ")
    | gsub("\\*\\*"; ""));
  [.data.repository | to_entries[] | .value as $pr
    | ($pr.reviewThreads.pageInfo.hasNextPage) as $more
    | $pr.reviewThreads.nodes[]
    | select(.isResolved | not)
    | .comments.nodes as $c
    | select(($c | length) > 0 and ($c[0] | bot))
    | select([$c[1:][] | select(bot | not)] | length == 0)
    | {pr: $pr.number, path, line: (.line // .originalLine // "file"), title: ($c[0] | title),
       url: $c[0].url, truncated: $more}]
' <<<"$result")

truncated=$(jq -r '[.data.repository[] | select(.reviewThreads.pageInfo.hasNextPage) | .number] | join(", ")' <<<"$result")
if [[ -n "$truncated" ]]; then
  echo "more than 100 review threads on #$truncated; only the oldest 100 were checked" >&2
  exit 2
fi

if [[ $json -eq 1 ]]; then
  jq '[.[] | del(.truncated)]' <<<"$open"
else
  for pr in "$@"; do
    count=$(jq --argjson pr "$pr" '[.[] | select(.pr == $pr)] | length' <<<"$open")
    echo "#$pr: $count unanswered"
    jq -r --argjson pr "$pr" '.[] | select(.pr == $pr) | "  \(.title)\n    \(.path):\(.line)  \(.url)"' <<<"$open"
  done
fi

[[ $(jq length <<<"$open") -eq 0 ]]
