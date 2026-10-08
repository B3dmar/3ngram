# GitHub fixtures

Responses captured from the real `gh api --method GET repos/B3dmar/3ngram/issues/<n>` on 2026-10-07, trimmed to the fields `commitments_github.go` reads (a plain issue has no `pull_request` key at all, as on the real endpoint) (`number`, `title`, `state`, `state_reason`, `closed_at`, `html_url`, `pull_request.merged_at`, `pull_request.html_url`). File names are the API path with `/` replaced by `_`, which is how the fake `gh` in `commitments_github_test.go` finds them.

- `251`: a merged pull request
- `244`: an open pull request
- `255`: an open issue
- `233`: a closed issue
