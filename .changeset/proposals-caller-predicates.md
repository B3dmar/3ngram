---
"@3ngram/db": patch
"@3ngram/core": patch
---

Add caller-bound `user_id` predicates to the edge-consolidation proposal reads (list, reject and the per-status count) as a second tenant-isolation layer alongside RLS (defense in depth, issue #147), matching `proposals-apply` and the fact-proposal modules. `listProposals`, `rejectProposal` and `countProposalsByStatus` in `@3ngram/db` take the caller's `userId` after `tx`; the `@3ngram/core` functions are unchanged. Result sets are unchanged while RLS functions.
