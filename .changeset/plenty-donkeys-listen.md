---
"@3ngram/server": patch
"@3ngram/core": patch
---

Remove the self-imposed MCP surface caps; a gated eval replaces them.

**`MAX_TOOLS = 12` and `MAX_PROMPTS = 2` are gone.** Both were 3ngram's own discipline, entered at the `v1.0.0` launch commit and sourced to nothing upstream — the specification defines no maximum tool count and paginates `tools/list`, and the pinned SDK enforces no limit. Neither constant was ever exported past its module and neither appears in the public API report, so there is no runtime or API change for any client: the server still registers exactly 11 tools and 2 prompts, with the same names, schemas, and annotations.

**What replaced them is a measurement of the thing they proxied for.** The `tool-selection` eval slice moved from report-only to gated: `selection_accuracy_at_1` (0.8545) and `selection_margin` (0.1097) are recorded as floors, and `max_description_overlap` (0.6737, `briefing` ~ `handoff`) as a ceiling — a metric where lower is better, so `eval/fixtures/floors.json` gained a `ceilings` block with its own comparison rather than storing an inverted floor. A twelfth tool is no longer blocked; a twelfth tool whose description reads like an existing one now fails a required check, and the failure names the offending pair. This is the sequencing `docs/concepts/mcp-surface.mdx` prescribed — re-set the cap last, and record the reasoning as description overlap and selection accuracy rather than a number inherited from launch day — except that nothing was re-set to a new number, because a fresh figure with no measurement under it would have reproduced the original mistake higher up.

`@3ngram/core` is included for a comment-only change: `write/archive.ts` justified its REST-only surface by citing hard rule 8 without its reason, which no longer reads correctly now that the rule is an evidence test rather than a count. No behavior changed in core.

**The docs generator no longer arbitrates the surface.** `generate-mcp-reference.ts` threw above both ceilings, which put the argument in the one place that cannot measure either metric; the generated `docs/reference/tools.mdx` and `prompts.mdx` now cite the eval instead. `AGENTS.md` hard rule 8 became an evidence test (JTBD, regenerated surface snapshot, eval scenarios) with its enforcement named, alongside every other hard rule.
