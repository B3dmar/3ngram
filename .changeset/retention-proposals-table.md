---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
---

Add the `retention_proposals` table, the first step of the forgetting pass (docs/concepts/forgetting-pass.mdx). Nothing writes it yet: the pass that stages verdicts ships later, default off.

- **The table (migration 0045):** one row per judged memory and action (`keep`, `archive`, `supersede` or `conflict`), with the related memory for supersede and conflict (never the memory itself), the chosen probability, the full choice distribution and the judge model. It has RLS and FORCE RLS, tenant-composite foreign keys to `memories`, one open proposal per memory and action, and a runtime grant of SELECT, INSERT and UPDATE with no DELETE. It holds no user text, so account erasure leaves it alone.
- **Staging:** `@3ngram/db` adds `insertRetentionProposals`, which stages a verdict only while every memory it names is live, locking those rows against a concurrent revise or archive. A keep verdict is stored `dismissed` and is never listed. A probabilities key must be an action name or item ref, so no text reaches the table.
- **Schema:** `@3ngram/schema` adds `retentionActionSchema`, `retentionProposalStatusSchema` and `RETENTION_ACTIONS_WITH_RELATED`. The table's CHECKs are generated from them.
- **Export:** the data export gains a `retentionProposals` array.

Self-hosters need the usual migration step and a re-run of `provision-roles.sql` for the new grant.
