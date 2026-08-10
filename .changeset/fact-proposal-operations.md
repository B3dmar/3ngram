---
'@3ngram/db': minor
---

db: review operations for staged fact proposals

Adds the insert, list, reject and apply steps for `fact_proposals`, so an
extracted candidate can be staged, reviewed, and either turned into a real fact
or turned down — with the row surviving either way as its own audit trail.

Re-running an extractor over the same memory is a no-op: the insert skips a
triple that already has an open proposal, and repeated extractions collapse to
the first one, since the idempotency key deliberately ignores confidence,
memory type and the validity window. A rejected proposal does not block
re-proposing the same claim later.

Applying flips the status first, with the transition guarded on the row still
being open, so a concurrent double-apply loses the race rather than writing the
fact twice; the flip and the fact insert share one transaction. A proposal
carrying no `valid_from` — an extractor often cannot date a claim — lets the
fact take its own default, so it becomes true when it was accepted. Applying
against a source memory that has since been superseded is allowed: a fact
carries its own validity and stands on its own once asserted, and the reviewer
accepted the claim rather than the prose version.
