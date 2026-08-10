---
'@3ngram/schema': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

mcp: review extracted fact proposals alongside edge proposals

`review_proposals` now covers both kinds of proposal. Listing returns extracted
fact proposals next to consolidation ones, and accepting a fact proposal writes
the structured fact so `get_facts` can read it — nothing an extractor produced
becomes queryable truth without a person accepting it.

The input is unchanged: accept and reject still take just the proposal id.
Proposal ids are disjoint across the two tables, so the id alone identifies
which kind it is, and core probes the edge table first and the fact table only
when that reports not-found — a not-found reaches the caller only after both
miss. Any other failure propagates instead of being retried against the wrong
table.

Existing responses are untouched. The list result only grows a `factProposals`
key when there are some, so a tenant with only edge proposals sees the response
it always saw; decisions on a fact proposal answer with their own
`applied_fact` / `rejected_fact` variants rather than changing the payload under
the shipped `applied` / `rejected` literals. Accepting a fact proposal also
returns the id of the fact it wrote, so a reviewer does not need a second call
to find out what landed.

Listing bounds each kind by the same limit rather than splitting one budget, so
a burst of extracted facts cannot push edge proposals out of the review window.
