---
'@3ngram/schema': minor
'@3ngram/server': minor
---

mcp/rest: expose structured facts on remember

`remember` now accepts the measurable claims a memory states, on both
transports. Pass `facts` as subject/predicate/value triples and the response
returns a `factIds` array; `get_facts` can then read those claims back directly
instead of re-parsing prose.

Fact values are text, so the unit belongs in the predicate and each fact holds
one measure — subject `lift.back_squat`, predicate `top_set.weight_kg`, value
`98`, not a predicate `top_set` carrying `98kg x 3`. A later range read is only
comparable across entries if every writer follows that convention, so it is
stated in the tool description, the server instructions, and the data model doc.

Validity instants are ISO-8601 strings: an MCP server publishes its input schema
as JSON Schema, which has no date type. A `validTo` requires a `validFrom`, and
at most 16 facts ride one write.

`factIds` is present only when facts were written, so every existing response is
byte-identical and the V1 output schema still parses it. The V2 contracts are
composed beside the shipped ones rather than replacing them.
