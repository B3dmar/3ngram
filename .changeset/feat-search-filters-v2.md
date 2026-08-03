---
"@3ngram/schema": minor
"@3ngram/db": minor
"@3ngram/core": minor
"@3ngram/server": minor
---

Search filters V2 (issue #48, layer 1 of 2): the MCP `search` tool accepts two new candidate-narrowing filter axes — `memoryTypes` (an OR-set of memory types, 1–8 entries, mutually exclusive with the scalar `memoryType`) and `recordedAfter`/`recordedBefore` (an inclusive transaction-time range on `recorded_at` that narrows the live view WITHOUT lifting the active-only default — unlike `asOf`, it is not time travel). New composed `searchFiltersV2Schema`/`searchQueryV2Schema` in `@3ngram/schema` (the shipped V1 schemas are untouched); the db `rowEligibility` predicate gains `memory_type = ANY(...)` and `recorded_at >=/<=` branches spliced identically into every fusion leg (leg parity preserved); core threads the filters through unchanged. Fusion weights and ranking are untouched — filters narrow candidates pre-fusion only.
