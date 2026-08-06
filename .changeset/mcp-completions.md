---
'@3ngram/server': minor
---

mcp: complete scope names from the tenant's own facets

The server now declares the `completions` capability and answers
`completion/complete` for the `debrief` prompt's `scope` argument, offering the
tenant's real scope names filtered by what has been typed. Previously a client
had no way to discover them, so users typed scopes from memory and a typo
silently matched nothing.

It is an adapter over the existing `listMemoryFacets`, with the same guards the
REST facets route carries: the tenant comes from verified auth rather than the
request, `memory:read` is enforced fail-closed, and the access gate runs before
the read. A caller that may not read completes to an empty list rather than an
error.
