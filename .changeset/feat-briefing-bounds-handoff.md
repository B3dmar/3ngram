---
"@3ngram/core": minor
"@3ngram/server": minor
---

Handoff bounds V2 (issue #45): core `handoff()` honours the caller-tunable `sectionLimit` (default 25, clamped to the server-side ceiling of 100) and stops discarding the exact window totals the briefing-read queries already compute — the envelope now carries `counts: {decisions, commitments, preferences}` plus per-section `truncated` flags (`counts.X > X.length`). The MCP `handoff` tool registers the composed V2 input/output schemas; a legacy `{selector, generatedFor?}` call returns the same lists as before plus the additive totals.
