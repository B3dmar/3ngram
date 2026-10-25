---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
---

Add resolution proposals, the session closer's mid band (issue #229). On the typed-judgment path, a briefed commitment judged plausibly completed (0.5 ≤ p < 0.9) is staged in the new `resolution_proposals` table instead of being resolved. The table (migration 0043) has RLS and FORCE RLS, holds one open proposal per commitment, has tenant-composite foreign keys to the memory and the session run, and is included in the export. `review_proposals` lists the new kind (output V3): `resolutionProposals` appears only when it is non-empty, `counts`/`totals` gain a `resolution` key, and accept/reject return `applied_resolution`/`rejected_resolution`. Accepting claims the proposal and then resolves the commitment through the shipped FSM-checked transition, recorded as the reviewer. A refused transition reopens the proposal. Only still-open commitments are staged, at most once per run. The input and the tool description are unchanged. Self-hosters need the usual migration step.

Compatibility notes. MCP `review_proposals` cursors issued before this release are rejected as invalid input once, because the walk now binds the third kind. Restart such a walk from page 1. A client that strict-parses the V2 output, or switches exhaustively on `action`, has to admit the new `resolution` count key and the two new action literals.
