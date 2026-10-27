---
"@3ngram/db": minor
---

Add the db side of reviewing the forgetting pass's retention proposals (docs/concepts/forgetting-pass.mdx). Nothing calls it yet: `review_proposals` gains the retention kind in the next release step.

- **`listRetentionProposalsAfter` and `countRetentionProposals`** page and count reviewable proposals in the shared keyset order. Dismissed rows, the keep verdicts and those below their threshold, are never listed or counted.
- **`decideRetentionProposal`** is a compare-and-set from `proposed` to `applied` or `rejected`.
- **`acceptRetentionProposal`** claims the proposal and applies its verdict in the same transaction, as the reviewer. An archive goes through the revise archive disposition with its audit event. A supersede adds a `supersedes` edge from the newer memory to the older one and closes the older one, exactly as an edge proposal does. As with any predecessor close, an open commitment on the older memory moves to the newer one or is resolved. An older memory that is no longer live is refused. A conflict records the review only. A refused verdict throws `RetentionProposalNotApplicableError` or the edge path's own error, and the whole transaction rolls back, so the proposal stays open. Accept locks the judged memory before it claims the proposal, in the same order staging takes them, so the two cannot deadlock.
- **Shared edge path:** the edge-materializing half of `applyProposal` moves into an internal `materializeEdgeIn`, so edge proposals and retention proposals close a predecessor through one code path. Edge-proposal behaviour is unchanged.
