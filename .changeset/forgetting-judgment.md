---
"@3ngram/db": minor
"@3ngram/core": patch
---

Add the forgetting pass's judgment step (docs/concepts/forgetting-pass.mdx, "Judgment"). Nothing runs it yet: the pass ships later, default off.

- **Core:** turns candidates into items (pairs first, a single in a pair judged once, a stale blocker only with newer neighbours). It renders batched `decide()` requests of at most 12 items and 48k characters, with all memory text in one fenced data block and questions that name items by positional ref only. It maps choice answers back to retention verdicts at the starting thresholds (0.85 archive and supersede, 0.6 conflict).
- **db:** `RetentionVerdictWrite` gains an optional `dismissed` flag. A verdict below its threshold is stored dismissed with its real action, so calibration keeps it and the pass does not judge an uncertain memory again every day.
- **Shared helpers:** the closer's fencing helper is split into `fenceJson` and `jsonLiteral`, now shared by both passes. The closer's behaviour is unchanged.
