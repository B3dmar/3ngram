---
"@3ngram/schema": minor
"@3ngram/core": minor
"@3ngram/server": minor
---

`review_proposals` reviews the forgetting pass's retention proposals (output V4; docs/concepts/forgetting-pass.mdx). The forgetting pass is now shipped, default off.

- **List:** a page grows a `retentionProposals` key only when there are some, and `counts`/`totals` gain a `retention` key. Each record carries the judged memory, the action (archive, supersede or conflict), the related memory, the probability, the judge model and the lifecycle. Dismissed verdicts (keeps and those below their threshold) are never listed. The list cursor's fingerprint now names the fourth kind, so a cursor issued before this release is rejected once as invalid input; start a fresh walk.
- **Accept:** the verdict is applied as the reviewer, in one transaction with the claim. Archive goes through the revise archive disposition, supersede adds a `supersedes` edge from the newer memory and closes the older one, and conflict records the review. A verdict that can no longer be applied returns a `conflict` error and leaves the proposal open. The answers are `applied_retention` and `rejected_retention`.
- **Unchanged:** the tool's input and description are unchanged, so the tool-selection embeddings are not regenerated.
- **Compatibility:** the change is additive. A client that reads V3 output keeps working, because the new keys are optional or extra and every V3 rule still holds. A client that rejects unknown keys in `counts` or `totals` must accept `retention`.
- **Export fix:** the REST data export (`GET /api/v1/export`) now includes `retentionProposals` and its count. The previous release added them to the db export and the OpenAPI contract but not to the route. A new test compares the route's top-level keys, counts and retention fields against the generated OpenAPI.
- **Core:** core exports `RetentionProposalRecord` and `RetentionProposalNotApplicableError`.
