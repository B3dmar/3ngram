# Golden-set eval

> **Public fixture notice:** the committed golden set was anonymized for public
> release and manually reviewed by the project owner. Names, organizations,
> domains, contact details, repositories, identifiers, and commercial figures in
> these fixtures are synthetic or substituted; they are not operational contact
> details or production endpoints.

**Blocking gate** (`pnpm --filter @3ngram/eval run gate`, CI `eval-gate` job): deterministic, zero-dependency, no network — pure exact-cosine retrieval over committed cached embeddings. Exact cosine is the retrieval upper bound; HNSW-approximation parity (incl. the filtered/distractor scenario) is proven by `packages/db/test/integration/hnsw-parity.int.test.ts`. The DB-level tenant-isolation slice lives in the `test` job's `ci-smoke-app.sql` (real RLS, runtime role).

## Slices (fixtures/queries.json — queries over anonymized production memories)

| Slice | n | Measures |
|---|---|---|
| retrieval | 69 | recall@5, MRR@5 — self-labeled (query generated from its memory) |
| supersession | 19 | successor ranks above its superseded predecessor with superseded rows *included* — proves ranking, not just filtering (real `replaces` pairs from anonymized production memories) |
| abstention | 10 | top-1 similarity below calibrated τ for verifiably-absent topics |

## Floors (fixtures/floors.json)

Recorded from the first run as an empirical ratchet: floors only move up (`record-floors` in a PR, with a week of stability). A run below any floor exits 1 → `eval-gate` fails → no merge.

## Embedding model

`text-embedding-3-large` @ `dimensions: 1536`. Same storage as 3-small, better on every metric that differed.

## Advisory tier (non-blocking)

`pnpm --filter @3ngram/eval run advisory` (`src/longmemeval.mjs`) runs the **advisory** LongMemEval slice. It is deterministic, zero-dep and offline like the gate, but it **never blocks a PR** — it runs only in `eval-nightly.yml` (scheduled), which opens/updates a tracking issue on regression and closes it on green.

Slice 1 (shipped): a LongMemEval-S-shaped subset (`fixtures/longmemeval-s-subset.json`, synthetic + license-clean) scored by a deterministic lexical (token-overlap) retrieval-oracle — `session_recall@k` / `session_mrr` over `answer_session_ids` gold labels. The lexical ranker (`lib.rankSessions`) is the **default** and the only path PR-lane unit tests touch — it stays network/DB/model-free.

Opt-in slices (never in the default path):

- `--retriever real` (or `EVAL_RETRIEVER=real`) — the **real Phase-1B retriever** (see below).
- `--download` — streams the full 500q LongMemEval-S haystack into a gitignored cache (large + upstream license; not committed).
- `--judge` — model-judged answer-synthesis slice (needs an API key; never a silent network dependency).

### Real-retriever mode (`--retriever real`)

`pnpm --filter @3ngram/eval run advisory:real` (or `node src/longmemeval.mjs --retriever real`) swaps the lexical stand-in for the **product retrieval path** (`retriever.mjs`):

1. Per question, a **disposable tenant** (fresh user) is created. The nightly Neon branch is ephemeral (created per run, deleted at job end), so questions stay isolated and re-runs are idempotent with no destructive cleanup on a write path (hard rule 1).
2. Each haystack session is seeded as memory via the product write path — `core.remember(..., { gateway })`, which lands the embedding through embed-on-write using the real `@3ngram/llm` `createOpenAIGateway`. A session whose text fits the `rememberInputSchema` content cap (`MAX_CONTENT_LENGTH` = 2000) becomes **one** memory; a longer session is **chunked at the cap** and the session ranks by its **best chunk**.
3. The question is embedded via the same gateway and `core.search()` runs the product fusion (`{fts:0.2, recency:0, vector:1}`); sessions rank by their best-scoring memory hit.

Real mode requires the built workspace (`pnpm build`) plus a DB and an embedding gateway. It is the **nightly advisory lane only** and **skips cleanly** (clear log, exit 0) when a prerequisite is absent — never a silent dependency.

#### Skip conditions (real mode)

| Condition | Behaviour |
|---|---|
| `DATABASE_URL` unset | `--retriever real` logs the reason and exits 0 (no DB). |
| `LLM_GATEWAY_API_KEY` unset | `--retriever real` logs the reason and exits 0 (no embedding gateway). |
| Nightly: Neon (`NEON_PROJECT_ID`/`NEON_API_KEY`/`APP_USER_PASSWORD`) **or** `LLM_GATEWAY_API_KEY` unset | The whole real-retriever block in `eval-nightly.yml` skips (preflight gate); the run stays green. |
| `LLM_GATEWAY_URL` unset | Falls back to `https://api.openai.com/v1` (empty string treated as unset). |
| Default / `--retriever lexical` | Pure lexical oracle; no DB, network, or workspace build. |

Remaining work: measure live-slice stability ≥4 weeks before any blocking consideration.

### MemoryAgentBench subsets (`src/memoryagentbench.mjs`)

`pnpm --filter @3ngram/eval run advisory:mab` (or `node src/memoryagentbench.mjs`) runs the **second** advisory benchmark: the two MemoryAgentBench (MAB) subsets — **Conflict Resolution** (detect + overwrite outdated facts so only the newest valid value is returned) and **Test-Time Learning** (ingest a user-supplied rule/label mid-dialogue, then apply it). It is advisory-only and wired into `eval-nightly.yml` (slice 5); it **never blocks a PR** (≥4 weeks of stability before any blocking promotion).

The MAB metric **shape differs** from LongMemEval: it is **accuracy-over-turns** (per question, did the agent answer correctly after ingesting the haystack turns), **not** `session_recall@k` / `MRR`. The harness emits a distinct per-run JSON metrics shape — overall `accuracy` plus per-subset accuracy under `by_subset` (`conflict-resolution` / `test-time-learning`) — never the LongMemEval oracle output.

Default path (the only path PR-lane unit tests touch) is a deterministic, zero-dep, offline accuracy oracle over `fixtures/memoryagentbench-subset.json` (synthetic + license-clean): it ranks haystack sessions by lexical token-overlap (`lib.rankSessions`, shared with the LongMemEval oracle), then breaks ties by **recency** (newest `session_date` first — the Conflict Resolution semantic: an old and new session can match equally on tokens, so the agent must return the *newest* value), extracts the predicted answer from the top session's `has_answer` turns, and scores a hit iff the gold answer is contained there. Swap `lib.rankSessions` for the real Phase-1B retriever when it lands — identical to the LongMemEval lane.

Opt-in `--download` slice: streams the **official MIT-licensed** upstream subsets (`ai-hyz/MemoryAgentBench` on HuggingFace — `Conflict_Resolution` + `Test_Time_Learning` parquet) into the gitignored cache, **pinning** `url` + `sha256` + `bytes` per subset (same empty-string-safe env-override contract as the LongMemEval lane; overridable via `MAB_<SUBSET>_URL` / `_SHA256` / `_BYTES`).

> **Deferred (no dependency added this batch):** parquet **decoding** of the downloaded subsets. The single lockfile slot was owned by another track, so no parquet-reader dependency was added. The `--download` lane therefore verifies pinned integrity (url/sha256/bytes) and reports a content-free result, but does **not** yet run the oracle over the decoded official rows — the default offline lane uses the synthetic fixture. Wiring the decode (vendored or zero-dep reader) is a follow-up.

## Regenerating fixtures (`pipeline/`)

Manual, network-using, in order: export (psql from the production database) → `anonymize.mjs` (Claude Haiku; PII scan after) → `gen-queries.mjs` → `embed.mjs openai-large-1536`. Regeneration invalidates floors — re-record and justify in the PR.
