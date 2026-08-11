---
"@3ngram/db": minor
"@3ngram/schema": minor
"@3ngram/server": minor
---

`get_facts` gains a `range: {from?, to?}` window for chronological time-series reads over the bi-temporal facts table, on both the MCP tool and REST `GET /api/v1/facts`.

`range` replaces (never appends to) the default live-only predicate with a half-open `[from, to)` valid-time overlap: a fact whose validity window overlaps the requested range is returned, including generations superseded inside it — the point of a time-series read over "what's currently true." Ordering flips to `valid_from ASC` (chronological) instead of the default `recorded_at DESC` (recency); `range` and `asOf` are mutually exclusive point-in-time vs. window modes, enforced at the schema boundary (empty range object rejected, mirroring `asOfSchema`; an inverted `from`/`to` range rejected rather than silently returning empty, per issue #58's REST/MCP parity precedent). Each bound is also capped at millisecond precision (issue #58 item 2's fix, applied here too): `valid_from`/`valid_to` are microsecond-precise in Postgres, so a sub-millisecond bound would silently truncate up to the next whole millisecond and let an already-ended generation leak into the window. The existing `DEFAULT_FACTS_LIMIT`/`MAX_FACTS_LIMIT` bounds still apply in range mode.

Every returned fact now also carries `recordedAt` (transaction time) — an additive, output-only widening useful for telling apart same-window generations recorded at different instants.

Deliberately out of scope: a `valid_from` index (the sort is accepted at current volumes) and a scope axis on `get_facts` (the facts table has no scope column — continuing issue #47's open item). The SDK `getFacts` client and the CLI `facts` command do not yet expose the `from`/`to` range axis (REST/MCP only for now); follow-up planned.
