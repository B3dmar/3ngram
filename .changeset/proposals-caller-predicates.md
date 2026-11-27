---
"@3ngram/db": minor
"@3ngram/core": patch
---

Add caller-bound `user_id` predicates to the edge-consolidation proposal reads (list, reject and the per-status count) as a second tenant-isolation layer alongside RLS (defense in depth, issue #147), matching `proposals-apply` and the fact-proposal modules. Result sets are unchanged while RLS functions.

Breaking for direct `@3ngram/db` consumers: `listProposals`, `rejectProposal` and `countProposalsByStatus` now take the caller's `userId` after `tx` (`listProposals(tx, userId, query)`, `rejectProposal(tx, userId, proposalId)`, `countProposalsByStatus(tx, userId)`). Pass the same id the transaction's `withTenant()` was opened with. The `@3ngram/core` functions are unchanged.
