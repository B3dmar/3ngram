#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Merge readiness against the reviewer bots, for one or more PRs, in ONE
# GraphQL call. It checks two things per PR:
#
# 1. Unanswered bot review threads (Codex, CodeQL, any bot author). A thread
#    counts as answered once a comment by a non-bot author follows the bot's
#    newest comment, or once it is resolved.
# 2. Whether Codex reviewed the head commit. Codex keeps one summary comment
#    per PR (marker `<!-- codex-pull-request-review-summary -->`) whose table
#    names the commit it reviewed:
#      | 📝 **Code Review** | ✅ **Completed** <relative-time …> | `1b1d542` | PR opened |
#    The head is reviewed only when the newest such comment by the Codex bot
#    says Completed for a short SHA that prefixes the PR's head commit. Any
#    other status, a stale SHA or no summary at all means not reviewed. The
#    👍 reaction Codex leaves on a clean review is ignored: it names no commit
#    and survives later pushes.
#
# Run it after the last push, right before merging: the bots review every
# push, so a result taken earlier goes stale (AGENTS.md, Workflow).
#
#   scripts/pr-bot-status.sh 257 258      # one line per PR, then its open threads
#   scripts/pr-bot-status.sh --json 257   # the same, as JSON (shape below)
#   scripts/pr-bot-status.sh --self-test  # offline check of the parsing
#
# --json prints one object per PR:
#   [{pr, head, codex: {summary, status, commit, trigger, reviewed_head},
#     threads: [{pr, path, line, title, url}]}]
# Before the Codex check it printed only the thread array; nothing in this
# repo consumed it, and `jq '[.[].threads[]]'` reproduces it exactly.
#
# Exit 0: no open threads and Codex reviewed head on every PR. Exit 1: threads
# open, or Codex has not reviewed some head. Exit 2: usage, a failed API call
# (auth, network, a PR that does not exist), a PR with more than 100 review
# threads, a thread with more than 100 comments, or a PR with more than 100
# comments and no Codex summary among the newest 100: whatever was not
# fetched was not checked.
#
# Scope: inline review threads, which is where Codex and CodeQL put their
# findings, plus the Codex summary comment for the reviewed commit. Any other
# PR comment, a review body or a check annotation outside the diff is not
# seen. The repository is the current one, or GH_REPO=[HOST/]OWNER/REPO.
set -euo pipefail

# Shared by the report and the truncation check.
jq_defs='
  def bot: .author.__typename == "Bot" or ((.author.login // "") | test("\\[bot\\]$"));
  def codex_summary: .author.__typename == "Bot"
    and ((.author.login // "") | test("^chatgpt-codex-connector(\\[bot\\])?$"))
    and (.body | contains("<!-- codex-pull-request-review-summary -->"));
'

# GraphQL result (stdin) -> the per-PR report printed by --json.
build_report() {
  jq "$jq_defs"'
    def title: (.body | split("\n")[0]
      | gsub("\\*\\*<sub><sub>!\\[(?<p>P[0-9]) Badge\\]\\([^)]*\\)</sub></sub>\\s*"; "[\(.p)] ")
      | gsub("\\*\\*"; ""));
    def strip: sub("^\\s+"; "") | sub("\\s+$"; "");
    def code_review_row: first(.body | split("\n")[]
      | capture("^\\|[^|]*\\*\\*Code Review\\*\\*[^|]*\\|(?<status>[^|]*)\\|(?<commit>[^|]*)\\|(?<trigger>[^|]*)\\|")) // null;
    # A thread is open when it is unresolved, a bot wrote a comment in it, and
    # no non-bot comment follows the newest bot comment.
    def open_threads: .number as $n | .reviewThreads.nodes[]
      | select(.isResolved | not)
      | .comments.nodes as $c
      | ([range(0; $c | length) | select($c[.] | bot)] | max) as $last_bot
      | select($last_bot != null)
      | select([$c[$last_bot + 1:][] | select(bot | not)] | length == 0)
      | {pr: $n, path, line: (.line // .originalLine // "file"), title: ($c[$last_bot] | title),
         url: $c[$last_bot].url};
    [.data.repository[] | . as $pr
      | ([.comments.nodes[] | select(codex_summary)] | last) as $summary
      | (if $summary then $summary | code_review_row else null end) as $row
      | (if $row then $row.status | (capture("\\*\\*(?<s>[^*]+)\\*\\*").s // gsub("<[^>]*>"; "")) | strip
         else null end) as $status
      | (($row.commit // "" | capture("`(?<sha>[0-9a-f]{7,40})`").sha) // null) as $commit
      | {pr: .number, head: .headRefOid,
         codex: {summary: ($summary != null), status: $status, commit: $commit,
                 trigger: (if $row then $row.trigger | strip else null end),
                 reviewed_head: ($status == "Completed" and $commit != null
                                 and (.headRefOid | startswith($commit)))},
         threads: [$pr | open_threads]}]
  '
}

# Per-PR report (stdin) -> one verdict line per PR, then its open threads.
print_text() {
  jq -r '.[] | (.head[0:7]) as $h | .codex as $c
    | "#\(.pr): \(.threads | length) unanswered; " + (
        if $c.reviewed_head then "codex reviewed \($c.commit) (head)"
        elif $c.status == "Completed" then "codex reviewed \($c.commit // "?"), head is \($h) (NOT head)"
        elif ($c.summary | not) then "no codex summary, head is \($h) (NOT reviewed)"
        elif $c.status == null then "codex summary has no Code Review row, head is \($h) (NOT reviewed)"
        else "codex review \"\($c.status)\" at \($c.commit // "?"), head is \($h) (NOT reviewed)" end),
      (.threads[] | "  \(.title)\n    \(.path):\(.line)  \(.url)")'
}

# Per-PR report (stdin) -> success when every PR is ready to merge.
all_clear() {
  [[ $(jq '[.[] | select((.threads | length) > 0 or (.codex.reviewed_head | not))] | length') -eq 0 ]]
}

self_test() {
  local head=7c0c6df2d7622b935eaa96d32345a091ef124173 fixture report text fail=0
  fixture=$(jq -n --arg head "$head" '
    def codex($login; $type; $status; $sha): {author: {__typename: $type, login: $login},
      body: "<!-- codex-pull-request-review-summary -->\n\n## Codex Review Summary\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | \($status) <relative-time datetime=\"2026-10-12T10:28:19Z\">2026-10-12T10:28:19Z</relative-time> | `\($sha)` | New commits |\n"};
    def summary($status; $sha): codex("chatgpt-codex-connector"; "Bot"; $status; $sha);
    def pr($n; $comments; $threads): {number: $n, headRefOid: $head,
      comments: {pageInfo: {hasPreviousPage: false}, nodes: $comments},
      reviewThreads: {pageInfo: {hasNextPage: false}, nodes: $threads}};
    def note($type; $login; $body): {url: "https://x/\($login)", author: {__typename: $type, login: $login}, body: $body};
    {data: {repository: {
      pr1: pr(1; [summary("✅ **Completed**"; "7c0c6df")]; []),
      pr2: pr(2; [summary("✅ **Completed**"; "1b1d542")]; []),
      pr3: pr(3; [note("User"; "sebastianebg"; "lgtm")]; []),
      pr4: pr(4; [summary("⏳ **In progress**"; "7c0c6df")]; []),
      pr5: pr(5; [codex("chatgpt-codex-connector"; "User"; "✅ **Completed**"; "7c0c6df")]; []),
      pr6: pr(6; [summary("✅ **Completed**"; "7c0c6df"), summary("✅ **Completed**"; "1b1d542")]; []),
      pr7: pr(7; [summary("✅ **Completed**"; "7c0c6df")]; [
        {isResolved: false, path: "a.ts", line: 3, comments: {nodes: [
          note("Bot"; "chatgpt-codex-connector"; "**<sub><sub>![P1 Badge](b)</sub></sub> Guard the write**\nwhy")]}},
        {isResolved: false, path: "b.ts", line: 9, comments: {nodes: [
          note("Bot"; "chatgpt-codex-connector"; "**Old**"), note("User"; "sebastianebg"; "Fixed in abc")]}}])
    }}}')
  report=$(build_report <<<"$fixture")
  text=$(print_text <<<"$report")
  for want in \
    '#1: 0 unanswered; codex reviewed 7c0c6df (head)' \
    '#2: 0 unanswered; codex reviewed 1b1d542, head is 7c0c6df (NOT head)' \
    '#3: 0 unanswered; no codex summary, head is 7c0c6df (NOT reviewed)' \
    '#4: 0 unanswered; codex review "In progress" at 7c0c6df, head is 7c0c6df (NOT reviewed)' \
    '#5: 0 unanswered; no codex summary, head is 7c0c6df (NOT reviewed)' \
    '#6: 0 unanswered; codex reviewed 1b1d542, head is 7c0c6df (NOT head)' \
    '#7: 1 unanswered; codex reviewed 7c0c6df (head)' \
    '  [P1] Guard the write'; do
    grep -qxF -- "$want" <<<"$text" || { echo "SELF-TEST FAIL: no line: $want" >&2; fail=1; }
  done
  all_clear <<<"$(jq '[.[0]]' <<<"$report")" || { echo "SELF-TEST FAIL: #1 should be clear" >&2; fail=1; }
  for i in 1 2 3 4 5 6; do
    ! all_clear <<<"$(jq --argjson i "$i" '[.[$i]]' <<<"$report")" \
      || { echo "SELF-TEST FAIL: PR at index $i should not be clear" >&2; fail=1; }
  done
  [[ $(jq -c '[.[].threads[]] | map(keys)' <<<"$report") == '[["line","path","pr","title","url"]]' ]] \
    || { echo "SELF-TEST FAIL: thread objects changed shape" >&2; fail=1; }
  [[ $fail -eq 0 ]] || exit 1
  echo "pr-bot-status self-test: OK"
}

json=0
case "${1:-}" in
  --self-test) self_test; exit 0 ;;
  --json) json=1; shift ;;
esac
if [[ $# -eq 0 ]]; then
  echo "usage: $0 [--json] <pr-number>... | --self-test" >&2
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
  fields+=" pr$pr: pullRequest(number: $pr) { number headRefOid"
  fields+=" comments(last: 100) { pageInfo { hasPreviousPage } nodes { author { __typename login } body } }"
  fields+=" reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved path line originalLine"
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

# The summary is posted when the PR opens and edited in place, so a long PR
# can push it out of the newest 100 comments.
unseen=$(jq -r "$jq_defs"'[.data.repository[] | select(.comments.pageInfo.hasPreviousPage
  and all(.comments.nodes[]; codex_summary | not)) | "#" + (.number | tostring)] | join(", ")' <<<"$result")
if [[ -n "$unseen" ]]; then
  echo "more than 100 comments and no Codex summary among the newest 100 on $unseen" >&2
  exit 2
fi

report=$(build_report <<<"$result")
if [[ $json -eq 1 ]]; then
  jq . <<<"$report"
else
  print_text <<<"$report"
fi

all_clear <<<"$report"
