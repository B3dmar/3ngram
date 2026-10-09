#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Lists the reviewer-bot review threads (Codex, CodeQL, any bot author) that
# nobody has answered yet, for one or more PRs, in ONE GraphQL call. A thread
# counts as answered once a comment by a non-bot author follows the bot's
# newest comment, or once it is resolved.
#
# Run it after the last push, right before merging: the bots review every
# push, so a count taken earlier goes stale (AGENTS.md, Workflow).
#
#   scripts/pr-bot-status.sh 257 258      # one line per open thread
#   scripts/pr-bot-status.sh --json 257   # the open threads as JSON
#
# Exit 0: nothing open. Exit 1: threads open. Exit 2: usage, a failed API call
# (auth, network, a PR that does not exist), a PR with more than 100 review
# threads, or a thread with more than 100 comments, whose newest were not checked.
#
# Scope: inline review threads, which is where Codex and CodeQL put their
# findings. A bot's plain PR comment, a review body or a check annotation
# outside the diff is not seen. The repository is the current one, or
# GH_REPO=[HOST/]OWNER/REPO.
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
# GH_REPO may carry a leading host (HOST/OWNER/REPO); keep it for gh api.
host=""
[[ "$repo" == */*/* ]] && { host=${repo%%/*}; repo=${repo#*/}; }
owner=${repo%/*}
name=${repo#*/}

# One aliased field per PR, so the whole check is a single API call.
fields=""
for pr in "$@"; do
  fields+=" pr$pr: pullRequest(number: $pr) { number reviewThreads(first: 100) {"
  fields+=" pageInfo { hasNextPage } nodes { isResolved path line originalLine"
  fields+=" comments(first: 100) { pageInfo { hasNextPage } nodes { url author { __typename login } body } } } } }"
done
query="query(\$owner: String!, \$name: String!) { repository(owner: \$owner, name: \$name) {$fields } }"

# A missing PR makes gh exit non-zero but still print partial data, so keep the
# output and let the null check below name the PR.
api_status=0
result=$(gh api graphql ${host:+--hostname "$host"} -f query="$query" -f owner="$owner" -f name="$name") || api_status=$?
if ! jq -e '.data.repository | type == "object"' <<<"$result" >/dev/null 2>&1; then
  echo "gh api graphql failed (auth, network, or a repository that does not exist)" >&2
  exit 2
fi
missing=$(jq -r '[.data.repository | to_entries[] | select(.value == null) | .key | ltrimstr("pr")] | map("#" + .) | join(", ")' <<<"$result")
if [[ -n "$missing" ]]; then
  echo "PR not found: $missing" >&2
  exit 2
fi
if [[ $api_status -ne 0 ]]; then
  echo "gh api graphql reported errors (exit $api_status)" >&2
  exit 2
fi

# A thread is open when it is unresolved, a bot wrote its first comment, and
# no non-bot comment follows the bot's newest comment.
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
    | ([range(0; $c | length) | select($c[.] | bot)] | max) as $last_bot
    | select($last_bot != null)
    | select([$c[$last_bot + 1:][] | select(bot | not)] | length == 0)
    | {pr: $pr.number, path, line: (.line // .originalLine // "file"), title: ($c[$last_bot] | title),
       url: $c[$last_bot].url, truncated: $more}]
' <<<"$result")

long_threads=$(jq -r '[.data.repository[] | select(any(.reviewThreads.nodes[]; .comments.pageInfo.hasNextPage)) | "#" + (.number | tostring)] | join(", ")' <<<"$result")
if [[ -n "$long_threads" ]]; then
  echo "a thread with more than 100 comments on $long_threads; only the oldest 100 were checked" >&2
  exit 2
fi

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
