---
'@3ngram/schema': minor
'@3ngram/db': minor
'@3ngram/core': minor
'@3ngram/server': minor
---

Complete, read-only pagination for proposal review (#320). The MCP `review_proposals` list and REST `GET /api/v1/proposals` take an optional opaque `cursor` and return `hasMore`, `nextCursor` (present exactly when `hasMore`), and live `totals` matching the status filter; the MCP list also returns per-kind `counts` for the page. The MCP list walks edge and fact proposals as one merged `created_at DESC, id DESC` stream (the id breaks ties, including same-transaction batches), so neither kind is starved and `limit` now bounds a page across both kinds; REST keeps walking edge proposals only. `count` keeps its shipped meaning (edge proposals on this page, never a total). Cursors are bound to the surface, the status filter and the tenant: a garbled cursor, or one replayed under another filter, by another tenant, or on the other surface, is rejected as invalid input. Listing runs in a read-only, repeatable-read transaction; mid-walk decisions and new proposals never cause a duplicate or a skip (see docs/concepts/memory-model.mdx).
