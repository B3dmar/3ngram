---
'@3ngram/server': patch
---

mcp: describe the server to clients

The server now advertises `instructions` on `server/discover` — a short usage
policy telling the model to open with `briefing`, to search before asserting
something is unknown, that memory is append-only (use `revise`, never rewrite),
and that scope/project decide what later reads return. Previously the only
guidance an agent received was 11 individual tool descriptions with no
cross-tool framing.

Every tool now declares annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`), so a client can auto-approve a read like
`search` instead of prompting for it the same way it prompts for a write.
`destructiveHint` is `false` on every memory write, which is accurate:
supersession is append-only and never destroys memory data.
